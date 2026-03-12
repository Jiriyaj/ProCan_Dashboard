const Stripe = require('stripe');

function json(res, status, obj){
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function setCors(req, res){
  const origin = req.headers.origin || '';
  const allowList = (process.env.CORS_ALLOW_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  const allowOrigin = allowList.length ? (allowList.includes(origin) ? origin : '*') : '*';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Stripe-Signature');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function readRawBody(req){
  if (req.rawBody && Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  if (req.body && typeof req.body === 'object') return Buffer.from(JSON.stringify(req.body));

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function sbFetch(path, method, body){
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env not set');

  const resp = await fetch(url.replace(/\/$/, '') + path, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await resp.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: resp.ok, status: resp.status, data };
}

function centsToDollars(v){
  const n = Number(v || 0);
  return Number.isFinite(n) ? +(n / 100).toFixed(2) : 0;
}

function unixToIsoDate(ts){
  if (!ts) return null;
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function unixToIsoTimestamp(ts){
  if (!ts) return null;
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function coalesce(...vals){
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v) !== '') return v;
  }
  return null;
}

function isManualHold(order){
  return /manual/i.test(String(order?.service_hold_reason || ''));
}

function subscriptionPaymentLabel(subStatus){
  const s = String(subStatus || '').toLowerCase();
  if (!s) return null;
  if (['active', 'trialing'].includes(s)) return 'paid';
  if (s === 'past_due') return 'past_due';
  if (s === 'canceled') return 'canceled';
  if (['unpaid', 'incomplete', 'incomplete_expired'].includes(s)) return 'unpaid';
  return s;
}

async function recordWebhookEvent(event){
  try {
    const lookup = await sbFetch(`/rest/v1/stripe_webhook_events?select=event_id&event_id=eq.${encodeURIComponent(event.id)}&limit=1`, 'GET');
    if (lookup.ok && Array.isArray(lookup.data) && lookup.data.length) return { duplicate: true };

    const insert = await sbFetch('/rest/v1/stripe_webhook_events', 'POST', {
      event_id: event.id,
      event_type: event.type,
      livemode: !!event.livemode,
      payload: event,
      received_at: new Date().toISOString()
    });

    if (!insert.ok) {
      return { duplicate: false, warning: 'event_log_insert_failed', detail: insert.data };
    }
    return { duplicate: false };
  } catch (e) {
    return { duplicate: false, warning: e?.message || 'event_log_unavailable' };
  }
}

async function findOrderForStripeObject(obj){
  const metadata = obj?.metadata || {};
  const orderId = String(metadata.order_id || metadata.orderId || '').trim();
  const subId = String(obj?.subscription || obj?.id || '').trim();
  const customerId = String(obj?.customer || '').trim();

  if (orderId) {
    const byId = await sbFetch(`/rest/v1/orders?select=*&id=eq.${encodeURIComponent(orderId)}&limit=1`, 'GET');
    if (byId.ok && Array.isArray(byId.data) && byId.data[0]) return byId.data[0];
  }

  if (subId) {
    const bySub = await sbFetch(`/rest/v1/orders?select=*&stripe_subscription_id=eq.${encodeURIComponent(subId)}&limit=1`, 'GET');
    if (bySub.ok && Array.isArray(bySub.data) && bySub.data[0]) return bySub.data[0];
  }

  if (customerId) {
    const byCustomer = await sbFetch(`/rest/v1/orders?select=*&stripe_customer_id=eq.${encodeURIComponent(customerId)}&order=created_at.desc&limit=5`, 'GET');
    if (byCustomer.ok && Array.isArray(byCustomer.data) && byCustomer.data.length) {
      const preferred = byCustomer.data.find(o => !o.is_deleted && !String(o.status || '').toLowerCase().startsWith('cancelled'));
      return preferred || byCustomer.data[0];
    }
  }

  return null;
}

async function applyOrderPatch(orderId, patch){
  return sbFetch(`/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`, 'PATCH', patch);
}

async function handleInvoiceEvent(event){
  const invoice = event.data.object || {};
  const order = await findOrderForStripeObject(invoice);
  if (!order) {
    return { ok: true, skipped: true, reason: 'order_not_found' };
  }

  let subscription = null;
  const subscriptionId = String(invoice.subscription || order.stripe_subscription_id || '').trim();
  if (subscriptionId) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      subscription = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (e) {
      subscription = null;
    }
  }

  const patch = {
    stripe_customer_id: coalesce(invoice.customer, order.stripe_customer_id),
    stripe_subscription_id: coalesce(invoice.subscription, order.stripe_subscription_id),
    stripe_status: coalesce(subscription?.status, order.stripe_status),
    stripe_payment_status: coalesce(invoice.status, subscriptionPaymentLabel(subscription?.status), order.stripe_payment_status),
    payment_due_date: coalesce(unixToIsoDate(invoice.due_date), unixToIsoDate(invoice.next_payment_attempt), order.payment_due_date),
    payment_paid_date: coalesce(unixToIsoDate(invoice.status_transitions?.paid_at), order.payment_paid_date),
    amount_paid: centsToDollars(invoice.amount_paid),
    last_invoice_sent_at: new Date().toISOString(),
    last_stripe_event_id: event.id,
    last_stripe_event_type: event.type,
    last_stripe_event_at: new Date().toISOString(),
    stripe_current_period_end: coalesce(unixToIsoTimestamp(subscription?.current_period_end), order.stripe_current_period_end),
    stripe_cancel_at: coalesce(unixToIsoTimestamp(subscription?.cancel_at), order.stripe_cancel_at),
    stripe_cancel_at_period_end: !!(subscription?.cancel_at_period_end || order.stripe_cancel_at_period_end)
  };

  if (event.type === 'invoice.payment_succeeded' || event.type === 'invoice.paid') {
    patch.payment_status = 'paid';
    patch.billing_status = 'active';
    if (!isManualHold(order)) {
      patch.service_hold = false;
      patch.service_hold_reason = null;
      patch.service_hold_since = null;
    }
  } else if (event.type === 'invoice.payment_failed') {
    patch.payment_status = 'past_due';
    patch.billing_status = 'past_due';
    patch.service_hold = true;
    patch.service_hold_reason = isManualHold(order) ? order.service_hold_reason : 'Stripe payment failed';
    patch.service_hold_since = order.service_hold_since || new Date().toISOString();
    patch.payment_paid_date = null;
  } else if (event.type === 'invoice.finalized' || event.type === 'invoice.created') {
    patch.payment_status = centsToDollars(invoice.amount_remaining) > 0 ? 'unpaid' : (order.payment_status || 'paid');
  }

  const resp = await applyOrderPatch(order.id, patch);
  return { ok: resp.ok, order_id: order.id, detail: resp.ok ? undefined : resp.data };
}

async function handleSubscriptionEvent(event){
  const sub = event.data.object || {};
  const order = await findOrderForStripeObject(sub);
  if (!order) {
    return { ok: true, skipped: true, reason: 'order_not_found' };
  }

  const subStatus = String(sub.status || '').toLowerCase();
  const patch = {
    stripe_customer_id: coalesce(sub.customer, order.stripe_customer_id),
    stripe_subscription_id: coalesce(sub.id, order.stripe_subscription_id),
    stripe_status: subStatus || order.stripe_status,
    stripe_payment_status: coalesce(subscriptionPaymentLabel(subStatus), order.stripe_payment_status),
    stripe_current_period_end: unixToIsoTimestamp(sub.current_period_end),
    stripe_cancel_at: coalesce(unixToIsoTimestamp(sub.cancel_at), unixToIsoTimestamp(sub.canceled_at), order.stripe_cancel_at),
    stripe_cancel_at_period_end: !!sub.cancel_at_period_end,
    last_stripe_event_id: event.id,
    last_stripe_event_type: event.type,
    last_stripe_event_at: new Date().toISOString()
  };

  if (subStatus === 'canceled' || event.type === 'customer.subscription.deleted') {
    patch.payment_status = 'canceled';
    patch.billing_status = 'canceled';
    patch.status = String(order.status || '').toLowerCase().startsWith('cancelled') ? order.status : 'cancelled_active';
    patch.cancelled_at = coalesce(unixToIsoTimestamp(sub.canceled_at), new Date().toISOString());
    patch.service_hold = true;
    patch.service_hold_reason = isManualHold(order) ? order.service_hold_reason : 'Stripe subscription canceled';
    patch.service_hold_since = order.service_hold_since || new Date().toISOString();
  } else if (subStatus === 'past_due') {
    patch.payment_status = 'past_due';
    patch.billing_status = 'past_due';
    patch.service_hold = true;
    patch.service_hold_reason = isManualHold(order) ? order.service_hold_reason : 'Stripe subscription past due';
    patch.service_hold_since = order.service_hold_since || new Date().toISOString();
  } else if (['active', 'trialing'].includes(subStatus)) {
    patch.payment_status = order.payment_status === 'paid' ? 'paid' : (order.payment_status || 'paid');
    patch.billing_status = 'active';
    if (!isManualHold(order)) {
      patch.service_hold = false;
      patch.service_hold_reason = null;
      patch.service_hold_since = null;
    }
  } else if (['unpaid', 'incomplete', 'incomplete_expired'].includes(subStatus)) {
    patch.payment_status = 'unpaid';
    patch.billing_status = 'past_due';
    patch.service_hold = true;
    patch.service_hold_reason = isManualHold(order) ? order.service_hold_reason : `Stripe subscription ${subStatus}`;
    patch.service_hold_since = order.service_hold_since || new Date().toISOString();
  }

  const resp = await applyOrderPatch(order.id, patch);
  return { ok: resp.ok, order_id: order.id, detail: resp.ok ? undefined : resp.data };
}

async function handleCheckoutSessionCompleted(event){
  const session = event.data.object || {};
  const order = await findOrderForStripeObject(session);
  if (!order) return { ok: true, skipped: true, reason: 'order_not_found' };

  const patch = {
    stripe_customer_id: coalesce(session.customer, order.stripe_customer_id),
    stripe_subscription_id: coalesce(session.subscription, order.stripe_subscription_id),
    stripe_status: coalesce(order.stripe_status, 'active'),
    stripe_payment_status: coalesce(order.stripe_payment_status, 'paid'),
    payment_status: coalesce(order.payment_status, 'paid'),
    billing_status: 'active',
    last_stripe_event_id: event.id,
    last_stripe_event_type: event.type,
    last_stripe_event_at: new Date().toISOString()
  };

  const resp = await applyOrderPatch(order.id, patch);
  return { ok: resp.ok, order_id: order.id, detail: resp.ok ? undefined : resp.data };
}

async function processEvent(event){
  switch (event.type) {
    case 'invoice.payment_succeeded':
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'invoice.finalized':
    case 'invoice.created':
      return handleInvoiceEvent(event);

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return handleSubscriptionEvent(event);

    case 'checkout.session.completed':
      return handleCheckoutSessionCompleted(event);

    default:
      return { ok: true, skipped: true, reason: 'ignored_event_type' };
  }
}

async function handler(req, res){
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method Not Allowed' });
  }

  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return json(res, 500, { error: 'Missing STRIPE_SECRET_KEY' });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const signature = req.headers['stripe-signature'];
    const rawBody = await readRawBody(req);
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } else {
      event = JSON.parse(rawBody.toString('utf8'));
    }

    const log = await recordWebhookEvent(event);
    if (log.duplicate) {
      return json(res, 200, { received: true, duplicate: true, event_id: event.id });
    }

    const result = await processEvent(event);
    if (!result.ok) {
      return json(res, 500, { received: true, event_id: event.id, error: 'Failed to sync order', detail: result.detail || result });
    }

    return json(res, 200, {
      received: true,
      event_id: event.id,
      event_type: event.type,
      duplicate: false,
      synced_order_id: result.order_id || null,
      skipped: !!result.skipped,
      reason: result.reason || null,
      warning: log.warning || null
    });
  } catch (e) {
    console.error('stripe-webhook error:', e);
    return json(res, 400, { error: e?.message || 'Webhook error' });
  }
}

handler.config = {
  api: {
    bodyParser: false
  }
};

module.exports = handler;
