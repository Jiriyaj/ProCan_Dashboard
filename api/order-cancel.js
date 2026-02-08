// api/order-cancel.js
// Cancel an order safely without deleting Stripe history.
// - Deposit is forfeited if cancelled before route starts (no refund here).
// - Stripe subscription is cancelled (immediate or at period end) depending on mode.
//
// ENV:
//   STRIPE_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   ROUTE_SCHEDULER_TOKEN  (re-used for dashboard admin calls)

const Stripe = require('stripe');

function json(res, status, obj){
  res.statusCode = status;
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify(obj));
}

function setCors(req, res){
  const origin = req.headers.origin || '';
  const allowList = (process.env.CORS_ALLOW_ORIGINS || '').split(',').map(v=>v.trim()).filter(Boolean);
    const allowOrigin = allowList.length ? (allowList.includes(origin) ? origin : '*') : '*'; // always respond for browser CORS
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function requireAuth(req){
  const h = req.headers.authorization || req.headers.Authorization || '';
  const token = String(h).startsWith('Bearer ') ? String(h).slice(7).trim() : '';
  return token && process.env.ROUTE_SCHEDULER_TOKEN && token === process.env.ROUTE_SCHEDULER_TOKEN;
}

async function sbFetch(path, method, body){
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env not set');
  const resp = await fetch(url.replace(/\/$/,'') + path, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await resp.text().catch(()=> '');
  let data = null;
  try{ data = text ? JSON.parse(text) : null; }catch(e){ data = text; }
  return { ok: resp.ok, status: resp.status, data };
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
try{
    if (req.method !== 'POST') return json(res, 405, { error:'Method Not Allowed' });
    if (!requireAuth(req)) return json(res, 401, { error:'Unauthorized' });

    const body = req.body || {};
    const orderId = String(body.order_id || '').trim();
    const mode = String(body.mode || 'before_start').toLowerCase(); // before_start | after_start
    const cancelAtPeriodEnd = body.cancel_at_period_end !== false; // default true

    if (!orderId) return json(res, 400, { error:'Missing order_id' });

    // Load order
    const oResp = await sbFetch(`/rest/v1/orders?select=id,stripe_subscription_id,stripe_customer_id,status,is_deleted&id=eq.${encodeURIComponent(orderId)}&limit=1`, 'GET');
    if (!oResp.ok) return json(res, 500, { error:'Failed to load order', detail:oResp.data });
    const order = Array.isArray(oResp.data) ? oResp.data[0] : oResp.data;
    if (!order) return json(res, 404, { error:'Order not found' });

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const subId = order.stripe_subscription_id || null;

    let stripeAction = 'none';
    if (subId){
      if (mode === 'after_start'){
        // Default: cancel at period end to avoid prorations/payment surprises.
        if (cancelAtPeriodEnd){
          await stripe.subscriptions.update(subId, { cancel_at_period_end: true, proration_behavior: 'none' });
          stripeAction = 'cancel_at_period_end';
        } else {
          await stripe.subscriptions.del(subId);
          stripeAction = 'cancel_now';
        }
      } else {
        // before_start: cancel immediately so no future invoices occur.
        await stripe.subscriptions.del(subId);
        stripeAction = 'cancel_now';
      }
    }

    const newStatus = (mode === 'after_start') ? 'cancelled_active' : 'cancelled_before_start';
    const patch = { status: newStatus, cancelled_at: new Date().toISOString() };
    const uResp = await sbFetch(`/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`, 'PATCH', patch);
    if (!uResp.ok) return json(res, 500, { error:'Failed to update order in Supabase', detail:uResp.data });

    return json(res, 200, { ok:true, order_id: orderId, mode, stripe_action: stripeAction, status:newStatus });
  }catch(e){
    console.error('order-cancel error:', e);
    return json(res, 500, { error: e?.message || 'Server error' });
  }
};
