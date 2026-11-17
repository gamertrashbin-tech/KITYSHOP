import crypto from 'node:crypto';
import { dbGetWithEtag, dbPut, dbPatch, dbPost, publicError, sendJson } from '../server/commerce.js';

const FAM_SUCCESS_STATUSES = ['success', 'paid', 'captured', 'completed', 'approved'];

async function claimForIssuing(sessionKey) {
  const result = await dbGetWithEtag(`apiCheckoutSessions/${sessionKey}`);
  const session = result.value;
  if (!session) throw new Error('The payment session was not found.');
  if (session.status === 'fulfilled') return { state: 'fulfilled', session };
  if (session.status === 'issuing') return { state: 'issuing', session };
  if (session.status !== 'created') return { state: 'review', session };
  const next = { ...session, status: 'issuing', issuingAt: Date.now() };
  try {
    await dbPut(`apiCheckoutSessions/${sessionKey}`, next, { 'if-match': result.headers.get('etag') || '*' });
    return { state: 'claimed', session: next };
  } catch {
    return { state: 'issuing', session: next };
  }
}

// Shared key delivery: calls the provider API for keys, stores the order and
// payment, and marks the checkout session fulfilled. Used by both the
// Razorpay signature path and the FamGateway server-side verification path.
async function deliverKeysForSession(response, claimed, sessionKey, gateway, paymentId, extraPaymentFields = {}) {
  if (claimed.state === 'fulfilled') return sendJson(response, 200, { order: claimed.session.order });
  if (claimed.state === 'issuing') return sendJson(response, 409, { error: 'Your payment is already being delivered. Do not pay again; contact support if the key does not appear shortly.' });
  if (claimed.state === 'review') return sendJson(response, 409, { error: 'This paid order needs a manual review. Please contact support with your payment ID.' });
  const session = claimed.session;

  // AIMX_BOT_API_TOKEN is the documented name. BOT_API_KEY is accepted as
  // a compatibility name for an already-configured Vercel project.
  const token = String(process.env.AIMX_BOT_API_TOKEN || process.env.BOT_API_KEY || '').trim();
  if (!token) throw new Error('Bot API token is not configured.');
  const providerResponse = await fetch(process.env.AIMX_BOT_API_URL || 'https://aimx.live/api/v1/bot/keys', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ game: session.game, max_devices: session.maxDevices, duration: session.requestedDuration, quantity: session.quantity, type: session.keyType }),
  });
  const provider = await providerResponse.json().catch(() => ({}));
  const keys = Array.isArray(provider?.keys) ? provider.keys.map(item => String(item?.user_key || '').trim()).filter(Boolean) : [];
  if (!providerResponse.ok || provider?.success !== true || keys.length !== Number(session.quantity)) {
    await dbPatch(`apiCheckoutSessions/${sessionKey}`, { status: 'needs_review', providerStatus: providerResponse.status, providerMessage: String(provider?.message || provider?.error || 'Provider did not return the requested keys.'), reviewedAt: null });
    return sendJson(response, 502, { error: 'Payment was verified, but key delivery needs a manual review. Please contact support with your payment ID. Do not pay again.' });
  }

  const orderId = `ORD-${Math.floor(100000 + Math.random() * 900000)}`;
  const order = {
    orderId,
    productId: session.productId,
    productName: session.productName,
    durationId: session.durationId,
    durationName: session.durationName,
    originalPrice: session.originalPrice,
    discountAmount: session.discountAmount,
    finalAmount: session.finalAmount,
    couponCode: session.coupon?.code || null,
    licenseKey: keys[0],
    licenseKeys: keys,
    keyType: session.keyType,
    keyQuantity: session.quantity,
    maxDevices: session.maxDevices,
    deliverySource: 'aimx-api',
    paymentId,
    status: 'paid',
    customerEmail: session.customerEmail,
    ...(session.emailDeliveryEnabled ? { emailDeliveryStatus: 'pending' } : {}),
    createdAt: Date.now(),
  };
  const storedOrder = await dbPost('orders', order);
  const finalOrder = { ...order, id: storedOrder?.name || '' };
  await dbPost('payments', { orderId, paymentId, amount: session.finalAmount, gateway, status: 'success', ...extraPaymentFields, createdAt: Date.now() });
  if (session.coupon?.id) await dbPatch(`coupons/${session.coupon.id}`, { usageCount: Number(session.coupon.usageCount || 0) + 1 });
  await dbPatch(`apiCheckoutSessions/${sessionKey}`, { status: 'fulfilled', fulfilledAt: Date.now(), paymentId, order: finalOrder, providerQuotaRemaining: provider.remaining_quota ?? null });
  return sendJson(response, 200, { order: finalOrder });
}

