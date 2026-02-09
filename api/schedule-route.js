// api/schedule-route.js
// Secure endpoint to:
//  1) persist route schedule (service_start_date + cadence) in Supabase
//  2) update Stripe subscriptions created from deposits:
//     - apply the $25 deposit as a customer balance credit (reduces first invoice)
//     - set subscription trial_end to the first service day (charges on service day)
//
// ENV required:
//   STRIPE_SECRET_KEY=...
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=...
//   ROUTE_SCHEDULER_TOKEN=some-long-random-string
//
// Dashboard should call:
//   POST /api/schedule-route
//   Authorization: Bearer <ROUTE_SCHEDULER_TOKEN>
//   { route_id, service_start_date, cadence }
const Stripe = require('stripe');

function json(res, status, obj){
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
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

function parseDateToChargeTimestamp(serviceStartDateISO){
  // Charge on service day. We pick 09:00 America/Chicago-ish by using 15:00Z (avoids midnight edge cases).
  // If you want a different charge hour, change this.
  const iso = String(serviceStartDateISO || '').slice(0,10);
  const d = new Date(iso + 'T15:00:00Z');
  if (isNaN(d.getTime())) return null;
  const ts = Math.floor(d.getTime()/1000);
  return ts;
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

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const body = req.body || {};
    const routeId = String(body.route_id || '').trim();
    const serviceStartDate = String(body.service_start_date || '').slice(0,10);
    const cadence = String(body.cadence || 'biweekly').toLowerCase();

    if (!routeId) return json(res, 400, { error:'Missing route_id' });
    if (!serviceStartDate) return json(res, 400, { error:'Missing service_start_date' });

    const trialEnd = parseDateToChargeTimestamp(serviceStartDate);
    if (!trialEnd) return json(res, 400, { error:'Invalid service_start_date' });

    // 1) Update route schedule
    const rUpdate = await sbFetch(`/rest/v1/routes?id=eq.${encodeURIComponent(routeId)}`, 'PATCH', {
      service_start_date: serviceStartDate,
      cadence
    });
    if (!rUpdate.ok){
      return json(res, 500, { error:'Failed to update route in Supabase', detail: rUpdate.data });
    }

    // 2) Load orders on this route that have Stripe subscription IDs
    const ordersResp = await sbFetch(`/rest/v1/orders?select=id,stripe_customer_id,stripe_subscription_id,deposit_amount,is_deposit&route_id=eq.${encodeURIComponent(routeId)}`, 'GET');
    if (!ordersResp.ok){
      return json(res, 500, { error:'Failed to load orders for route', detail: ordersResp.data });
    }

    const orders = Array.isArray(ordersResp.data) ? ordersResp.data : [];
    let updatedSubs = 0;
    let credited = 0;
    const errors = [];

    for (const o of orders){
      try{
        const subId = o.stripe_subscription_id;
        const custId = o.stripe_customer_id;
        if (!subId || !custId) continue;

        // Apply deposit credit once (idempotent)
        const deposit = Number(o.deposit_amount || 25);
        const depositCents = Math.round(deposit * 100);
        if (depositCents > 0){
          await stripe.customers.createBalanceTransaction(
            custId,
            { amount: -depositCents, currency: 'usd', description: `ProCan deposit credit for route ${routeId}` },
            { idempotencyKey: `route_${routeId}_order_${o.id}_depositcredit` }
          );
          credited++;
        }

        // Set trial_end to the service day so first invoice charges on service day
        await stripe.subscriptions.update(
          subId,
          { trial_end: trialEnd, proration_behavior: 'none', cancel_at: null, cancel_at_period_end: false },
          { idempotencyKey: `route_${routeId}_sub_${subId}_trialend_${serviceStartDate}` }
        );
        updatedSubs++;
      }catch(e){
        errors.push({ order_id: o.id, message: e?.message || String(e) });
      }
    }

    return json(res, 200, {
      ok:true,
      route_id: routeId,
      service_start_date: serviceStartDate,
      cadence,
      updated_subscriptions: updatedSubs,
      deposit_credits_applied: credited,
      errors
    });
  }catch(e){
    console.error('schedule-route error:', e);
    return json(res, 500, { error: e?.message || 'Server error' });
  }
};
