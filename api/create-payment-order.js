import { dbPut, randomId, resolvePaidSelection, isValidEmail, publicError, sendJson } from '../server/commerce.js';

// FamGateway (https://famgateway.in) — zero-fee P2P UPI gateway.
// Same contract as the proven KITY SHOP bot integration: the API key is sent
// in the X-Api-Key header and orders are created against /api/create-order.
async function createFamOrder(apiKey, amountInr, customerName) {
  const payload = { amount: Number(amountInr) };
  if (customerName) payload.customer_name = String(customerName).slice(0, 60);
  const response = await fetch('https://famgateway.in/api/create-order', {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  const data = result && typeof result.data === 'object' ? result.data : null;
  if (result?.status === 'success' && data?.order_id) return data;
  const detail = JSON.stringify(result).slice(0, 300);
  throw new Error(`FamGateway order creation failed: ${detail}`);
}

export default async function handler(request, response) {
  // The Android Capacitor WebView runs at https://localhost, while the secure
  // API lives on Vercel. Permit its JSON POST request without exposing secrets.
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') return response.status(204).end();
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
  try {
    const body = request.body || {};
    if (!isValidEmail(body.customerEmail)) return sendJson(response, 400, { error: 'Enter a valid email address to receive the license key.' });

    const selection = await resolvePaidSelection(body);
    const gateway = body.gateway === 'famgateway' ? 'famgateway' : 'razorpay';

    if (gateway === 'famgateway') {
      const famApiKey = selection.famGatewayApiKey;
      if (!famApiKey) {
        return sendJson(response, 503, { error: 'FamGateway UPI payment is not configured yet. Please use Razorpay or contact the store owner.' });
      }
      const famOrder = await createFamOrder(famApiKey, selection.finalAmount, body.customerEmail);
      // Firebase keys cannot contain . $ # [ ] / — sanitise the gateway's order id.
      const sessionKey = String(famOrder.order_id).replace(/[.$#[\]/]/g, '_');
      const session = {
        ...selection,
        customerEmail: String(body.customerEmail).trim().toLowerCase(),
        gateway: 'famgateway',
        famOrderId: famOrder.order_id,
        status: 'created',
        createdAt: Date.now(),
      };
      await dbPut(`apiCheckoutSessions/${sessionKey}`, session);
      return sendJson(response, 200, {
        gateway: 'famgateway',
        famOrderId: famOrder.order_id,
        amount: Number(famOrder.amount) || Math.round(selection.finalAmount * 100),
        displayAmount: selection.finalAmount,
        qrUrl: famOrder.qr_url || '',
        checkoutUrl: famOrder.checkout_url || '',
        upiIntent: famOrder.upi_intent || '',
        upiId: famOrder.upi_id || '',
        expiresAt: famOrder.expires_at_ist || '',
      });
    }

    const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
    if (!selection.razorpayKeyId || !keySecret) {
      return sendJson(response, 503, { error: 'Secure Razorpay checkout is not configured. Ask the store owner to add RAZORPAY_KEY_SECRET in Vercel.' });
    }

    const receipt = randomId('pk_').slice(0, 40);
    const razorpayResponse = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${selection.razorpayKeyId}:${keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount: Math.round(selection.finalAmount * 100), currency: 'INR', receipt, notes: { source: 'peakesp-auto-api', product: selection.productName, quantity: String(selection.quantity), keyType: selection.keyType } }),
    });
    const razorpayOrder = await razorpayResponse.json();
    if (!razorpayResponse.ok || !razorpayOrder?.id) throw new Error('Razorpay could not create a secure payment order.');

    const session = {
      ...selection,
      customerEmail: String(body.customerEmail).trim().toLowerCase(),
      gateway: 'razorpay',
      razorpayOrderId: razorpayOrder.id,
      receipt,
      status: 'created',
      createdAt: Date.now(),
    };
    await dbPut(`apiCheckoutSessions/${razorpayOrder.id}`, session);
    return sendJson(response, 200, { gateway: 'razorpay', orderId: razorpayOrder.id, amount: razorpayOrder.amount, currency: 'INR', keyId: selection.razorpayKeyId, displayAmount: selection.finalAmount });
  } catch (error) {
    console.error('Create payment order failed:', error?.message);
    return sendJson(response, 400, { error: publicError(error, 'Unable to start secure payment. Please try again.') });
  }
}