// FamGateway authoritative server-to-server check (same contract as the
// proven KITY SHOP bot integration): /api/verify-order.php with X-Api-Key.
// The response can be flat {status, utr} or nested {status, data:{utr, amount}}.
async function verifyFamPayment(response, famOrderId) {
  const sessionKey = famOrderId.replace(/[.$#[\]/]/g, '_');
  const sessionResult = await dbGetWithEtag(`apiCheckoutSessions/${sessionKey}`);
  const session = sessionResult.value;
  if (!session || session.gateway !== 'famgateway') throw new Error('The payment session was not found.');
  if (session.status === 'fulfilled') return sendJson(response, 200, { order: session.order });
  if (session.status !== 'created') {
    return sendJson(response, 409, { error: 'Your payment is already being processed. Do not pay again; contact support if the key does not appear shortly.' });
  }
  if (!session.famGatewayApiKey) throw new Error('FamGateway is not configured for this session.');

  const famResponse = await fetch(`https://famgateway.in/api/verify-order.php?order_id=${encodeURIComponent(famOrderId)}`, {
    headers: { 'X-Api-Key': session.famGatewayApiKey },
  });
  if (famResponse.status === 401 || famResponse.status === 403) {
    await dbPatch(`apiCheckoutSessions/${sessionKey}`, { status: 'needs_review', reviewReason: 'FamGateway rejected the stored API key', reviewUpdatedAt: Date.now() });
    return sendJson(response, 502, { error: 'Payment verification is temporarily failing on our side. Please contact support with your payment ID. Do not pay again.' });
  }
  const fam = await famResponse.json().catch(() => ({}));
  const data = fam && typeof fam.data === 'object' ? fam.data : fam;
  const status = String(data?.status || fam?.status || '').toLowerCase();
  if (!FAM_SUCCESS_STATUSES.includes(status)) {
    // Not paid yet (or failed) — the storefront keeps polling until expiry.
    return sendJson(response, 202, { pending: true, status: status || 'pending' });
  }

  const paidAmount = Number(data?.amount ?? data?.payable_amount ?? fam?.amount ?? 0);
  if (Number.isFinite(paidAmount) && paidAmount > 0 && Math.abs(paidAmount - Number(session.finalAmount)) > 1) {
    await dbPatch(`apiCheckoutSessions/${sessionKey}`, { status: 'needs_review', reviewReason: `Amount mismatch: expected ${session.finalAmount}, got ${paidAmount}`, reviewUpdatedAt: Date.now() });
    return sendJson(response, 409, { error: 'Your payment needs a manual review. Please contact support with your payment ID. Do not pay again.' });
  }

  const paymentId = String(data?.transaction_id || data?.utr || fam?.transaction_id || fam?.utr || `FAM-${famOrderId}`);
  const claimed = await claimForIssuing(sessionKey);
  return deliverKeysForSession(response, claimed, sessionKey, 'famgateway', paymentId, { famOrderId });
}

export default async function handler(request, response) {
  // See create-payment-order: this allows the Android WebView to call the
  // Vercel endpoint. Razorpay signature verification still protects delivery.
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') return response.status(204).end();
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
  const body = request.body || {};
  const famOrderId = String(body.famOrderId || '').trim();
  if (famOrderId) {
    try {
      return await verifyFamPayment(response, famOrderId);
    } catch (error) {
      console.error('FamGateway verification failed:', error?.message);
      return sendJson(response, 500, { error: publicError(error, 'Payment verification failed. Please contact support with your payment ID. Do not pay again.') });
    }
  }

  const razorpayOrderId = String(body.razorpay_order_id || '').trim();
  const razorpayPaymentId = String(body.razorpay_payment_id || '').trim();
  const signature = String(body.razorpay_signature || '').trim();
  if (!razorpayOrderId || !razorpayPaymentId || !signature) return sendJson(response, 400, { error: 'Payment verification details are missing.' });

  try {
    const secret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
    const expected = crypto.createHmac('sha256', secret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
    if (!secret || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return sendJson(response, 400, { error: 'Payment signature verification failed.' });

    const claimed = await claimForIssuing(razorpayOrderId);
    return await deliverKeysForSession(response, claimed, razorpayOrderId, 'razorpay', razorpayPaymentId);
  } catch (error) {
    console.error('Verify and issue failed:', error?.message);
    if (razorpayOrderId) {
      try { await dbPatch(`apiCheckoutSessions/${razorpayOrderId}`, { status: 'needs_review', reviewReason: 'Unexpected delivery error', reviewUpdatedAt: Date.now() }); } catch { /* Preserve the original error. */ }
    }
    return sendJson(response, 500, { error: publicError(error, 'Payment was received but key delivery needs a manual review. Please contact support with your payment ID. Do not pay again.') });
  }
}
