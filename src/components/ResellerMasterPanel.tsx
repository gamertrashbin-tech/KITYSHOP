import { type ButtonHTMLAttributes, type FormEvent, type InputHTMLAttributes, type ReactNode, useEffect, useMemo, useState } from 'react';
import { onValue, push, ref, remove, set, update } from 'firebase/database';
import { BarChart3, CheckCircle2, ChevronRight, Code2, CreditCard, Plus, ReceiptIndianRupee, Save, Store, Users, WalletCards, X } from 'lucide-react';
import { db } from '../lib/firebase';

const ROOT = 'brands/online-shop';
const databaseRef = (path = '') => ref(db, `${ROOT}${path ? `/${path.replace(/^\/+|\/+$/g, '')}` : ''}`);
const storeCode = (value: string) => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);

function list<T extends { id?: string }>(data: Record<string, Omit<T, 'id'>> | null | undefined): T[] {
  return Object.entries(data || {}).map(([id, value]) => ({ ...(value as object), id }) as T);
}

const money = (value: number | undefined) => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 2
}).format(Number(value || 0));

type Reseller = { id: string; username: string; password: string; storeCode: string; storeName: string; active?: boolean; adminPaidAmount?: number };
type Product = { id: string; name: string; enabled?: boolean };
type Duration = { id: string; productId: string; name: string; unit: string };
type ApiConfig = { id: string; enabled?: boolean; game?: string; apiDuration?: string; maxDevices?: number };
type Order = { id: string; finalAmount?: number };
type ResellerSalesSummary = { sales: number; orderCount: number };

function Card({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`rounded-3xl border border-slate-800 bg-slate-900/80 ${className}`}>{children}</section>; }
function Button({ children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props} className={`inline-flex items-center justify-center gap-2 rounded-xl bg-violet-500 px-4 py-2.5 text-xs font-black text-white transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}>{children}</button>; }
function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className={`w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-600 focus:border-violet-400 ${props.className || ''}`} />; }
function Label({ children }: { children: ReactNode }) { return <label className="mb-1 block text-[10px] font-black uppercase tracking-[.13em] text-slate-500">{children}</label>; }
function Stat({ label, value, icon }: { label: string; value: string; icon: ReactNode }) { return <Card className="p-4"><div className="flex items-center justify-between text-violet-300"><span className="text-[10px] font-black uppercase tracking-[.12em]">{label}</span>{icon}</div><p className="mt-2 text-xl font-black text-white">{value}</p></Card>; }

export function ResellerMasterPanel() {
  const [tab, setTab] = useState<'overview' | 'resellers' | 'api' | 'platform'>('overview');
  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [platform, setPlatform] = useState<Record<string, any>>({});
  const [selected, setSelected] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [durations, setDurations] = useState<Duration[]>([]);
  const [configs, setConfigs] = useState<ApiConfig[]>([]);
  const [salesSummaries, setSalesSummaries] = useState<Record<string, ResellerSalesSummary>>({});
  const [editingPaymentId, setEditingPaymentId] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const stopResellers = onValue(databaseRef('resellers'), snap => setResellers(list<Reseller>(snap.exists() ? snap.val() : null)));
    const stopPlatform = onValue(databaseRef('platform'), snap => setPlatform(snap.exists() ? snap.val() : {}));
    return () => { stopResellers(); stopPlatform(); };
  }, []);

  useEffect(() => { if (!selected && resellers[0]) setSelected(resellers[0].storeCode); }, [resellers, selected]);

  useEffect(() => {
    if (!selected) { setProducts([]); setDurations([]); setConfigs([]); return; }
    const base = `stores/${selected}`;
    const stops = [
      onValue(databaseRef(`${base}/products`), snap => setProducts(list<Product>(snap.exists() ? snap.val() : null))),
      onValue(databaseRef(`${base}/durations`), snap => setDurations(list<Duration>(snap.exists() ? snap.val() : null))),
      onValue(databaseRef(`${base}/apiConfigs`), snap => setConfigs(list<ApiConfig>(snap.exists() ? snap.val() : null)))
    ];
    return () => stops.forEach(stop => stop());
  }, [selected]);

  useEffect(() => {
    let listening = true;
    if (!resellers.length) { setSalesSummaries({}); return; }
    const storeCodes = new Set(resellers.map(item => item.storeCode));
    setSalesSummaries(previous => Object.fromEntries(Object.entries(previous).filter(([code]) => storeCodes.has(code))));
    const stops = resellers.map(reseller => onValue(databaseRef(`stores/${reseller.storeCode}/orders`), snap => {
      if (!listening) return;
      const orders = list<Order>(snap.exists() ? snap.val() : null);
      setSalesSummaries(previous => ({ ...previous, [reseller.storeCode]: { sales: orders.reduce((sum, order) => sum + Number(order.finalAmount || 0), 0), orderCount: orders.length } }));
    }));
    return () => { listening = false; stops.forEach(stop => stop()); };
  }, [resellers]);

  const active = resellers.filter(item => item.active !== false).length;
  const paymentEditor = useMemo(() => resellers.find(item => item.id === editingPaymentId), [resellers, editingPaymentId]);
  const resellerRows = useMemo(() => resellers.map(item => {
    const summary = salesSummaries[item.storeCode] || { sales: 0, orderCount: 0 };
    const adminPaidAmount = Number(item.adminPaidAmount || 0);
    return { ...item, ...summary, adminPaidAmount, remainingAmount: summary.sales - adminPaidAmount };
  }).sort((a, b) => b.sales - a.sales || a.storeName.localeCompare(b.storeName)), [resellers, salesSummaries]);
  const totalSales = resellerRows.reduce((sum, item) => sum + item.sales, 0);
  const totalAdminPaid = resellerRows.reduce((sum, item) => sum + item.adminPaidAmount, 0);
  const totalRemaining = totalSales - totalAdminPaid;
  const tabs = [['overview', BarChart3, 'Overview'], ['resellers', Users, 'Resellers'], ['api', Code2, 'Paid API'], ['platform', Store, 'Checkout']];

  async function createReseller(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget); const code = storeCode(String(form.get('storeCode') || '')); const username = String(form.get('username') || '').trim(); const password = String(form.get('password') || ''); const storeName = String(form.get('storeName') || '').trim() || 'Online Shop';
    if (code.length < 3) return setNotice('Store Code needs at least 3 characters.');
    if (resellers.some(item => item.storeCode === code)) return setNotice('This Store Code is already in use.');
    if (username.length < 3 || password.length < 6) return setNotice('Username needs 3+ characters and password needs 6+.');
    const newRef = push(databaseRef('resellers')); const id = newRef.key || `reseller_${Date.now()}`;
    await set(newRef, { id, username, password, storeCode: code, storeName, active: true, adminPaidAmount: 0, createdAt: Date.now() });
    await set(databaseRef(`stores/${code}/meta`), { storeCode: code, storeName, ownerId: id, active: true, maintenanceEnabled: false, createdAt: Date.now() });
    event.currentTarget.reset(); setSelected(code); setNotice('Reseller owner account created.');
  }

  async function deleteReseller(item: Reseller) {
    if (!window.confirm(`Delete ${item.storeName} (${item.storeCode})? This permanently removes the reseller login and all of this store's products, keys and customer orders.`)) return;
    await remove(databaseRef(`stores/${item.storeCode}`)); await remove(databaseRef(`resellers/${item.id}`));
    if (selected === item.storeCode) { setSelected(''); setTab('resellers'); }
    setNotice(`${item.storeName} and its store data were deleted.`);
  }

  async function saveAdminPaid(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!paymentEditor) return;
    const amount = Math.max(0, Number(new FormData(event.currentTarget).get('adminPaidAmount') || 0));
    await update(databaseRef(`resellers/${paymentEditor.id}`), { adminPaidAmount: amount, adminPaidUpdatedAt: Date.now() });
    setEditingPaymentId(''); setNotice(`Admin paid amount saved for ${paymentEditor.storeName}.`);
  }

  async function saveApi(durationId: string, enabled: boolean, form: HTMLFormElement) {
    if (!selected) return; const values = new FormData(form);
    await set(databaseRef(`stores/${selected}/apiConfigs/${durationId}`), { id: durationId, enabled, game: String(values.get('game') || 'BGMI'), apiDuration: String(values.get('apiDuration') || ''), maxDevices: Math.max(1, Number(values.get('maxDevices') || 1)) });
    setNotice(enabled ? 'Paid API enabled for this duration.' : 'Paid API disabled. Manual stock stays available.');
  }

  const config = (id: string) => configs.find(item => item.id === id);
  return <div className="min-h-screen bg-slate-950 px-3 py-4 text-slate-100 sm:px-5"><div className="mx-auto max-w-7xl">
    <div className="mb-5 flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><p className="text-[10px] font-black uppercase tracking-[.16em] text-violet-300">PeakEsp Admin · Master Only</p><h2 className="mt-1 text-2xl font-black">Reseller Network</h2><p className="mt-1 text-sm text-slate-400">Customer sales are recorded under the reseller Store Code automatically.</p></div><select value={selected} onChange={event => { setSelected(event.target.value); setTab('overview'); }} className="w-full rounded-xl border border-slate-700 bg-slate-900 p-2.5 text-sm sm:w-[260px]"><option value="">Select reseller store</option>{resellers.map(item => <option key={item.id} value={item.storeCode}>{item.storeName} · {item.storeCode}</option>)}</select></div>
    <div className="mb-6 flex gap-1 overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900 p-1.5">{tabs.map(([id, Icon, label]) => { const TabIcon = Icon as typeof BarChart3; return <button key={String(id)} onClick={() => setTab(id as typeof tab)} className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-bold ${tab === id ? 'bg-violet-500 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}><TabIcon className="h-3.5 w-3.5" />{String(label)}</button>; })}</div>
    {notice && <div className="mb-5 flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200"><span>{notice}</span><button onClick={() => setNotice('')}><X className="h-4 w-4" /></button></div>}

    {tab === 'overview' && <><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Stat label="Customer sales" value={money(totalSales)} icon={<ReceiptIndianRupee />} /><Stat label="Admin paid" value={money(totalAdminPaid)} icon={<CreditCard />} /><Stat label="Amount remaining" value={money(totalRemaining)} icon={<WalletCards />} /><Stat label="Active stores" value={String(active)} icon={<CheckCircle2 />} /></div><Card className="mt-5 overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-5"><div><p className="text-[10px] font-black uppercase tracking-[.15em] text-violet-300">Reseller-wise sales</p><h3 className="mt-1 text-lg font-black">Sales and admin payment</h3><p className="mt-1 text-sm text-slate-400">Customer Sales is automatic. Edit only the total amount you have paid to that reseller.</p></div><span className="rounded-full bg-slate-800 px-3 py-1.5 text-xs font-bold text-slate-300">{resellers.length} reseller{resellers.length === 1 ? '' : 's'}</span></div><div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[790px] text-left text-sm"><thead className="bg-slate-950/70 text-[10px] font-black uppercase tracking-[.12em] text-slate-500"><tr><th className="px-5 py-3">Reseller</th><th className="px-4 py-3 text-right">Customer sales</th><th className="px-4 py-3 text-right">Admin paid</th><th className="px-4 py-3 text-right">Amount remaining</th><th className="px-5 py-3 text-right">Action</th></tr></thead><tbody className="divide-y divide-slate-800">{resellerRows.map(item => <tr key={item.id} className="text-slate-300"><td className="px-5 py-4"><p className="font-bold text-white">{item.storeName}</p><p className="mt-0.5 font-mono text-xs text-slate-500">{item.storeCode} · {item.orderCount} order{item.orderCount === 1 ? '' : 's'}</p></td><td className="px-4 py-4 text-right font-bold text-white">{money(item.sales)}</td><td className="px-4 py-4 text-right text-emerald-300">{money(item.adminPaidAmount)}</td><td className={`px-4 py-4 text-right font-black ${item.remainingAmount > 0 ? 'text-amber-300' : item.remainingAmount < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{money(item.remainingAmount)}</td><td className="px-5 py-4 text-right"><Button type="button" onClick={() => setEditingPaymentId(item.id)} className="px-3 py-2">Edit paid <ChevronRight className="h-3.5 w-3.5" /></Button></td></tr>)}{!resellerRows.length && <tr><td colSpan={5} className="px-5 py-10 text-center text-sm text-slate-500">No reseller account yet.</td></tr>}</tbody></table></div><div className="space-y-3 p-4 md:hidden">{resellerRows.map(item => <div key={item.id} className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-bold text-white">{item.storeName}</p><p className="mt-1 font-mono text-[11px] text-slate-500">{item.storeCode} · {item.orderCount} order{item.orderCount === 1 ? '' : 's'}</p></div><Button type="button" onClick={() => setEditingPaymentId(item.id)} className="shrink-0 px-3 py-2">Edit paid</Button></div><div className="mt-4 grid grid-cols-3 gap-3 text-xs"><div><p className="text-slate-500">Sales</p><p className="mt-1 font-black text-white">{money(item.sales)}</p></div><div><p className="text-slate-500">Admin paid</p><p className="mt-1 font-black text-emerald-300">{money(item.adminPaidAmount)}</p></div><div><p className="text-slate-500">Remaining</p><p className={`mt-1 font-black ${item.remainingAmount > 0 ? 'text-amber-300' : item.remainingAmount < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{money(item.remainingAmount)}</p></div></div></div>)}{!resellerRows.length && <p className="py-8 text-center text-sm text-slate-500">No reseller account yet.</p>}</div></Card>{paymentEditor && <Card className="mt-5 max-w-xl p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-[.15em] text-violet-300">Admin payment editor</p><h3 className="mt-1 text-lg font-black">{paymentEditor.storeName}</h3><p className="mt-1 text-sm text-slate-400">Update the total amount you have paid to this reseller.</p></div><button onClick={() => setEditingPaymentId('')} className="rounded-xl p-2 text-slate-400 hover:bg-slate-800"><X className="h-4 w-4" /></button></div><form key={paymentEditor.id} onSubmit={saveAdminPaid} className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end"><div className="flex-1"><Label>Admin paid amount</Label><Input name="adminPaidAmount" type="number" min="0" step="0.01" defaultValue={Number(paymentEditor.adminPaidAmount || 0)} required /></div><Button><Save className="h-4 w-4" />Save amount</Button></form></Card>}<Card className="mt-5 p-5"><h3 className="font-bold">How it works</h3><p className="mt-2 text-sm leading-6 text-slate-400">When a customer buys using a reseller Store Code, the verified order is automatically counted as that reseller’s Customer Sales. You only edit the Admin Paid Amount; Remaining Amount is calculated automatically.</p></Card></>}

    {tab === 'resellers' && <div className="grid gap-5 lg:grid-cols-[.85fr_1.15fr]"><Card className="p-5"><p className="text-[10px] font-black uppercase tracking-[.15em] text-violet-300">Master creates owner login</p><h3 className="mt-1 text-xl font-black">Create reseller</h3><form onSubmit={createReseller} className="mt-5 space-y-3"><div><Label>Store name</Label><Input name="storeName" placeholder="Example Online Shop" required /></div><div><Label>Manual Store Code</Label><Input name="storeCode" placeholder="OWNER001" onChange={event => event.currentTarget.value = storeCode(event.currentTarget.value)} required /></div><div><Label>Owner username</Label><Input name="username" required /></div><div><Label>Owner password</Label><Input name="password" type="password" required /></div><Button className="w-full"><Plus className="h-4 w-4" />Create reseller</Button></form></Card><Card className="overflow-hidden"><div className="border-b border-slate-800 p-5"><h3 className="font-bold">All reseller stores</h3></div><div className="divide-y divide-slate-800">{resellers.length ? resellers.map(item => <div key={item.id} className="flex flex-wrap items-center gap-3 p-4"><div className="grid h-10 w-10 place-items-center rounded-xl bg-violet-500/15 text-violet-300"><Store className="h-5 w-5" /></div><div className="min-w-[140px] flex-1"><p className="font-bold">{item.storeName}</p><p className="font-mono text-xs text-slate-500">{item.storeCode} · @{item.username}</p></div><span className={`rounded-full px-2 py-1 text-[10px] font-black ${item.active !== false ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-700 text-slate-400'}`}>{item.active !== false ? 'ACTIVE' : 'PAUSED'}</span><div className="flex shrink-0 items-center gap-1"><Button type="button" onClick={() => { setSelected(item.storeCode); setTab('api'); }} className="px-3 py-2">Manage <ChevronRight className="h-3.5 w-3.5" /></Button><button onClick={() => { void deleteReseller(item); }} className="rounded-xl border border-rose-500/30 px-3 py-2 text-xs font-black text-rose-300 transition hover:bg-rose-500/10">Delete</button></div></div>) : <p className="p-6 text-center text-sm text-slate-500">No reseller account yet.</p>}</div></Card></div>}

    {tab === 'api' && (!selected ? <SelectStore /> : <div><div className="mb-5"><p className="text-sm text-slate-400">Enable API for a specific reseller product duration. This does not hide their manual-key product.</p></div><div className="space-y-3">{durations.length ? durations.map(duration => { const currentConfig = config(duration.id); return <div key={duration.id}><Card className="p-4"><form onSubmit={event => { event.preventDefault(); void saveApi(duration.id, !currentConfig?.enabled, event.currentTarget); }} className="grid gap-3 lg:grid-cols-[1.2fr_.7fr_.7fr_.6fr_auto] lg:items-end"><div><p className="font-bold">{products.find(product => product.id === duration.productId)?.name || 'Product'}</p><p className="text-sm text-slate-400">{duration.name} · {duration.unit}</p></div><div><Label>Game</Label><Input name="game" defaultValue={currentConfig?.game || 'BGMI'} /></div><div><Label>API duration</Label><Input name="apiDuration" defaultValue={currentConfig?.apiDuration || ''} placeholder="6h / 1d" /></div><div><Label>Max devices</Label><Input name="maxDevices" type="number" min="1" defaultValue={currentConfig?.maxDevices || 1} /></div><Button className={currentConfig?.enabled ? 'bg-rose-500 hover:bg-rose-400' : ''}>{currentConfig?.enabled ? 'Disable API' : 'Enable API'}</Button></form><p className={`mt-3 text-xs font-bold ${currentConfig?.enabled ? 'text-emerald-300' : 'text-amber-300'}`}>{currentConfig?.enabled ? 'Paid API enabled; manual key stock becomes fallback.' : 'Manual stock only.'}</p></Card></div>; }) : <Card className="p-8 text-center text-sm text-slate-400">This reseller has not added durations yet.</Card>}</div></div>)}

    {tab === 'platform' && <Card className="max-w-xl p-6"><p className="text-[10px] font-black uppercase tracking-[.15em] text-violet-300">Master-only secure checkout config</p><h3 className="mt-1 text-xl font-black">Customer checkout backend</h3><p className="mt-2 text-sm leading-6 text-slate-400">Enter the Vercel API URL so Online Shop can securely start payment. Secrets stay in Vercel only.</p><form onSubmit={async event => { event.preventDefault(); const form = new FormData(event.currentTarget); await set(databaseRef('platform'), { ...platform, apiBaseUrl: String(form.get('apiBaseUrl') || '').replace(/\/$/, ''), razorpayKeyId: String(form.get('razorpayKeyId') || '').trim(), updatedAt: Date.now() }); setNotice('Checkout settings saved.'); }} className="mt-5 space-y-4"><div><Label>Vercel API URL</Label><Input name="apiBaseUrl" type="url" defaultValue={platform.apiBaseUrl || ''} placeholder="https://your-project.vercel.app" required /></div><div><Label>Razorpay Key ID (public)</Label><Input name="razorpayKeyId" defaultValue={platform.razorpayKeyId || ''} placeholder="rzp_live_..." required /></div><Button><Save className="h-4 w-4" />Save checkout settings</Button></form></Card>}
  </div></div>;
}

function SelectStore() { return <Card className="p-10 text-center"><Store className="mx-auto h-8 w-8 text-violet-300" /><h3 className="mt-3 text-lg font-black">Select a reseller store</h3><p className="mt-2 text-sm text-slate-400">Use the selector at the top first.</p></Card>; }
