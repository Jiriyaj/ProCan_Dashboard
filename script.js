
async function probeSchema(){
  // Detect if routes table + orders.route_id exist. Safe: if not, we just disable route-first UI.
  try{
    const r = await supabaseClient.from('routes').select('id').limit(1);
    if (!r.error) state.supportsRoutes = true;
  }catch(e){}
  try{
    const o = await supabaseClient.from('orders').select('id,route_id').limit(1);
    if (!o.error){
      state.supportsOrdersRouteId = true;
    }
  }catch(e){}
  const notice = document.getElementById('routesSchemaNotice');
  if (notice){
    notice.style.display = (state.supportsRoutes && state.supportsOrdersRouteId) ? 'none' : 'block';
  }
}

// ROUTE-FIRST MODEL: Orders attach to routes. Operators attach to routes.

'use strict';

/* ========= Helpers ========= */
const fmtMoney = (n) => {
  const v = Number(n || 0);
  return v.toLocaleString('en-US', { style:'currency', currency:'USD' });
};
const payoutToPercent = (v) => {
  const n = Number(v);
  if (!isFinite(n)) return 30;
  return (state?.payoutMode === 'fraction') ? (n * 100) : n;
};
const payoutFromPercent = (p) => {
  const n = Number(p);
  if (!isFinite(n)) return 30;
  return (state?.payoutMode === 'fraction') ? (n / 100) : n;
};
const sanitizeSchedulePatch = (patch) => {
  const out = { ...patch };
  if ('service_day' in out){
    const v = out.service_day;
    out.service_day = (v === '' || v == null) ? null : Number(v);
  }
  if ('route_operator_id' in out){
    if (state && state.supportsRouteOperatorId === false){
      delete out.route_operator_id;
    } else {
      const v = out.route_operator_id;
      out.route_operator_id = (v === '' || v == null) ? null : String(v);
    }
  }
  if ('route_start_date' in out){
    const v = out.route_start_date;
    out.route_start_date = (v === '' || v == null) ? null : String(v);
  }
  if ('last_service_date' in out){
    const v = out.last_service_date;
    out.last_service_date = (v === '' || v == null) ? null : String(v);
  }
  if ('is_deposit' in out) out.is_deposit = !!out.is_deposit;
  return out;
};

const fmtSbError = (error) => {
  if (!error) return 'Unknown error';
  const parts = [error.message, error.details, error.hint, error.code].filter(Boolean);
  return parts.join(' • ');
};

const toISODate = (d) => new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10);
const parseISO = (s) => {
  const m = String(s||'').trim();
  if (!m) return null;
  const d = new Date(m);
  return isNaN(d) ? null : d;
};

function parseISODate(s){
  const d = s ? new Date(String(s).slice(0,10) + 'T00:00:00') : null;
  return (d && !isNaN(d.getTime())) ? d : null;
}
function addDays(d, days){
  const x = new Date(d.getTime());
  x.setDate(x.getDate()+days);
  return x;
}
function addMonths(d, months){
  const x = new Date(d.getTime());
  const day = x.getDate();
  x.setMonth(x.getMonth()+months);
  // handle month rollover
  if (x.getDate() !== day) x.setDate(0);
  return x;
}
function fmtDateLong(d){
  try{
    return d.toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  }catch(e){
    return toISODate(d);
  }
}
function computeNextServiceDates(route){
  const cadence = String(route?.cadence || 'biweekly').toLowerCase();
  const start = parseISODate(route?.service_start_date);
  if (!start) return { next:null, next2:null };

  const last = parseISODate(route?.last_service_date);
  const base = last ? (cadence==='monthly' ? addMonths(last,1) : addDays(last,14)) : start;

  // If base is in the past, roll forward until >= today
  const today = new Date(); today.setHours(0,0,0,0);
  let next = new Date(base.getTime());
  let guard = 0;
  while (next < today && guard < 80){
    next = (cadence==='monthly') ? addMonths(next,1) : addDays(next,14);
    guard++;
  }
  const next2 = (cadence==='monthly') ? addMonths(next,1) : addDays(next,14);
  return { next, next2 };
}
const PROCAN_API_BASE = (window.PROCAN_API_BASE || localStorage.getItem('PROCAN_API_BASE') || '').trim();




// Route readiness (0-100). Simple progress signal before activating a route.
function computeRouteReadiness(route){
  // Route readiness = ONLY how close you are to the can capacity needed to launch
  if (!route) return { pct:0, assignedCans:0, targetCans:0, reasons:['No route selected'] };

  const orders = (state.orders||[]).filter(o => String(o.route_id||'') === String(route.id||''));

  const assignedCans = orders.reduce((sum, o)=>{
    const n = parseInt(String(o.cans ?? o.can_count ?? o.qty ?? ''), 10);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);

  const targetCans = Math.max(0, parseInt(String(route.target_cans ?? ''), 10) || 0);

  if (targetCans <= 0){
    return { pct: 0, assignedCans, targetCans, reasons:['Set target cans for this route'] };
  }

  const pct = Math.max(0, Math.min(100, Math.round((assignedCans / targetCans) * 100)));
  const reasons = [];
  if (assignedCans < targetCans){
    reasons.push(`Need ${targetCans - assignedCans} more can(s) to launch`);
  } else {
    reasons.push('Target met — ready to activate');
  }
  return { pct, assignedCans, targetCans, reasons };
}


function setRouteReadinessUI(route){
  const pctEl = document.getElementById('routeReadinessPct');
  const barEl = document.getElementById('routeReadinessBar');
  const hintEl = document.getElementById('routeReadinessHint');
  if (!pctEl || !barEl || !hintEl) return;

  const info = computeRouteReadiness(route);
  pctEl.textContent = String(info.pct);
  barEl.style.width = info.pct + '%';

  if (info.targetCans > 0){
    hintEl.textContent = `${info.assignedCans}/${info.targetCans} cans • ${info.reasons[0] || ''}`.trim();
  } else {
    hintEl.textContent = info.reasons[0] || 'Set target cans to enable readiness.';
  }
}

// Very lightweight stop ordering: if lat/lng exist, use a nearest-neighbor pass; otherwise fall back to ZIP/address.
function getLatLng(order){
  const lat = order.lat ?? order.latitude ?? order.geo_lat ?? null;
  const lng = order.lng ?? order.longitude ?? order.geo_lng ?? null;
  const a = Number(lat); const b = Number(lng);
  if (!isFinite(a) || !isFinite(b)) return null;
  return { lat:a, lng:b };
}

function haversineKm(a,b){
  const R = 6371;
  const toRad = (x)=>x * Math.PI/180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat/2);
  const s2 = Math.sin(dLon/2);
  const q = s1*s1 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*s2*s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(q)));
}

function extractZip(order){
  const z = order.zip ?? order.postal_code ?? order.zip_code ?? '';
  if (z) return String(z).trim();
  const addr = String(order.address||order.location||'');
  const m = addr.match(/\b\d{5}(?:-\d{4})?\b/);
  return m ? m[0] : '';
}

function orderStopsEfficiently(orders){
  const pts = orders.map(o=>({ o, p:getLatLng(o) })).filter(x=>x.p);
  if (pts.length === orders.length && orders.length > 2){
    const remaining = pts.slice();
    const route = [];
    // Start with the first stop as anchor
    let current = remaining.shift();
    route.push(current.o);
    while(remaining.length){
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i=0;i<remaining.length;i++){
        const d = haversineKm(current.p, remaining[i].p);
        if (d < bestDist){ bestDist = d; bestIdx = i; }
      }
      current = remaining.splice(bestIdx,1)[0];
      route.push(current.o);
    }
    return route;
  }

  // Fallback: ZIP then address then name
  return [...orders].sort((a,b)=>{
    const za = extractZip(a); const zb = extractZip(b);
    if (za !== zb) return za.localeCompare(zb);
    const aa = String(a.address||a.location||'');
    const ab = String(b.address||b.location||'');
    if (aa !== ab) return aa.localeCompare(ab);
    const na = String(a.business_name||a.biz_name||a.name||'');
    const nb = String(b.business_name||b.biz_name||b.name||'');
    return na.localeCompare(nb);
  });
}
const startOfWeek = (date) => {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // Mon=0
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() - day);
  return d;
};
// NOTE: addDays is defined above as a function. Avoid redeclaring it.
const sameISO = (a,b) => String(a||'')===String(b||'');
const zipFromAddress = (addr) => {
  const s = String(addr||'');
  const m = s.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : '';
};
const normalizeDay = (v) => {
  const s = String(v||'').toLowerCase();
  if (!s) return null;
  if (s.includes('mon')) return 1;
  if (s.includes('tue')) return 2;
  if (s.includes('wed')) return 3;
  if (s.includes('thu')) return 4;
  if (s.includes('fri')) return 5;
  if (s.includes('sat')) return 6;
  if (s.includes('sun')) return 0;
  // numeric?
  const n = parseInt(s,10);
  return Number.isFinite(n) ? n : null;
};
const dayName = (dow) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow];

const daysBetween = (a,b) => {
  const da = (a instanceof Date) ? a : parseISO(a);
  const db = (b instanceof Date) ? b : parseISO(b);
  if (!da || !db) return null;
  const ms = db.setHours(0,0,0,0) - da.setHours(0,0,0,0);
  return Math.floor(ms / 86400000);
};
const weeksBetween = (a,b) => {
  const d = daysBetween(a,b);
  return d==null ? null : Math.floor(d / 7);
};
const isoDow = (iso) => {
  const d = parseISO(iso);
  return d ? d.getDay() : null;
};
const nextDateForDow = (dow, fromDate=new Date()) => {
  const d = new Date(fromDate);
  d.setHours(0,0,0,0);
  const diff = (dow - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + (diff===0 ? 7 : diff));
  return d;
};

// Route rhythm: the ROUTE runs every other week on its assigned day.
// Customer service_frequency is stored on the order as `cadence` ("biweekly" or "monthly").
function isOrderDueOnRunDate(order, runISO){
  const freq = String(order?.cadence || order?.service_frequency || '').toLowerCase();
  const billing = String(order?.billing_status || 'active').toLowerCase();
  if (billing && billing !== 'active') return false;

  // Must have a service day assigned
  const sd = (order?.service_day != null) ? Number(order.service_day) : normalizeDay(order?.service_day);
  if (sd == null) return false;

  // Run date must match service day
  if (isoDow(runISO) !== sd) return false;

  // Biweekly: due on every route run that aligns with route_start_date anchor (even week offset)
  if (freq.includes('biweek')){
    const anchor = order?.route_start_date || order?.service_start_date || order?.created_at;
    const w = weeksBetween(anchor, runISO);
    if (w == null) return false;
    return (w % 2) === 0;
  }

  // Monthly: due when >= 28 days since last service; first run after start is due.
  if (freq.includes('month')){
    const last = order?.last_service_date;
    if (!last) {
      // If no prior service, due on first eligible run at/after route_start_date
      const anchor = order?.route_start_date || order?.service_start_date || order?.created_at;
      const anchorISO = anchor ? toISODate(parseISO(anchor) || new Date(anchor)) : null;
      if (!anchorISO) return true;
      return runISO >= anchorISO;
    }
    const d = daysBetween(last, runISO);
    return d != null && d >= 28;
  }

  // Default: treat unknown as not due
  return false;
}

/* ========= Order lifecycle (deposit → scheduled) =========
   Early-stage reality:
   - Intake orders arrive as deposit/reservation records.
   - They become "scheduled" only after you activate a route and create assignments.
   We don't assume a special DB column; we infer stage from:
   - orders.status (new/paid/...) and
   - whether any assignments exist for the order.
*/
function orderHasAnyAssignment(orderId){
  return state.assignments.some(a => a.order_id === orderId);
}

function stageLabelForOrder(order){
  const life = String(order?.status || '').toLowerCase();
  if (order?.is_deleted === true) return 'archived';
  if (life.startsWith('cancelled')) return 'cancelled';
  // ROUTE-FIRST STATUS (no editable status):
  // 1) Deposited (paid) → 2) On route (route_id set) → 3) Route active (route.status === 'active')
  const st = String(order?.status || order?.payment_status || '').toLowerCase();

  const deposited =
    st === 'paid' || st === 'succeeded' || st === 'success' ||
    String(order?.stripe_payment_status||'').toLowerCase() === 'paid' ||
    String(order?.stripe_status||'').toLowerCase() === 'paid' ||
    order?.is_deposit === true || String(order?.is_deposit||'').toLowerCase() === 'true';

  const rid = order?.route_id || null;
  const route = rid ? (state.routes||[]).find(r=>r.id===rid) : null;
  const routeActive = route && String(route.status||'').toLowerCase() === 'active';

  if (routeActive) return 'route active';
  if (rid) return 'on route';
  if (deposited) return 'deposited';
  return 'needs deposit';
}


function renderOperatorNameForOrder(order){
  const rid = order?.route_id || null;
  if (!rid) return '—';
  const route = (state.routes||[]).find(r=>r.id===rid);
  if (!route || !route.operator_id) return '—';
  const op = (state.operators||[]).find(o=>o.id===route.operator_id);
  return op?.name || op?.full_name || op?.email || '—';
}

function renderRouteChipForOrder(order){
  const rid = order?.route_id || null;
  if (!rid) return '<span class="muted">—</span>';
  const route = (state.routes||[]).find(r=>r.id===rid);
  if (!route) return '<span class="muted">—</span>';
  const status = String(route.status||'draft');
  const name = route.name || 'Route';
  const cls = status==='active' ? 'badge ok' : (status==='ready' ? 'badge amber' : 'badge');
  return `<span class="${cls}"><span class="dot"></span>${escapeHtml(name)} • ${escapeHtml(status)}</span>`;
}

/* ========= DOM ========= */
const $ = (id) => document.getElementById(id);


/* ========= Toast ========= */
function toast(message, type='info', ms=2600){
  try{
    const hostId = 'toastHost';
    let host = document.getElementById(hostId);
    if (!host){
      host = document.createElement('div');
      host.id = hostId;
      host.style.position = 'fixed';
      host.style.right = '14px';
      host.style.bottom = '14px';
      host.style.zIndex = '99999';
      host.style.display = 'flex';
      host.style.flexDirection = 'column';
      host.style.gap = '10px';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    el.style.padding = '10px 12px';
    el.style.borderRadius = '12px';
    el.style.border = '1px solid rgba(255,255,255,0.14)';
    el.style.background = 'rgba(18,22,30,0.92)';
    el.style.color = '#fff';
    el.style.boxShadow = '0 10px 24px rgba(0,0,0,0.28)';
    el.style.maxWidth = '360px';
    el.style.fontSize = '14px';
    el.style.lineHeight = '1.25';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = 'opacity 140ms ease, transform 140ms ease';
    if (type === 'warn'){ el.style.borderColor = 'rgba(255,200,80,0.35)'; }
    if (type === 'error'){ el.style.borderColor = 'rgba(255,90,90,0.35)'; }
    if (type === 'success'){ el.style.borderColor = 'rgba(120,255,170,0.30)'; }
    host.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
    setTimeout(() => {
      el.style.opacity = '0'; el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 200);
    }, Math.max(800, ms|0));
  }catch(e){
    // last resort
    alert(message);
  }
}

/* ========= Supabase ========= */
let supabaseClient = null;
let cachedSession = null;

function supabaseReady(){
  const url = String(window.SUPABASE_URL||'');
  const key = String(window.SUPABASE_ANON_KEY||'');
  if (!url || !key) return false;
  if (url.includes('YOURPROJECT') || key.includes('YOUR_SUPABASE') || key.length < 30) return false;
  return !!window.supabase;
}

function initSupabase(){
  if (!supabaseReady()) return null;
  if (supabaseClient) return supabaseClient;
  supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
  });
  return supabaseClient;
}

/* ========= State ========= */
const state = {
  // Route-first support flags (set after schema probe)
  supportsRoutes: false,
  supportsOrdersRouteId: false,
  selectedRouteId: null,
  routes: [],
  routesWeek: 'all',

  view: 'homeView',
  weekStart: startOfWeek(new Date()),
  operators: [],
  orders: [],
  supportsRouteOperatorId: true,
  assignments: [],
  payoutMode: "percent", // "percent" (30) or "fraction" (0.30)
  map: null,
  mapLayers: { markers: [], lines: [] },
  operatorColors: {}, // id -> color
};

const COLORS = [
  '#28c7ff', '#ffb020', '#b084ff', '#ff4d4d', '#9099a8', '#ffffff', '#d7dde7'
];

/* ========= Boot ========= */
document.addEventListener('DOMContentLoaded', async () => {
  // startup overlay failsafe
  setTimeout(() => { const o=$('startupOverlay'); if(o){o.style.opacity='0'; setTimeout(()=>o.remove(),250);} }, 450);

  initSupabase();
  wireUI();

  if (!supabaseClient){
    showAuthMessage('Supabase not configured. Fill SUPABASE_URL + SUPABASE_ANON_KEY in supabase-config.js');
    $('authGate').style.display='grid';
    return;
  }

  // auth state
  const { data: { session } } = await supabaseClient.auth.getSession();
  cachedSession = session || null;

  supabaseClient.auth.onAuthStateChange((_event, session2) => {
    cachedSession = session2 || null;
    if (!cachedSession) showAuth();
    else showApp();
  });

  if (!cachedSession) showAuth();
  else showApp();
});

/* ========= UI wiring ========= */
function wireUI(){
  const on = (id, evt, fn) => {
    const el = $(id);
    if (el) el.addEventListener(evt, fn);
  };

  // nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  on('btnLogin', 'click', loginWithPassword);
  on('btnMagic', 'click', sendMagicLink);
  on('btnLogout', 'click', async () => {
    if (!supabaseClient) return;
    await supabaseClient.auth.signOut();
  });

  // Routes (route-first)
  on('btnNewRoute','click', async ()=>{ await createRoute(); });
  on('btnSaveRoute','click', async ()=>{ await saveRoute(); });
  on('btnScheduleRoute','click', async ()=>{ await scheduleRouteStart(); });
  on('btnPrintRoute','click', async ()=>{ await printRoutePDF(); });
  on('btnDeleteRoute','click', async ()=>{ await deleteRoute(); });
  on('btnAutoGroupRoutes','click', async ()=>{ await autoGroupOrdersIntoRoutes(); });
  on('btnAddSelectedToRoute','click', async ()=>{ await addSelectedOrdersToRoute(); });
  on('routeAddSearch','input', ()=>{ renderRouteAddList(); });

  on('btnRefresh', 'click', async () => { await refreshAll(true); });
  on('scheduleRoute','change', () => renderSchedule());
  on('scheduleRunDate','change', () => renderSchedule());
  on('btnGenerateRun','click', async () => { await renderSchedule(); });
  on('btnPrintSchedule','click', () => window.print());
  // on('btnAutoAssign', 'click', async () => { await autoAssignCurrentWeek(); });  on('btnGeocode2', 'click', async () => { await geocodeMissingOrders(15); await renderMap(); });
  on('btnGoOrdersMap', 'click', () => switchView('ordersView'));

  on('btnGeocodeMissing', 'click', async () => {
    await geocodeMissingOrders(15);
    await refreshAll(false);
    await renderMap();
  });

  // NOTE: btnGoSchedule was removed from the simplified Home; keep wiring optional.
  on('btnGoRoute', 'click', () => switchView('routesView'));
  on('btnGoRoute2', 'click', () => switchView('routesView'));

  // week picker default
  const wp = $('weekPicker');
  if (wp){
    wp.value = toISODate(state.weekStart);
    wp.addEventListener('change', async () => {
      const d = parseISO(wp.value);
      state.weekStart = startOfWeek(d || new Date());
      wp.value = toISODate(state.weekStart);
      await refreshAll(false);
    });
  }

  // schedule + map + orders filters
  on('filterOperator', 'change', () => renderSchedule()); // legacy (optional)
  on('filterRange', 'change', () => renderSchedule());    // legacy (optional)

  on('scheduleDay', 'change', () => {
    // set a sensible default run date for the chosen day
    const sd = $('scheduleDay')?.value;
    const dow = sd === 'all' ? null : Number(sd);
    const rd = $('scheduleRunDate');
    if (rd && dow != null){
      // pick next occurrence of this day
      rd.value = toISODate(nextDateForDow(dow, new Date()));
    }
    renderSchedule();
  });
  on('scheduleRunDate', 'change', () => renderSchedule());
  on('btnGenerateRun', 'click', () => generateRunAssignments());
  on('mapCadence', 'change', () => renderMap());
  on('mapStatus', 'change', () => renderMap());
  on('ordersStatus', 'change', () => renderOrders());
  on('ordersShowArchived', 'change', () => renderOrders());
  on('ordersSearch', 'input', () => renderOrders());
  on('homeCadence', 'change', () => renderHome());
  on('homeAge', 'change', () => renderHome());
  on('homeSearch', 'input', () => renderHome());
  on('btnGoOrdersHome', 'click', () => switchView('ordersView'));
  on('btnPrintSchedule', 'click', () => printSchedulePDF());
  on('btnGoOrders', 'click', () => switchView('ordersView'));
  on('btnAutoGroupRoutesFromOrders', 'click', async () => { await autoGroupOrdersIntoRoutes(); switchView('routesView'); });
  on('btnAddOperator', 'click', async () => { await addOperator(); });

}

/* ========= Auth ========= */
function showAuth(){
  $('app').style.display='none';
  $('authGate').style.display='grid';
}
function showApp(){
  $('authGate').style.display='none';
  $('app').style.display='grid';
  refreshAll(true);
}

function showAuthMessage(msg){
  $('authMsg').textContent = msg || '';
}

async function loginWithPassword(){
  showAuthMessage('');
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  if (!email || !password) return showAuthMessage('Enter email + password');
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) showAuthMessage(error.message || 'Login failed');
}

async function sendMagicLink(){
  showAuthMessage('');
  const email = $('authEmail').value.trim();
  if (!email) return showAuthMessage('Enter your email');
  const { error } = await supabaseClient.auth.signInWithOtp({ email });
  if (error) showAuthMessage(error.message || 'Failed to send link');
  else showAuthMessage('Magic link sent. Check your email.');
}

/* ========= Navigation ========= */
function switchView(viewId){
  state.view = viewId;
  document.querySelectorAll('.view').forEach(v => v.style.display='none');
  const v = $(viewId);
  if (v) v.style.display = 'block';

  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === viewId));

  const titles = {
    homeView: ['Home', 'At-a-glance ops overview'],    mapView: ['Map', 'All intake orders on the map (hover for details)'],
    ordersView: ['Orders', 'Intake orders + status'],
    routesView: ['Routes', 'Build routes first, then assign an operator'],
    operatorsView: ['Operators', 'Manage payouts & capacity'],
  };
  const t = titles[viewId] || ['ProCan', ''];
  $('pageTitle').textContent = t[0];
  $('pageSub').textContent = t[1];

  if (viewId === 'mapView'){
    setTimeout(() => {
      ensureMap();
      try { state.map && state.map.invalidateSize(); } catch(e){}
      renderMap();
    }, 50);
  }
}

/* ========= Data ========= */
async function refreshAll(showBannerOnErrors){
  hideBanner();

  // Ensure essential tables exist by doing a lightweight select; show actionable banner if not.
  const required = ['operators','orders','assignments'];
  for (const table of required){
    const { error } = await supabaseClient.from(table).select('*', { count:'exact', head:true }).limit(1);
    if (error){
      if (showBannerOnErrors) {
        showBanner(`Missing or inaccessible table "${table}". Run the dashboard schema SQL (operators, orders, assignments) and ensure RLS allows authenticated access.`);
      }
      return;
    }
  }

  // Load
  const [opsRes, ordRes, asnRes] = await Promise.all([
    supabaseClient.from('operators').select('*').order('created_at', {ascending:true}),
    supabaseClient.from('orders').select('*').order('created_at', {ascending:false}).limit(1000),
    supabaseClient.from('assignments').select('*')
      .gte('service_date', toISODate(addDays(state.weekStart,-30)))
      .lte('service_date', toISODate(addDays(state.weekStart,60)))
      .order('service_date',{ascending:true})
      .order('stop_order',{ascending:true}),
  ]);

  if (opsRes.error) return showBanner(opsRes.error.message);
  if (ordRes.error) return showBanner(ordRes.error.message);
  if (asnRes.error) {
    const msg = asnRes.error.code === 'PGRST204'
      ? `Assignments query failed: ${asnRes.error.message}. This usually means a missing column (e.g., stop_order). Run the latest supabase-schema.sql patch (adds assignments.stop_order).`
      : asnRes.error.message;
    return showBanner(msg);
  }

  state.operators = opsRes.data || [];
  // Detect whether payout_rate is stored as percent (30) or fraction (0.30)
  try {
    const rates = (state.operators || []).map(o => Number(o.payout_rate)).filter(n => isFinite(n));
    const max = rates.length ? Math.max(...rates) : 30;
    state.payoutMode = (max <= 1) ? 'fraction' : 'percent';
  } catch(e) { state.payoutMode = 'percent'; }

  state.orders = ordRes.data || [];
  // Detect whether orders table supports route_operator_id (some DBs may not have this column yet)
  try {
    state.supportsRouteOperatorId = (state.orders.length > 0) ? Object.prototype.hasOwnProperty.call(state.orders[0], 'route_operator_id') : state.supportsRouteOperatorId;
  } catch(e) {}
  state.assignments = asnRes.data || [];


  await probeSchema();
  await loadRoutes();

  buildOperatorColors();
  hydrateFilters();

  renderHome();
  renderOrders();
  renderOperators();
  renderRoutes();
  renderRouteDetails();

  if (state.view === 'mapView') renderMap();
}

function buildOperatorColors(){
  const map = {};
  state.operators.forEach((o,i) => { map[o.id] = COLORS[i % COLORS.length]; });
  map['unassigned'] = '#9099a8';
  state.operatorColors = map;
}

function hydrateFilters(){
  const opSel = (el, includeAll=true) => {
    if (!el) return;
    el.innerHTML = '';
    if (includeAll) el.append(new Option('All operators', 'all'));
    state.operators.forEach(o => el.append(new Option(o.name, o.id)));
    if (!state.operators.length) el.append(new Option('No operators', 'none'));
  };

  opSel($('filterOperator'), true);

  const rangeSel = (el) => {
    if (!el) return;
    const current = el.value || 'week';
    el.innerHTML = '';
    el.append(new Option('Today', 'today'));
    el.append(new Option('This week', 'week'));
    el.append(new Option('This month', 'month'));
    if (['today','week','month'].includes(current)) el.value = current;
    else el.value = 'week';
  };
  rangeSel($('filterRange'));

  const statusSel = (el) => {
    if (!el) return;
    const current = el.value || 'all';
    el.innerHTML='';
    ['all','new','paid','scheduled','completed','cancelled'].forEach(s=>{
      el.append(new Option(s==='all'?'All statuses':s, s));
    });
    el.value = current;
  };

  const cadenceSel = (el) => {
    if (!el) return;
    const current = el.value || 'all';
    el.innerHTML='';
    el.append(new Option('All cadences','all'));
    el.append(new Option('biweekly','biweekly'));
    el.append(new Option('monthly','monthly'));
    el.append(new Option('weekly','weekly'));
    el.append(new Option('one-time','one-time'));
    el.value = current;
  };

  // Orders page status (route-first)
  const status = $('ordersStatus');
  if (status){
    const current = status.value || 'all';
    status.innerHTML='';
    const opts = [
      ['All statuses','all'],
      ['deposited','deposited'],
      ['on route','on route'],
      ['route active','route active'],
      ['needs deposit','needs deposit'],
      ['cancelled','cancelled'],
      ['archived','archived'],
    ];
    for (const [label,val] of opts) status.append(new Option(label,val));
    status.value = current;
  }

  // Home filters
  cadenceSel($('homeCadence'));
  const age = $('homeAge');
  if (age){
    const current = age.value || 'all';
    age.innerHTML='';
    age.append(new Option('All ages','all'));
    age.append(new Option('0–7 days','0-7'));
    age.append(new Option('8–14 days','8-14'));
    age.append(new Option('15–30 days','15-30'));
    age.append(new Option('31+ days','31+'));
    age.value = current;
  }

  // Map filters
  cadenceSel($('mapCadence'));
  statusSel($('mapStatus'));


  // Schedule controls
  const sd = $('scheduleDay');
  if (sd){
    const current = sd.value || 'all';
    sd.innerHTML='';
    sd.append(new Option('All days','all'));
    [1,2,3,4,5,6,0].forEach(d=> sd.append(new Option(dayName(d), String(d))));
    sd.value = current;
  }
  const rd = $('scheduleRunDate');
  if (rd && !rd.value){
    // default to next Monday
    rd.value = toISODate(nextDateForDow(1, new Date()));
  }

}

/* ========= Auto-assign =========
   Goal: take Intake orders and generate assignments for the current week.
   - Uses preferred_service_day + cadence (biweekly/monthly/weekly)
   - Ensures assignments exist for dates in the selected week
   - Assigns operator based on lowest load (simple and reliable)
*/
async function autoAssignCurrentWeek(){
  hideBanner();

  if (!state.operators.length){
    showBanner('Add at least one operator first (Operators tab).');
    switchView('operatorsView');
    return;
  }

  const weekStartISO = toISODate(state.weekStart);
  const weekEndISO = toISODate(addDays(state.weekStart,6));

  // Build load map
  const load = {};
  state.operators.forEach(o => load[o.id] = 0);
  state.assignments.forEach(a => {
    if (a.operator_id && load[a.operator_id] != null) load[a.operator_id] += 1;
  });

  // Get existing assignment keys to avoid duplicates
  const assignedKey = new Set(state.assignments.map(a => `${a.order_id}__${a.service_date}`));

  // Filter eligible orders
  const eligible = state.orders.filter(o => {
    const st = String(o.status||'new');
    if (st === 'cancelled') return false;
    // if start_date exists and is after week end, skip
    const sd = parseISO(o.start_date);
    if (sd && toISODate(sd) > weekEndISO) return false;
    return true;
  });

  // Determine which date in this week each order should be scheduled on
  const anchor = new Date('2026-04-01T00:00:00'); // stable anchor; can be moved later
  const weekIndex = Math.floor((startOfWeek(state.weekStart) - startOfWeek(anchor)) / (7*24*3600*1000));

  const inserts = [];
  for (const o of eligible){
    const cadence = String(o.cadence||'monthly').toLowerCase();
    const dow = normalizeDay(o.preferred_service_day) ?? 1; // default Monday
    // target date in week for this order
    let target = null;
    for (let i=0;i<7;i++){
      const d = addDays(state.weekStart, i);
      if (d.getDay() === dow) { target = d; break; }
    }
    if (!target) target = addDays(state.weekStart, 0);

    const targetISO = toISODate(target);

    // cadence rules:
    if (cadence.includes('bi')){
      // biweekly: schedule only on even weeks relative to anchor, but allow if already scheduled
      if (Math.abs(weekIndex) % 2 === 1) continue;
    } else if (cadence.includes('week')){
      // weekly always
    } else {
      // monthly: schedule only if target date is in same month as weekStart OR weekStart is within that month window
      const tMonth = target.getMonth();
      const tYear = target.getFullYear();
      const existingThisMonth = state.assignments.some(a => a.order_id === o.id && (() => {
        const ad = parseISO(a.service_date);
        return ad && ad.getMonth()===tMonth && ad.getFullYear()===tYear;
      })());
      if (existingThisMonth) continue;
    }

    // skip if already has assignment for this order on that date
    if (assignedKey.has(`${o.id}__${targetISO}`)) continue;

    // choose operator with lowest load
    const chosen = state.operators
      .filter(x => x.active !== false)
      .sort((a,b) => (load[a.id]||0) - (load[b.id]||0))[0];

    if (!chosen) continue;

    load[chosen.id] = (load[chosen.id]||0) + 1;

    inserts.push({
      order_id: o.id,
      operator_id: chosen.id,
      service_date: targetISO,
      sequence: load[chosen.id], // crude; will be normalized later
    });
  }

  if (!inserts.length){
    showBanner('Nothing new to auto-assign for this week.');
    return;
  }

  // Insert with upsert to avoid duplicates. Requires unique(order_id, service_date).
  const { error } = await supabaseClient.from('assignments').upsert(inserts, { onConflict: 'order_id,service_date' });
  if (error){
    // most common: unique constraint still on order_id only
    showBanner(`Auto-assign failed: ${error.message}. If it says duplicate key on order_id, update assignments unique constraint to (order_id, service_date).`);
    return;
  }

  await refreshAll(false);
  showBanner(`Auto-assigned ${inserts.length} stop(s).`);
}

/* ========= Home ========= */
function renderHome(){
  const orderById = new Map((state.orders||[]).map(o => [o.id, o]));
  const opsById = new Map((state.operators||[]).map(o => [o.id, o]));

  // ROUTE-FIRST KPIs (based on active routes)
  const activeRoutes = (state.routes||[]).filter(r => String(r.status||'').toLowerCase() === 'active');

  let gross = 0;
  let payouts = 0;
  let jobs = 0;
  const unique = new Set();

  for (const r of activeRoutes){
    const routeOrders = (state.orders||[]).filter(o => o.route_id === r.id);
    for (const ord of routeOrders){
      unique.add(ord.id);
      jobs += 1;
      const amt = Number(ord.monthly_total || ord.due_today || 0);
      gross += amt;

      const op = r.operator_id ? (opsById.get(r.operator_id) || null) : null;
      const rate = (op ? payoutToPercent(op.payout_rate) : 30) / 100;
      payouts += amt * rate;
    }
  }

  const profit = Math.max(0, gross - payouts);

  $('kpiGross').textContent = fmtMoney(gross);
  $('kpiProfit').textContent = fmtMoney(profit);
  $('kpiJobs').textContent = String(jobs);
  $('kpiPayouts').textContent = fmtMoney(payouts);

  attachKpiHover($('kpiGross')?.closest('.kpi'), `Profit: ${fmtMoney(profit)}  •  Payouts: ${fmtMoney(payouts)}`);
  attachKpiHover($('kpiProfit')?.closest('.kpi'), `Gross: ${fmtMoney(gross)}  •  Payouts: ${fmtMoney(payouts)}`);
  attachKpiHover($('kpiJobs')?.closest('.kpi'), `Active routes: ${activeRoutes.length}  •  Unique clients: ${unique.size}`);

  // Soonest available (based on active-route load per weekday)
  renderNextAvailable();

  // Home orders inbox (grouped)
  renderHomeOrdersInbox();

  // Workload visual (active routes vs total orders)
  const fill = $('workloadFill');
  const sub = $('workloadSub');
  if (fill && sub){
    const total = (state.orders||[]).length || 0;
    const activeStops = jobs;
    const pct = total ? Math.min(100, Math.round((activeStops / total) * 100)) : 0;
    fill.style.width = pct + '%';
    sub.textContent = `${activeStops} stops on active routes • ${total} total intake orders`;
  }
}

function normalizeCadence(c){
  const s = String(c||'').toLowerCase();
  if (!s) return '';
  if (s.includes('bi')) return 'biweekly';
  if (s.includes('month')) return 'monthly';
  if (s.includes('week')) return 'weekly';
  if (s.includes('one')) return 'one-time';
  return s;
}

function ageDaysFrom(order){
  const d = parseISO(order.created_at || order.created || order.order_created_at);
  if (!d) return null;
  const now = new Date(); now.setHours(0,0,0,0);
  const dd = new Date(d); dd.setHours(0,0,0,0);
  return Math.max(0, Math.round((now - dd) / 86400000));
}

function ageBucket(days){
  if (days === null) return 'unknown';
  if (days <= 7) return '0–7d';
  if (days <= 14) return '8–14d';
  if (days <= 30) return '15–30d';
  return '31+d';
}

function renderHomeOrdersInbox(){
  const wrap = $('homeOrdersTable');
  if (!wrap) return;

  const opsById = new Map((state.operators||[]).map(op=>[op.id, op]));

  const q = String($('homeSearch')?.value || '').toLowerCase();
  const cadFilter = $('homeCadence')?.value || 'all';
  const ageFilter = $('homeAge')?.value || 'all';

  let rows = state.orders.slice();
  const assignedSet = new Set(state.assignments.map(a => a.order_id));

  // Filters
  if (q){
    rows = rows.filter(o =>
      String(o.biz_name||o.business_name||'').toLowerCase().includes(q) ||
      String(o.address||'').toLowerCase().includes(q) ||
      String(o.id||'').toLowerCase().includes(q)
    );
  }
  if (cadFilter !== 'all'){
    rows = rows.filter(o => normalizeCadence(o.cadence) === cadFilter);
  }
  if (ageFilter !== 'all'){
    rows = rows.filter(o => {
      const d = ageDaysFrom(o);
      if (d === null) return false;
      if (ageFilter === '0-7') return d <= 7;
      if (ageFilter === '8-14') return d >= 8 && d <= 14;
      if (ageFilter === '15-30') return d >= 15 && d <= 30;
      if (ageFilter === '31+') return d >= 31;
      return true;
    });
  }

  // Compute group key: cadence + zip + age bucket
  const cadenceOrder = { 'biweekly': 0, 'monthly': 1, 'weekly': 2, 'one-time': 3, '': 9 };
  rows = rows.map(o => {
    const cad = normalizeCadence(o.cadence);
    const zip = zipFromAddress(o.address || '');
    const days = ageDaysFrom(o);
    const bucket = ageBucket(days);
    return { o, cad, zip, days, bucket, key: `${cad||'—'}|${zip||'—'}|${bucket}` };
  });

  rows.sort((a,b)=>{
    const ca = cadenceOrder[a.cad] ?? 9;
    const cb = cadenceOrder[b.cad] ?? 9;
    if (ca !== cb) return ca - cb;
    if (a.zip !== b.zip) return String(a.zip).localeCompare(String(b.zip));
    // oldest first so you can clear stale orders
    const ad = (a.days===null ? -1 : a.days);
    const bd = (b.days===null ? -1 : b.days);
    if (ad !== bd) return bd - ad;
    return String(b.o.created_at||'').localeCompare(String(a.o.created_at||''));
  });

  // Chips summary (quick clustering hints)
  const chips = $('homeGroupChips');
  if (chips){
    const byCad = {};
    const byAge = {};
    const byZip = {};
    for (const r of rows){
      byCad[r.cad || 'unknown'] = (byCad[r.cad || 'unknown']||0)+1;
      byAge[r.bucket] = (byAge[r.bucket]||0)+1;
      if (r.zip) byZip[r.zip] = (byZip[r.zip]||0)+1;
    }
    const topZips = Object.entries(byZip).sort((a,b)=>b[1]-a[1]).slice(0,3);
    chips.innerHTML = '';
    const chip = (label, val) => {
      const d = document.createElement('div');
      d.className = 'chip';
      d.innerHTML = `<b>${escapeHtml(label)}</b>${escapeHtml(String(val))}`;
      chips.append(d);
    };
    chip('Total', rows.length);
    if (byCad.biweekly) chip('Biweekly', byCad.biweekly);
    if (byCad.monthly) chip('Monthly', byCad.monthly);
    if (byCad.weekly) chip('Weekly', byCad.weekly);
    if (byCad['one-time']) chip('One-time', byCad['one-time']);
    if (byAge['31+d']) chip('31+d', byAge['31+d']);
    if (topZips.length){
      chip('Top ZIPs', topZips.map(([z,c])=>`${z}(${c})`).join(' • '));
    }
  }

  const html = [];
    html.push(`<table><thead><tr>
    <th>Business</th>
    <th>Address</th>
    <th>Cadence</th>
    <th>Route</th>
    <th>Operator</th>
    <th>Status</th>
  </tr></thead><tbody>`);

  let lastKey = null;
  for (const r of rows.slice(0, 600)){
    const o = r.o;
    if (r.key !== lastKey){
      const label = `${r.cad||'—'} • ${r.zip||'—'} • ${r.bucket}`;
      html.push(`<tr class="group-row"><td colspan="8">${escapeHtml(label)}</td></tr>`);
      lastKey = r.key;
    }
    const stage = stageLabelForOrder(o);
    html.push(`<tr class="clickable" data-order-id="${escapeHtml(o.id)}">
      <td>
        <div class="title">${escapeHtml(o.biz_name||o.business_name||o.contact_name||'')}</div>
        <div class="sub">${escapeHtml(fmtMoney(o.monthly_total || o.due_today || 0))} • ${escapeHtml(String((parseInt(String(o.cans ?? o.can_count ?? o.qty ?? ''),10)||0)))} can(s) • ${r.days===null?'—':escapeHtml(String(r.days)+'d old')}</div>
      </td>
      <td>${escapeHtml(o.address||'')}</td>
      <td>${escapeHtml(r.cad||o.cadence||'')}</td>
      <td>${renderRouteChipForOrder(o)}</td>
      <td>${escapeHtml(renderOperatorNameForOrder(o))}</td>
      <td>${escapeHtml(stage)}</td>
    </tr>`);
  }

  html.push(`</tbody></table>`);
  wrap.innerHTML = html.join('');

  // Row click: jump to Routes and focus this order in the route
  wrap.querySelectorAll('tr.clickable').forEach(tr=>{
    tr.addEventListener('click', async ()=>{
      const id = tr.dataset.orderId;
      if (id) await openOrderInRoute(id);
    });
  });
}
function renderNextAvailable(){
  const el = $('nextAvailable');
  const sub = $('nextAvailableSub');
  if (!el) return;

  // Heuristic: total stops per weekday capacity.
  const DAILY_STOP_CAPACITY = 10;
  const LOOKAHEAD_DAYS = 30;

  const today = new Date(); today.setHours(0,0,0,0);

  // Count stops per weekday from active routes (Mon–Fri)
  const activeRoutes = (state.routes||[]).filter(r => String(r.status||'').toLowerCase() === 'active');
  const weekdayStops = { 1:0, 2:0, 3:0, 4:0, 5:0 };
  for (const r of activeRoutes){
    const day = normalizeDay(r.service_day);
    if (day == null) continue;
    if (day === 0 || day === 6) continue;
    const stops = (state.orders||[]).filter(o => o.route_id === r.id).length;
    weekdayStops[day] = (weekdayStops[day]||0) + stops;
  }

  let chosen = null;
  for (let i=0;i<=LOOKAHEAD_DAYS;i++){
    const d = addDays(today, i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const used = weekdayStops[dow] || 0;
    if (used < DAILY_STOP_CAPACITY){
      chosen = { iso: toISODate(d), dow, used };
      break;
    }
  }

  if (!chosen){
    el.textContent = 'No openings';
    if (sub) sub.textContent = `Active routes are at capacity (≈${DAILY_STOP_CAPACITY} stops/day) for the next ${LOOKAHEAD_DAYS} days`;
    return;
  }

  el.textContent = chosen.iso;
  if (sub) sub.textContent = `${dayName(chosen.dow)} capacity: ${chosen.used}/${DAILY_STOP_CAPACITY} stops • Based on active routes`;
}


function attachKpiHover(cardEl, text){
  if (!cardEl) return;
  cardEl.setAttribute('data-hover','1');
  let hover = cardEl.querySelector('.kpi-hover');
  if (!hover){
    hover = document.createElement('div');
    hover.className = 'kpi-hover';
    cardEl.appendChild(hover);
  }
  hover.textContent = text;
}


function renderRow({title, sub, badges=[]}){
  const d = document.createElement('div');
  d.className = 'row';
  const left = document.createElement('div');
  left.className = 'left';
  left.innerHTML = `<div class="title">${escapeHtml(title)}</div><div class="sub">${escapeHtml(sub)}</div>`;
  const right = document.createElement('div');
  right.className = 'badges';
  badges.forEach(b => {
    const s = document.createElement('span');
    s.className = `badge ${b.cls||''}`;
    s.textContent = b.text;
    right.appendChild(s);
  });
  d.append(left, right);
  return d;
}

/* ========= Schedule ========= */
function getRangeWindow(range){
  const now = new Date();
  const todayISO = toISODate(now);
  if (range === 'today'){
    return { startISO: todayISO, endISO: todayISO, label: 'Today' };
  }
  if (range === 'month'){
    const d = new Date(state.weekStart);
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last = new Date(d.getFullYear(), d.getMonth()+1, 0);
    return { startISO: toISODate(first), endISO: toISODate(last), label: 'This month' };
  }
  // default week (based on week picker)
  return { startISO: toISODate(state.weekStart), endISO: toISODate(addDays(state.weekStart,6)), label: 'This week' };
}


function renderSchedule(){
  const board = $('scheduleBoard');
  if (!board) return;

  const runISO = $('scheduleRunDate')?.value || toISODate(new Date());
  const dow = isoDow(runISO);

  const orderById = new Map(state.orders.map(o => [o.id, o]));
  const opsById = new Map(state.operators.map(o => [o.id, o]));

  // Eligible orders: scheduled to this day and due on this run date
  const eligible = state.orders
    .filter(o => {
      const sd = (o?.service_day != null) ? Number(o.service_day) : normalizeDay(o?.service_day);
      if (sd == null) return false;
      if (dow != null && sd !== dow) return false;

      // deposit orders are only eligible once route_start_date is explicitly set (route activation)
      const isDeposit = (o?.is_deposit === true) || String(o?.is_deposit||'').toLowerCase()==='true';
      if (isDeposit && !o.route_start_date) return false;

      // only service paid orders (billing handled separately)
      const st = String(o?.status || 'new').toLowerCase();
      if (st !== 'paid') return false;

      return isOrderDueOnRunDate(o, runISO);
    });

  const existingForRun = state.assignments
    .filter(a => a.service_date === runISO);

  const asnByOrder = new Map(existingForRun.map(a => [a.order_id, a]));

  const rows = eligible
    .map(o => ({ order: o, asn: asnByOrder.get(o.id) || null }))
    .sort((x,y)=>{
      // Prefer stop_order if exists
      const ax = x.asn?.stop_order ?? 9999;
      const ay = y.asn?.stop_order ?? 9999;
      if (ax !== ay) return ax - ay;
      // stable fallback: by address then biz
      const adx = String(x.order.address||'');
      const ady = String(y.order.address||'');
      if (adx !== ady) return adx.localeCompare(ady);
      return String(x.order.biz_name||x.order.business_name||'').localeCompare(String(y.order.biz_name||y.order.business_name||''));
    });

  board.innerHTML = '';
  const table = document.createElement('div');
  table.className = 'schedule-table';

  const header = document.createElement('div');
  header.className = 'schedule-row header';
  header.innerHTML = `
    <div>Date</div>
    <div>Stop</div>
    <div>Operator</div>
    <div data-col="biz">Business</div>
    <div data-col="addr">Address</div>
    <div>Status</div>
    <div style="text-align:right;">Actions</div>
  `;
  table.appendChild(header);

  if (!rows.length){
    const empty = document.createElement('div');
    empty.className = 'schedule-row';
    empty.innerHTML = `<div class="muted" style="grid-column:1/-1;">No stops due on ${escapeHtml(runISO)} for the selected day. Assign service days below, then generate the run list.</div>`;
    table.appendChild(empty);
  } else {
    for (const r of rows){
      const ord = r.order;
      const a = r.asn;
      const op = a?.operator_id ? (opsById.get(a.operator_id) || {}) : {};
      const stop = (a?.stop_order != null) ? Number(a.stop_order) : '';
      const stage = stageLabelForOrder(ord); // uses explicit is_deposit now

      const row = document.createElement('div');
      row.className = 'schedule-row';
      row.dataset.assignmentId = a?.id || '';
      row.dataset.orderId = ord.id;

      row.innerHTML = `
        <div>${escapeHtml(runISO)}</div>
        <div>${escapeHtml(stop === '' ? '—' : String(stop))}</div>
        <div>${escapeHtml(op.name || 'Unassigned')}</div>
        <div data-col="biz">
          <div class="title">${escapeHtml(ord.biz_name || ord.business_name || ord.contact_name || 'Order')}</div>
          <div class="sub">${escapeHtml(String(ord.cadence||''))} • ${fmtMoney(ord.monthly_total || ord.due_today || 0)} • ${escapeHtml(stage)}</div>
        </div>
        <div data-col="addr" class="sub">${escapeHtml(ord.address || '')}</div>
        <div><span class="badge"><span class="dot"></span>${escapeHtml('due')}</span></div>
        <div class="actions">
          <button class="btn btn-mini ghost" data-action="edit" ${a?'' : 'disabled'}>Edit</button>
          <button class="btn btn-mini ghost" data-action="reassign" ${a?'' : 'disabled'}>Reassign</button>
          <button class="btn btn-mini outline" data-action="delete" ${a?'' : 'disabled'}>Delete</button>
        </div>
      `;
      table.appendChild(row);
    }
  }

  board.appendChild(table);

  // Row actions (only for existing assignments)
  table.querySelectorAll('button[data-action]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      if (btn.disabled) return;
      const action = btn.dataset.action;
      const row = btn.closest('.schedule-row');
      const id = row?.dataset.assignmentId;
      if (!id) return;
      if (action === 'delete') return deleteAssignment(id);
      if (action === 'edit') return editAssignment(id);
      if (action === 'reassign') return reassignAssignment(id);
    });
  });

  renderDayAssignBoard();
}


async function saveOrderSchedule(orderId, patch){
  try{
    // Guard against accidentally passing an object/stringified JSON instead of a UUID
    const idStr = String(orderId || '');
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(idStr)){
      showBanner('Could not save: invalid order id (selection bug).');
      return false;
    }
    const clean = sanitizeSchedulePatch(patch);
    const { data, error } = await supabaseClient
      .from('orders')
      .update(clean)
      .eq('id', idStr)
      .select('*');

    if (error){
      showBanner(fmtSbError(error));
      return false;
    }

    // Update local cache from returned row (source of truth)
    const row = Array.isArray(data) ? data[0] : data;
    const idx = state.orders.findIndex(o => String(o.id) === idStr);
    if (idx >= 0 && row) state.orders[idx] = row;

    hideBanner();
    return true;
  } catch (e){
    showBanner(String(e?.message || e));
    return false;
  }
}

function renderDayAssignBoard(){
  const board = $('dayAssignBoard');
  if (!board) return;

  // Optional: focus a single order when coming from Home
  const focusId = sessionStorage.getItem('focus_order_id') || '';

  const ops = state.operators || [];
  const dayOptions = [
    {label:'—', value:''},
    {label:'Mon', value:'1'},
    {label:'Tue', value:'2'},
    {label:'Wed', value:'3'},
    {label:'Thu', value:'4'},
    {label:'Fri', value:'5'},
    {label:'Sat', value:'6'},
    {label:'Sun', value:'0'},
  ];

  // Show only relevant orders (ignore cancelled)
  const visibleAll = state.orders
    .filter(o => o?.is_deleted !== true)
    .filter(o => !String(o.status||'').toLowerCase().startsWith('cancelled'))
    .slice(0, 500);

  const visible = focusId ? visibleAll.filter(o => String(o.id) === String(focusId)) : visibleAll;

  board.innerHTML = '';
  const table = document.createElement('div');
  table.className = 'schedule-table';

  const header = document.createElement('div');
  header.className = 'schedule-row header';
  header.innerHTML = `
    <div data-col="biz">Business</div>
    <div data-col="addr">Address</div>
    <div>Cadence</div>
    <div>Deposit</div>
    <div>Service day</div>
    <div>Route start</div>
    <div>Operator</div>
    <div style="text-align:right;">Save</div>
  `;
  table.appendChild(header);

  if (!visible.length){
    const empty = document.createElement('div');
    empty.className = 'schedule-row';
    empty.innerHTML = `<div class="muted" style="grid-column:1/-1;">No orders yet.</div>`;
    table.appendChild(empty);
  } else {
    for (const o of visible){
      const row = document.createElement('div');
      row.className = 'schedule-row';
      row.dataset.orderId = o.id;
      if (focusId && String(o.id) === String(focusId)) row.classList.add('focused');

      const sdVal = (o.service_day != null) ? String(o.service_day) : '';
      const startVal = o.route_start_date ? String(o.route_start_date).slice(0,10) : '';
      const isDeposit = (o?.is_deposit === true) || String(o?.is_deposit||'').toLowerCase()==='true';

      const opSel = document.createElement('select');
      opSel.className = 'input';
      opSel.style.height = '34px';
      opSel.append(new Option('Unassigned',''));
      ops.forEach(op => opSel.append(new Option(op.name, op.id)));
      if (state.supportsRouteOperatorId){
        opSel.value = o.route_operator_id || '';
      } else {
        opSel.value = '';
        opSel.disabled = true;
        opSel.title = "Operator preference column missing in Supabase orders table. Add route_operator_id (uuid) to enable per-order operator selection.";
      }

      const daySel = document.createElement('select');
      daySel.className = 'input';
      daySel.style.height = '34px';
      dayOptions.forEach(d => daySel.append(new Option(d.label, d.value)));
      daySel.value = sdVal;

      const startInput = document.createElement('input');
      startInput.type = 'date';
      startInput.className = 'input';
      startInput.value = startVal;

      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn btn-mini outline';
      saveBtn.textContent = 'Save';

      // layout cells
      const biz = escapeHtml(o.biz_name || o.business_name || o.contact_name || 'Order');
      const addr = escapeHtml(o.address || '');
      const cad = escapeHtml(String(o.cadence || ''));
      const dep = isDeposit ? `<span class="badge amber"><span class="dot"></span>deposit</span>` : `<span class="badge"><span class="dot"></span>no</span>`;

      row.innerHTML = `
        <div data-col="biz"><div class="title">${biz}</div><div class="sub">${fmtMoney(o.monthly_total || o.due_today || 0)}</div></div>
        <div data-col="addr" class="sub">${addr}</div>
        <div>${cad}</div>
        <div>${dep}</div>
        <div class="cell-day"></div>
        <div class="cell-start"></div>
        <div class="cell-op"></div>
        <div class="actions cell-save"></div>
      `;
      row.querySelector('.cell-day').appendChild(daySel);
      row.querySelector('.cell-start').appendChild(startInput);
      row.querySelector('.cell-op').appendChild(opSel);
      row.querySelector('.cell-save').appendChild(saveBtn);

      const gatherPatch = () => {
        const patch = {};
        patch.service_day = daySel.value === '' ? null : Number(daySel.value);
        patch.route_start_date = startInput.value ? startInput.value : null;
        if (state.supportsRouteOperatorId) patch.route_operator_id = opSel.value || null;
        return patch;
      };

      saveBtn.addEventListener('click', async ()=>{
        const ok = await saveOrderSchedule(o.id, gatherPatch());
        if (!ok) return;
        // pull latest data so Home/Orders reflect updates immediately
        await refreshAll(false);
        // keep user on schedule view, but refresh relevant panels
        renderSchedule();
        renderHome();
        renderOrders();
      });

      table.appendChild(row);
    }
  }

  board.appendChild(table);

  // Scroll focus row into view once rendered, then clear focus so the view returns to normal next time
  if (focusId){
    const el = board.querySelector(`.schedule-row.focused`);
    if (el) el.scrollIntoView({ behavior:'smooth', block:'center' });
    sessionStorage.removeItem('focus_order_id');
  }
}

async function generateRunAssignments(){
  const runISO = $('scheduleRunDate')?.value;
  if (!runISO) return showBanner('Pick a run date first.');
  const dow = isoDow(runISO);

  // Build due list in the same order as renderSchedule uses
  const due = state.orders
    .filter(o => {
      const sd = (o?.service_day != null) ? Number(o.service_day) : normalizeDay(o?.service_day);
      if (sd == null || sd !== dow) return false;

      const isDeposit = (o?.is_deposit === true) || String(o?.is_deposit||'').toLowerCase()==='true';
      if (isDeposit && !o.route_start_date) return false;

      const st = String(o?.status || 'new').toLowerCase();
      if (st !== 'paid') return false;

      return isOrderDueOnRunDate(o, runISO);
    })
    .sort((a,b)=>{
      const adx = String(a.address||'');
      const ady = String(b.address||'');
      if (adx !== ady) return adx.localeCompare(ady);
      return String(a.biz_name||a.business_name||'').localeCompare(String(b.biz_name||b.business_name||''));
    });

  if (!due.length){
    showBanner('No due stops for that run date.');
    return;
  }

  const existing = state.assignments.filter(a => a.service_date === runISO);
  const existingByOrder = new Map(existing.map(a => [a.order_id, a]));
  let nextStop = existing.reduce((m,a)=>Math.max(m, Number(a.stop_order||0)), 0) + 1;

  const upserts = [];
  for (const o of due){
    const ex = existingByOrder.get(o.id);
    upserts.push({
      id: ex?.id, // keep id if present
      order_id: o.id,
      service_date: runISO,
      operator_id: o.route_operator_id || ex?.operator_id || null,
      stop_order: (ex?.stop_order != null) ? Number(ex.stop_order) : nextStop++
    });
  }

  const { error } = await supabaseClient.from('assignments').upsert(upserts, { onConflict: 'order_id,service_date' });
  if (error){
    showBanner(fmtSbError(error));
    return;
  }
  await refreshAll(false);
  renderSchedule();
}

async function deleteAssignment(id){
  if (!confirm('Delete this scheduled job?')) return;
  const { error } = await supabaseClient.from('assignments').delete().eq('id', id);
  if (error) return showBanner(fmtSbError(error));
  await refreshAll(false);
}

async function editAssignment(id){
  const a = state.assignments.find(x => x.id === id);
  if (!a) return;
  const newDate = prompt('Service date (YYYY-MM-DD):', a.service_date);
  if (!newDate) return;
  const { error } = await supabaseClient.from('assignments').update({ service_date: newDate }).eq('id', id);
  if (error) return showBanner(fmtSbError(error));
  await refreshAll(false);
}

async function reassignAssignment(id){
  const a = state.assignments.find(x => x.id === id);
  if (!a) return;
  const options = ['unassigned', ...state.operators.map(o=>o.id)].join(',');
  const newOp = prompt(`Operator id (or "unassigned"):
${options}`, a.operator_id || 'unassigned');
  if (!newOp) return;
  const opId = newOp === 'unassigned' ? null : newOp;
  const { error } = await supabaseClient.from('assignments').update({ operator_id: opId }).eq('id', id);
  if (error) return showBanner(fmtSbError(error));
  await refreshAll(false);
}



function printSchedulePDF(){
  const runISO = $('scheduleRunDate')?.value || toISODate(new Date());
  const orderById = new Map(state.orders.map(o => [o.id, o]));
  const opsById = new Map(state.operators.map(o => [o.id, o]));

  const rows = state.assignments
    .filter(a => a.service_date === runISO)
    .sort((a,b)=> (Number(a.stop_order||0)-Number(b.stop_order||0)));

  const title = `ProCan Run Sheet — ${runISO}`;

  const w = window.open('', '_blank');
  if (!w) return;

  w.document.write(`
    <html><head><title>${escapeHtml(title)}</title>
    <style>
      body{font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding:18px;}
      h1{font-size:18px;margin:0 0 8px;}
      .sub{color:#555;margin:0 0 14px;font-size:12px;}
      table{width:100%;border-collapse:collapse;font-size:12px;}
      th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top;}
      th{background:#f7f7f7;}
      .muted{color:#666;}
    </style>
    </head><body>
      <div class="brand">ProCan Sanitation LLC</div>
      <h1>${escapeHtml(title)}</h1>
      <p class="sub">Generated from ProCan dashboard</p>
      <table>
        <thead><tr><th>Stop</th><th>Operator</th><th>Business</th><th>Address</th><th>Cadence</th></tr></thead>
        <tbody>
          ${rows.map(a=>{
            const o = orderById.get(a.order_id) || {};
            const op = a.operator_id ? (opsById.get(a.operator_id) || {}) : {};
            return `<tr>
              <td>${escapeHtml(String(a.stop_order||''))}</td>
              <td>${escapeHtml(op.name||'Unassigned')}</td>
              <td>${escapeHtml(o.biz_name||o.business_name||o.contact_name||'')}</td>
              <td class="muted">${escapeHtml(o.address||'')}</td>
              <td class="muted">${escapeHtml(String(o.cadence||''))}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <script>window.print();<\/script>
    </body></html>
  `);
  w.document.close();
}



/* ========= Orders ========= */
function renderOrders(){
  const wrap = $('ordersTable');
  if (!wrap) return;

  const status = $('ordersStatus')?.value || 'all';
  const showArchived = $('ordersShowArchived')?.checked === true;
  const q = String($('ordersSearch')?.value || '').toLowerCase();

  let rows = state.orders.slice();
  if (!showArchived) rows = rows.filter(o => o?.is_deleted !== true);
  if (status !== 'all') rows = rows.filter(o => stageLabelForOrder(o) === status);
  if (q) rows = rows.filter(o =>
    String(o.biz_name||o.business_name||'').toLowerCase().includes(q) ||
    String(o.address||'').toLowerCase().includes(q) ||
    String(o.order_id||o.id||'').toLowerCase().includes(q)
  );

  const html = [];
  html.push(`<table><thead><tr>
    <th>Business</th>
    <th>Address</th>
    <th>Cadence</th>
    <th>Cans</th>
    <th>Preferred day</th>
    <th>Monthly</th>
    <th>Status</th>
    <th>Actions</th>
  </tr></thead><tbody>`);

  for (const o of rows.slice(0, 400)){
    html.push(`<tr data-order-id="${escapeHtml(o.id)}">
      <td>${escapeHtml(o.biz_name||o.business_name||o.contact_name||'')}</td>
      <td>${escapeHtml(o.address||'')}</td>
      <td>${escapeHtml(o.cadence||'')}</td>
      <td>${escapeHtml(String((parseInt(String(o.cans ?? o.can_count ?? o.qty ?? ''),10)||0)))} </td>
      <td>${escapeHtml(o.preferred_service_day||'')}</td>
      <td>${escapeHtml(fmtMoney(o.monthly_total || o.due_today || 0))}</td>
      <td>${escapeHtml(stageLabelForOrder(o))}</td>
      <td>
        <button class="btn btn-mini ghost" data-act="route">Open route</button>
        <button class="btn btn-mini" data-act="cancel">Cancel</button>
        <button class="btn btn-mini outline" data-act="archive">Archive</button>
      </td>
    </tr>`);
  }
  html.push(`</tbody></table>`);
  wrap.innerHTML = html.join('');

  wrap.querySelectorAll('button[data-act]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const tr = btn.closest('tr');
      const orderId = tr?.dataset.orderId;
      if (!orderId) return;
      const act = btn.dataset.act;
      if (act === 'route') return openOrderInRoute(orderId);
      if (act === 'cancel') return cancelOrder(orderId);
      if (act === 'archive') return archiveOrder(orderId);
    });
  });
}

async function archiveOrder(orderId){
  if (!confirm('Archive this order? It will be hidden from the dashboard unless “Show archived” is enabled.')) return;
  const patch = { is_deleted: true, deleted_at: new Date().toISOString() };
  // Keep status as-is unless it's empty
  const o = state.orders.find(x => String(x.id) === String(orderId));
  if (o && !o.status) patch.status = 'archived';
  const { error } = await supabaseClient.from('orders').update(patch).eq('id', orderId);
  if (error) return showBanner(fmtSbError(error));
  toast('Order archived','ok');
  await refreshAll(false);
}

async function cancelOrder(orderId){
  const o = state.orders.find(x => String(x.id) === String(orderId));
  if (!o) return;

  // Infer cancel mode
  let mode = 'before_start';
  const rid = o.route_id;
  if (rid){
    const r = (state.routes||[]).find(x => x.id === rid);
    const start = r?.service_start_date ? String(r.service_start_date).slice(0,10) : '';
    const today = toISODate(new Date());
    if (start && today >= start) mode = 'after_start';
  }

  if (!confirm(`Cancel this order (${mode.replace('_',' ')})? Deposit is forfeited if cancelled before route begins.`)) return;

  // Cancel Stripe subscription via same-origin /api (secured by PROCAN_ROUTE_TOKEN).
  const token = (localStorage.getItem('PROCAN_ROUTE_TOKEN') || '').trim();
  if (token){
    try{
      const resp = await fetch('/api/order-cancel', {
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          'Authorization':'Bearer ' + token
        },
        body: JSON.stringify({ order_id: o.id, mode })
      });
      const data = await resp.json().catch(()=> ({}));
      if (!resp.ok){
        toast('Stripe cancel failed: ' + (data.error || resp.status), 'warn');
      }
    }catch(e){
      toast('Stripe cancel failed to fetch', 'warn');
    }
  } else {
    toast('Cancelled locally (no PROCAN_ROUTE_TOKEN set to cancel Stripe).', 'warn');
  }

  // Update Supabase order status
  const status = (mode === 'after_start') ? 'cancelled_active' : 'cancelled_before_start';
  const { error } = await supabaseClient.from('orders').update({ status, cancelled_at: new Date().toISOString() }).eq('id', orderId);
  if (error) return showBanner(fmtSbError(error));
  await refreshAll(false);
}


/* ========= Operators ========= */
let selectedOperatorId = null;

function renderOperators(){
  const list = $('operatorsList');
  const editor = $('operatorEditor');
  if (!list || !editor) return;

  list.innerHTML = '';

  if (!state.operators.length){
    list.innerHTML = `<div class="muted">No operators yet. Click “Add operator”.</div>`;
    editor.innerHTML = `<div class="muted">Select an operator…</div>`;
    return;
  }

  state.operators.forEach(o => {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cursor = 'pointer';
    row.innerHTML = `
      <div class="left">
        <div class="title">${escapeHtml(o.name)}</div>
        <div class="sub">Payout: ${Number(o.payout_rate||30).toFixed(1)}% • ${o.active===false?'Inactive':'Active'}</div>
      </div>
      <div class="badges">
        <button class="btn btn-mini ghost" data-op="${o.id}" data-act="select">Edit</button>
        <button class="btn btn-mini outline" data-op="${o.id}" data-act="delete">Remove</button>
      </div>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll('button[data-act]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const opId = btn.dataset.op;
      const act = btn.dataset.act;
      if (act === 'select') return selectOperator(opId);
      if (act === 'delete') return deleteOperator(opId);
    });
  });

  if (selectedOperatorId) selectOperator(selectedOperatorId);
  else editor.innerHTML = `<div class="muted">Select an operator…</div>`;
}

function selectOperator(opId){
  selectedOperatorId = opId;
  const o = state.operators.find(x => x.id === opId);
  const editor = $('operatorEditor');
  if (!o || !editor) return;

  editor.innerHTML = `
    <label class="field">
      <span>Name</span>
      <input id="opName" value="${escapeHtml(o.name||'')}" />
    </label>
    <label class="field">
      <span>Payout rate (%)</span>
      <input id="opRate" type="number" step="0.1" value="${escapeHtml(String(payoutToPercent(o.payout_rate ?? 30))) }" />
    </label>
    <label class="field">
      <span>Active</span>
      <select id="opActive">
        <option value="true">Active</option>
        <option value="false">Inactive</option>
      </select>
    </label>
    <div class="auth-actions">
      <button class="btn primary" id="btnSaveOp">Save</button>
    </div>
    <div class="muted" style="margin-top:10px;">Operator ID: ${escapeHtml(o.id)}</div>
  `;

  const activeSel = editor.querySelector('#opActive');
  if (activeSel) activeSel.value = (o.active===false) ? 'false' : 'true';

  editor.querySelector('#btnSaveOp')?.addEventListener('click', async ()=>{
    const name = editor.querySelector('#opName')?.value?.trim();
    const rate = Number(editor.querySelector('#opRate')?.value || 30);
    const active = editor.querySelector('#opActive')?.value === 'true';
    const { error } = await supabaseClient.from('operators').update({ name, payout_rate: payoutFromPercent(rate), active }).eq('id', o.id);
    if (error) return showBanner(fmtSbError(error));
    await refreshAll(false);
  });
}

async function addOperator(){
  const name = prompt('Operator name:');
  if (!name) return;
  const rate = Number(prompt('Payout rate (%):', '30') || 30);
  const { error } = await supabaseClient.from('operators').insert({ name, payout_rate: payoutFromPercent(rate), active: true });
  if (error) return showBanner(fmtSbError(error));
  await refreshAll(false);
  // select the newest
  selectedOperatorId = state.operators[state.operators.length-1]?.id || null;
}

async function deleteOperator(opId){
  const o = state.operators.find(x=>x.id===opId);
  if (!o) return;
  if (!confirm(`Remove operator "${o.name}"?`)) return;
  const { error } = await supabaseClient.from('operators').delete().eq('id', opId);
  if (error) return showBanner(fmtSbError(error));
  if (selectedOperatorId === opId) selectedOperatorId = null;
  await refreshAll(false);
}

/* ========= Map ========= */
function ensureMap(){
  if (state.map) return state.map;

  const mapEl = $('map');
  if (!mapEl) return null;

  const map = L.map(mapEl, { zoomControl:true });
  state.map = map;

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  // default view Midwest
  map.setView([39.1, -94.58], 10);

  // Fix leaflet default icon path (Vercel sometimes breaks)
  const iconRetinaUrl = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png';
  const iconUrl = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png';
  const shadowUrl = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png';
  L.Icon.Default.mergeOptions({ iconRetinaUrl, iconUrl, shadowUrl });

  return map;
}

async function renderMap(){
  ensureMap();
  if (!state.map) return;

  // Leaflet needs this when shown from a hidden tab
  try { state.map.invalidateSize(); } catch(e){}

  clearMapLayers();

  const cad = $('mapCadence')?.value || 'all';
  const st = $('mapStatus')?.value || 'all';

  // Filter orders
  let rows = state.orders.slice();
  if (cad !== 'all') rows = rows.filter(o => normalizeCadence(o.cadence) === cad);
  if (st !== 'all') rows = rows.filter(o => String(o.status||'new') === st);

  const assignedSet = new Set(state.assignments.map(a => a.order_id));

  // Marker colors by cadence (simple + readable)
  const colorFor = (o) => {
    const c = normalizeCadence(o.cadence);
    if (c === 'biweekly') return getCssVar('--brand') || '#28c7ff';
    if (c === 'monthly') return getCssVar('--brand2') || '#ffb020';
    if (c === 'weekly') return '#a78bfa';
    if (c === 'one-time') return '#9ca3af';
    return '#9099a8';
  };

  const points = [];
  for (const ord of rows){
    const lat = Number(ord.lat);
    const lng = Number(ord.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const title = ord.biz_name || ord.business_name || ord.contact_name || 'Order';
    const days = ageDaysFrom(ord);
    const bucket = ageBucket(days);
    const zip = zipFromAddress(ord.address||'');
    const stage = stageLabelForOrder(ord);
    const popup = `
      <div style="min-width:240px">
        <div style="font-weight:800; margin-bottom:4px;">${escapeHtml(title)}</div>
        <div style="color:rgba(255,255,255,0.72); font-size:12px; margin-bottom:8px;">${escapeHtml(ord.address||'')}</div>
        <div style="font-size:12px; line-height:1.45;">
          <div><b>Cadence:</b> ${escapeHtml(normalizeCadence(ord.cadence) || ord.cadence || '—')}</div>
          <div><b>Preferred day:</b> ${escapeHtml(ord.preferred_service_day||'—')}</div>
          <div><b>Status:</b> ${escapeHtml(stage)}</div>
          <div><b>Monthly:</b> ${escapeHtml(fmtMoney(ord.monthly_total || ord.due_today || 0))}</div>
          <div><b>Age:</b> ${days===null ? '—' : escapeHtml(days+'d')} <span style="opacity:.7">(${escapeHtml(bucket)})</span></div>
          <div><b>ZIP:</b> ${escapeHtml(zip||'—')}</div>
        </div>
      </div>
    `;

    const color = colorFor(ord);
    const marker = L.circleMarker([lat,lng], {
      radius: 8,
      color: color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.85
    }).addTo(state.map);

    // Hover tooltip (sticky) as requested
    marker.bindTooltip(popup, { sticky:true, direction:'top', opacity:0.98, className:'map-tooltip' });

    state.mapLayers.markers.push(marker);
    points.push([lat,lng]);
  }

  const empty = $('mapEmpty');
  if (!points.length){
    if (empty) empty.style.display = 'grid';
    state.map.setView([39.1, -94.58], 10);
    return;
  }
  if (empty) empty.style.display = 'none';

  const bounds = L.latLngBounds(points);
  state.map.fitBounds(bounds.pad(0.18));
}

function getCssVar(name){
  try{
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }catch(e){
    return '';
  }
}
function clearMapLayers(){
  (state.mapLayers.markers||[]).forEach(m => { try{ m.remove(); }catch(_){} });
  (state.mapLayers.lines||[]).forEach(l => { try{ l.remove(); }catch(_){} });
  state.mapLayers = { markers: [], lines: [] };
}

/* ========= Geocoding ========= */
async function geocodeMissingOrders(limit=15){
  hideBanner();

  const missing = state.orders.filter(o => {
    const lat = Number(o.lat), lng = Number(o.lng);
    return (!Number.isFinite(lat) || !Number.isFinite(lng)) && o.address;
  }).slice(0, limit);

  if (!missing.length){
    showBanner('No orders missing coordinates.');
    return;
  }

  let updated = 0;
  for (const o of missing){
    const res = await geocodeAddress(o.address);
    if (!res) continue;

    const { error } = await supabaseClient
      .from('orders')
      .update({ lat: res.lat, lng: res.lng, zone: zipFromAddress(o.address) || null })
      .eq('id', o.id);

    if (!error) updated++;
    await sleep(450);
  }

  showBanner(`Geocoded ${updated}/${missing.length} order(s).`);
}

async function geocodeAddress(address){
  try{
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`;
    const r = await fetch(url, { headers: { 'Accept':'application/json' }});
    if (!r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j) || !j[0]) return null;
    const lat = Number(j[0].lat), lng = Number(j[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch(_){
    return null;
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ========= Banner ========= */
function showBanner(msg){
  const b = $('banner');
  b.textContent = msg || '';
  b.style.display = msg ? 'block' : 'none';
}
function hideBanner(){ showBanner(''); }

/* ========= HTML escape ========= */
function escapeHtml(str){
  return String(str ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}


function weekStartMonday(date){
  // Returns a Date at Monday 00:00 local time for the week containing `date`.
  const d = new Date(date);
  d.setHours(0,0,0,0);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day); // shift to Monday
  d.setDate(d.getDate() + diff);
  return d;
}


function buildRoutesWeekFilter(){
  const sel = document.getElementById('routesWeekFilter');
  if (!sel) return;
  const routes = state.routes || [];
  const weeks = new Map(); // iso -> label
  for (const r of routes){
    const prog = computeRouteReadiness(r);
    const pct = prog.pct;

    if (!r.created_at) continue;
    const ws = toISODate(weekStartMonday(new Date(r.created_at)));
    if (!weeks.has(ws)) weeks.set(ws, ws);
  }
  const opts = Array.from(weeks.keys()).sort().reverse();
  const current = state.routesWeek || 'all';
  sel.innerHTML = `<option value="all">All weeks</option>` + opts.map(w=>`<option value="${w}">Week of ${w}</option>`).join('');
  sel.value = opts.includes(current) ? current : 'all';
  state.routesWeek = sel.value;
  sel.onchange = ()=>{
    state.routesWeek = sel.value;
    renderRoutes();
  };
}

async function loadRoutes(){
  state.routes = [];
  if (!state.supportsRoutes) return;
  const { data, error } = await supabaseClient.from('routes')
    .select('id,name,service_day,status,target_cans,operator_id,created_at,service_start_date,cadence,last_service_date')
    .order('created_at', { ascending:false });
  if (error) { console.warn('loadRoutes', error); return; }
  state.routes = data || [];
  buildRoutesWeekFilter();
}

function renderRoutes(){
  const list = document.getElementById('routesList');
  if (!list) return;
  list.innerHTML = '';
  let routes = state.routes || [];
  // Week filter (by created_at week, Monday start)
  const wk = state.routesWeek || 'all';
  if (wk !== 'all'){
    const start = weekStartMonday(new Date(wk));
    const end = new Date(start); end.setDate(end.getDate()+7);
    routes = routes.filter(r=>{
      if (!r.created_at) return false;
      const c = new Date(r.created_at);
      return c >= start && c < end;
    });
  }
  if (!routes.length){
    list.innerHTML = '<div class="muted">No routes yet. Click New Route.</div>';
    return;
  }
  for (const r of routes){
    const prog = computeRouteReadiness(r);
    const pct = prog.pct;

    const div = document.createElement('div');
    div.className = 'row';
    div.style.cursor='pointer';
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
        <div>
          <div style="font-weight:700;">${escapeHtml(r.name || '(Unnamed Route)')}</div>
          <div class="muted">${escapeHtml(r.service_day||'')} • ${escapeHtml(r.status||'draft')}</div>
          <div class="progressLine" style="margin-top:10px;"><span style="width:${pct}%;"></span></div>
          <div class="muted" style="margin-top:6px;">${prog.assignedCans}/${prog.targetCans||0} cans</div>
        </div>
        <div class="chip">${(r.target_cans||'') ? `${r.target_cans} cans` : ''}</div>
      </div>`;
    div.addEventListener('click', ()=>{
      state.selectedRouteId = r.id;
      renderRouteDetails();
    });
    list.appendChild(div);
  }
}

function renderRouteDetails(){
  const empty = document.getElementById('routeDetailsEmpty');
  const wrap = document.getElementById('routeDetails');
  if (!empty || !wrap) return;

  const rid = state.selectedRouteId;
  const r = (state.routes||[]).find(x=>x.id===rid);
  if (!r){
    empty.style.display='block';
    wrap.style.display='none';
    return;
  }

  empty.style.display='none';
  wrap.style.display='block';

  // Readiness indicator
  const prog = computeRouteReadiness(r);
  const pctEl = document.getElementById('routeReadinessPct');
  const barEl = document.getElementById('routeReadinessBar');
  const hintEl = document.getElementById('routeReadinessHint');
  if (pctEl) pctEl.textContent = String(prog.pct);
  if (barEl) barEl.style.width = prog.pct + '%';
  if (hintEl){
    hintEl.textContent = (prog.pct >= 100) ? 'Ready to activate.' : (prog.reasons[0] ? ('Next: ' + prog.reasons[0]) : '');
  }

  document.getElementById('routeName').value = r.name || '';
  document.getElementById('routeServiceDay').value = r.service_day || 'Monday';
  document.getElementById('routeStatus').value = r.status || 'draft';
  document.getElementById('routeTargetCans').value = r.target_cans || '';
  // Cadence + schedule dates
  const cadEl = document.getElementById('routeCadence');
  if (cadEl) cadEl.value = (r.cadence || 'biweekly');
  const startEl = document.getElementById('routeStartDate');
  if (startEl) startEl.value = (r.service_start_date || '');
  const nextEl = document.getElementById('routeNextServiceDate');
  const next2El = document.getElementById('routeNextNextServiceDate');
  const nd = computeNextServiceDates(r);
  if (nextEl) nextEl.value = nd.next ? fmtDateLong(nd.next) : '—';
  if (next2El) next2El.textContent = nd.next2 ? ('Next next: ' + fmtDateLong(nd.next2)) : '';

  // Operator dropdown
  const sel = document.getElementById('routeOperator');
  if (sel){
    sel.innerHTML = '<option value="">(unassigned)</option>' + (state.operators||[]).map(o=>`<option value="${o.id}">${escapeHtml(o.name||o.full_name||o.email||o.id)}</option>`).join('');
    sel.value = r.operator_id || '';
  }

  // List orders in route (stop order = list order)
  const ro = document.getElementById('routeOrders');
  if (ro){
    const orders = (state.orders||[]).filter(o=>o.route_id===rid);
    if (!orders.length){
      ro.innerHTML = '<div class="muted">No orders assigned to this route yet.</div>';
    } else {
      const focusId = sessionStorage.getItem('focus_order_id') || '';
      ro.innerHTML = orders.map((o, idx)=>{
        const focus = focusId && String(o.id) === String(focusId);
        const stop = idx + 1;
        const cadence = o.cadence || o.service_frequency || o.frequency || '';
        return `
          <div class="row ${focus?'highlight':''}" data-order-id="${escapeHtml(o.id)}">
            <div style="display:flex;justify-content:space-between;gap:12px;">
              <div>
                <div style="font-weight:700;">${escapeHtml(stop + '. ' + (o.business_name||o.biz_name||o.name||'Order'))}</div>
                <div class="muted">${escapeHtml(o.address||o.location||'')}</div>
              </div>
              <div class="muted">${escapeHtml(String((parseInt(String(o.cans ?? o.can_count ?? o.qty ?? ''),10)||0)))} can(s) • ${escapeHtml(cadence)}</div>
            </div>
          </div>
        `;
      }).join('');

      const focusRow = ro.querySelector('.row.highlight');
      if (focusRow){
        focusRow.scrollIntoView({ block:'center', behavior:'smooth' });
      }
    }
  }

  // Refresh "Add orders" list under the editor
  renderRouteAddList();
}


function renderRouteAddList(){
  const list = document.getElementById('routeAddList');
  const rid = state.selectedRouteId;
  if (!list || !rid) return;

  const q = String(document.getElementById('routeAddSearch')?.value || '').toLowerCase();
  const unassigned = (state.orders||[])
    .filter(o => !o.route_id)
    .filter(o => stageLabelForOrder(o) === 'deposited');

  const filtered = q ? unassigned.filter(o =>
    String(o.biz_name||o.business_name||o.contact_name||'').toLowerCase().includes(q) ||
    String(o.address||'').toLowerCase().includes(q) ||
    String(o.id||'').toLowerCase().includes(q)
  ) : unassigned;

  if (!filtered.length){
    list.innerHTML = '<div class="muted">No unassigned deposited orders.</div>';
    return;
  }

  const focusId = sessionStorage.getItem('focus_order_id') || '';

  list.innerHTML = filtered.slice(0,400).map(o=>{
    const name = o.biz_name||o.business_name||o.contact_name||'Order';
    const addr = o.address || '';
    const checked = focusId && String(o.id) === String(focusId) ? 'checked' : '';
    return `
      <label class="row" style="align-items:flex-start; gap:10px;">
        <input type="checkbox" class="routeAddChk" data-order-id="${escapeHtml(o.id)}" ${checked}/>
        <div style="flex:1;">
          <div style="font-weight:700;">${escapeHtml(name)}</div>
          <div class="muted">${escapeHtml(addr)}</div>
        </div>
        <div class="muted">${escapeHtml(String((parseInt(String(o.cans ?? o.can_count ?? o.qty ?? ''),10)||0)))} can(s) • ${escapeHtml(o.cadence||'')}</div>
      </label>
    `;
  }).join('');
}

async function addSelectedOrdersToRoute(){
  const rid = state.selectedRouteId;
  if (!rid) return toast('Select a route first', 'warn');
  if (!state.supportsOrdersRouteId) return toast('orders.route_id not enabled in Supabase', 'warn');

  const boxes = Array.from(document.querySelectorAll('#routeAddList .routeAddChk:checked'));
  const orderIds = boxes.map(b=>b.dataset.orderId).filter(Boolean);
  if (!orderIds.length) return toast('Select at least one order', 'warn');

  const { error } = await supabaseClient.from('orders').update({ route_id: rid }).in('id', orderIds);
  if (error) return toast(fmtSbError(error), 'warn');

  await refreshAll(false);
  toast('Orders added to route', 'ok');
}

async function autoGroupOrdersIntoRoutes(opts = {}){
  if (!state.supportsRoutes || !state.supportsOrdersRouteId){
    toast('Routes schema not enabled', 'warn');
    return;
  }

  const focusOrderId = opts.focusOrderId || null;

  // eligible: deposited + not on a route
  let eligible = (state.orders||[])
    .filter(o => stageLabelForOrder(o) === 'deposited')
    .filter(o => !o.route_id);

  if (focusOrderId){
    const focus = eligible.find(o=>String(o.id)===String(focusOrderId));
    if (!focus) return;
    const cad = normalizeCadence(focus.cadence);
    const zip = zipFromAddress(focus.address||'');
    eligible = eligible.filter(o => normalizeCadence(o.cadence)===cad && zipFromAddress(o.address||'')===zip);
  }

  if (!eligible.length){
    if (!opts.silent) toast('No unassigned deposited orders to group', 'ok');
    return;
  }

  // group key: cadence + zip (fallback to 'nozip')
  const groups = new Map();
  for (const o of eligible){
    const cad = normalizeCadence(o.cadence) || 'unknown';
    const zip = zipFromAddress(o.address||'') || 'nozip';
    const key = cad + '|' + zip;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  // Ensure routes loaded
  await loadRoutes();

  for (const [key, orders] of groups.entries()){
    const [cad, zip] = key.split('|');
    const routeName = `AUTO • ${cad} • ${zip}`;
    let route = (state.routes||[]).find(r => String(r.name||'') === routeName && String(r.status||'').toLowerCase() !== 'completed');

    if (!route){
      // choose most common preferred_service_day among orders, else Monday
      const counts = {};
      for (const o of orders){
        const d = String(o.preferred_service_day||'').trim();
        if (d) counts[d] = (counts[d]||0)+1;
      }
      const chosenDay = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'Monday';

      const payload = {
        name: routeName,
        service_day: chosenDay,
        status: 'draft',
        target_cans: orders.length,
        operator_id: null
      };
      const ins = await supabaseClient.from('routes').insert(payload).select('*').single();
      if (ins.error){
        console.warn('autoGroup route insert', ins.error);
        continue;
      }
      route = ins.data;
    }

    const orderIds = orders.map(o=>o.id);
    const up = await supabaseClient.from('orders').update({ route_id: route.id }).in('id', orderIds);
    if (up.error) console.warn('autoGroup order update', up.error);
  }

  await refreshAll(false);
  if (!opts.silent) toast('Auto-grouped orders into draft routes', 'ok');
}

async function openOrderInRoute(orderId){
  if (!orderId) return;
  sessionStorage.setItem('focus_order_id', String(orderId));

  // ensure freshest state (especially after an auto-group)
  await refreshAll(false);

  let ord = (state.orders||[]).find(o=>String(o.id)===String(orderId));
  if (!ord) return toast('Order not found', 'warn');

  // IMPORTANT: Do NOT auto-assign orders to routes when deep-linking.
  // If the order is unassigned, we still take the user to Routes so they can
  // manually pick a route and add it (it will be pre-checked in the Add Orders list).

  switchView('routesView');

  if (ord?.route_id){
    state.selectedRouteId = ord.route_id;
    renderRoutes();
    renderRouteDetails();
  } else {
    // No route yet → show route list and pre-check it in "Add orders"
    state.selectedRouteId = null;
    renderRoutes();
    renderRouteDetails();
  }
}





/* ========= Route printing / PDF ========= */

// Attempt to pull lat/lng fields from an order (supports different column names)
function getLatLng(order){
  const lat = order.lat ?? order.latitude ?? order.geo_lat ?? order.location_lat;
  const lng = order.lng ?? order.longitude ?? order.geo_lng ?? order.location_lng;
  const a = Number(lat), b = Number(lng);
  if (!isFinite(a) || !isFinite(b)) return null;
  return { lat:a, lng:b };
}

// Very lightweight distance heuristic (Haversine-ish in degrees). Good enough for ordering nearby stops.
function approxDistance(a, b){
  const dLat = (a.lat - b.lat);
  const dLng = (a.lng - b.lng);
  return Math.sqrt(dLat*dLat + dLng*dLng);
}

function extractZip(order){
  const z = order.zip ?? order.postal_code ?? order.postal ?? '';
  if (z) return String(z).trim();
  const addr = String(order.address || order.location || '').trim();
  const m = addr.match(/\b\d{5}(?:-\d{4})?\b/);
  return m ? m[0] : '';
}

// If we have lat/lng, do a simple nearest-neighbor ordering.
// Otherwise fall back to ZIP then address string.
function optimizeStops(orders){
  if (!orders.length) return orders;
  const withGeo = orders.map(o=>({ o, g:getLatLng(o) })).filter(x=>x.g);
  if (withGeo.length >= Math.max(3, Math.floor(orders.length*0.6))){
    // start at the first stop; greedy nearest neighbor
    const remaining = withGeo.slice();
    const ordered = [];
    let current = remaining.shift();
    ordered.push(current.o);
    while (remaining.length){
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i=0;i<remaining.length;i++){
        const d = approxDistance(current.g, remaining[i].g);
        if (d < bestDist){
          bestDist = d;
          bestIdx = i;
        }
      }
      current = remaining.splice(bestIdx,1)[0];
      ordered.push(current.o);
    }
    // append any orders without geo at end (still included)
    const noGeo = orders.filter(o=>!getLatLng(o));
    return ordered.concat(noGeo);
  }

  return orders.slice().sort((a,b)=>{
    const za = extractZip(a);
    const zb = extractZip(b);
    if (za && zb && za !== zb) return za.localeCompare(zb);
    const aa = String(a.address||'');
    const bb = String(b.address||'');
    return aa.localeCompare(bb);
  });
}

// Opens a print-friendly window (user can "Save as PDF")
async function printRoutePDF(){
  const rid = state.selectedRouteId;
  if (!rid){
    toast('Select a route first', 'warn');
    return;
  }
  const r = (state.routes||[]).find(x=>String(x.id)===String(rid));
  if (!r){
    toast('Route not found', 'warn');
    return;
  }

  // Determine service date automatically from route schedule
  const { next, next2 } = computeNextServiceDates(r);
  if (!next){
    toast('Set a First Service Date for this route first', 'warn');
    return;
  }
  const serviceDate = next;
  const serviceISO = toISODate(serviceDate);
  const nextISO = next2 ? toISODate(next2) : '';

  let orders = (state.orders||[]).filter(o=>String(o.route_id||'')===String(rid));

  // Optimize order by location (lat/lng if present; fallback to ZIP/address)
  const ordered = optimizeStops(orders);

  const title = escapeHtml(r.name || 'Route');
  const meta = `${escapeHtml(r.service_day || '')} • ${escapeHtml(String(r.cadence||'biweekly'))}`;

  // Normalize service frequency for a stop (ops cadence, not billing cadence)
  const normFreq = (o) => {
    const c = String(o.service_frequency || o.cadence || o.frequency || '').toLowerCase();
    if (c.includes('bi')) return 'biweekly';
    if (c.includes('month')) return 'monthly';
    return c || 'biweekly';
  };

  // Compute route run index (0,1,2...) from route.service_start_date
  const start = parseISODate(r.service_start_date);
  const runIndex = (()=>{
    if (!start) return 0;
    const cadence = String(r.cadence||'biweekly').toLowerCase();
    const days = Math.floor((serviceDate.getTime() - start.getTime()) / 86400000);
    if (cadence === 'monthly'){
      // monthly route run: index by month diff (approx by iterating)
      let idx=0; let cur=new Date(start.getTime());
      while (cur < serviceDate && idx < 120){
        cur = addMonths(cur, 1);
        idx++;
      }
      return idx;
    }
    return Math.max(0, Math.round(days / 14)); // biweekly
  })();

  // Is stop due on this service date?
  const isDueThisRun = (o) => {
    const f = normFreq(o);
    const cadence = String(r.cadence||'biweekly').toLowerCase();
    if (cadence === 'monthly'){
      // Route only runs monthly; everything printed is due (monthly service)
      return true;
    }
    // Biweekly route:
    if (f === 'monthly') return (runIndex % 2) === 0; // every other run
    return true; // biweekly service
  };

  const stopsHtml = ordered.map((o, idx)=>{
    const stopNum = idx + 1;
    const name = escapeHtml(o.business_name||o.biz_name||o.name||'Stop');
    const addr = escapeHtml(o.address||o.location||'');
    const freq = normFreq(o);
    const cansN = (parseInt(String(o.cans ?? o.can_count ?? o.qty ?? ''),10) || 0);
    const due = isDueThisRun(o);
    const badge = due ? '<span class="badge due">DUE</span>' : '<span class="badge skip">SKIP</span>';
    const hint = due ? '' : ' <span class="muted">(skip this run)</span>';

    return `
      <tr>
        <td class="num">${stopNum}</td>
        <td>
          <div class="title">${name} ${badge}</div>
          <div class="sub">${addr}</div>
        </td>
        <td>${escapeHtml(String(cansN))}</td>
        <td>${escapeHtml(freq)}</td>
        <td>${hint}</td>
      </tr>
    `;
  }).join('');

  const w = window.open('', '_blank');
  if (!w) { toast('Pop-up blocked. Allow pop-ups to print.', 'warn'); return; }

  w.document.open();
  w.document.write(`
    <html>
    <head>
      <meta charset="utf-8"/>
      <title>${title} — Service Sheet</title>
      <style>
        body{ font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding:24px; color:#0b1220; }
        h1{ margin:0 0 6px; font-size:22px; }
        .meta{ color:#4b5563; margin-bottom:14px; }
        .dates{ margin:10px 0 16px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:10px; }
        .dates b{ display:inline-block; min-width:140px; }
        table{ width:100%; border-collapse:collapse; }
        th,td{ border-bottom:1px solid #e5e7eb; padding:10px 8px; vertical-align:top; }
        th{ text-align:left; font-size:12px; color:#6b7280; letter-spacing:.04em; text-transform:uppercase; }
        .num{ width:40px; color:#6b7280; }
        .title{ font-weight:700; }
        .sub{ color:#4b5563; font-size:12px; margin-top:2px; }
        .badge{ display:inline-block; font-size:11px; padding:2px 7px; border-radius:999px; margin-left:8px; }
        .badge.due{ background:#dcfce7; color:#166534; }
        .badge.skip{ background:#fee2e2; color:#991b1b; }
        .muted{ color:#6b7280; font-size:12px; }
        .brand{ font-size:12px; color:#111827; letter-spacing:.12em; text-transform:uppercase; text-align:right; margin-bottom:10px; }
        .footer{ margin-top:16px; color:#6b7280; font-size:11px; display:flex; justify-content:space-between; }
      </style>
    </head>
    <body>
      <h1>${title}</h1>
      <div class="meta">${meta}</div>
      <div class="dates">
        <div><b>Service Date:</b> ${escapeHtml(fmtDateLong(serviceDate))} (${escapeHtml(serviceISO)})</div>
        <div><b>Next Service Date:</b> ${escapeHtml(next2 ? fmtDateLong(next2) : '—')} ${nextISO ? '('+escapeHtml(nextISO)+')' : ''}</div>
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Stop</th>
            <th>Cans</th>
            <th>Service</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${stopsHtml}
        </tbody>
      </table>

      <div class="footer">
        <div>ProCan Sanitation LLC</div>
        <div class="muted">Generated: ${escapeHtml(fmtDateLong(new Date()))}</div>
      </div>
      <script>window.print();<\/script>
    </body>
    </html>
  `);
  w.document.close();
}

async function createRoute(){
  if (!state.supportsRoutes) return toast('Routes schema not enabled', 'warn');
  const payload = {
    name: 'New Route',
    service_day: 'Monday',
    status: 'draft',
    target_cans: 15,
    operator_id: null
  };
  const { data, error } = await supabaseClient.from('routes').insert(payload).select('*').single();
  if (error) return toast(fmtSbError(error), 'warn');
  await loadRoutes();
  state.selectedRouteId = data.id;
  renderRoutes();
  renderRouteDetails();
  toast('Route created', 'ok');
}

async function saveRoute(){
  const rid = state.selectedRouteId;
  if (!rid) return;
  const payload = {
    name: document.getElementById('routeName').value.trim(),
    service_day: document.getElementById('routeServiceDay').value,
    status: document.getElementById('routeStatus').value,
    target_cans: Number(document.getElementById('routeTargetCans').value||0) || null,
    operator_id: document.getElementById('routeOperator').value || null,
    cadence: (document.getElementById('routeCadence')?.value || 'biweekly'),
    service_start_date: (document.getElementById('routeStartDate')?.value || null)
  };
  const { error } = await supabaseClient.from('routes').update(payload).eq('id', rid);
  if (error) return toast(fmtSbError(error), 'warn');
  await loadRoutes();
  renderRoutes();
  renderRouteDetails();
  toast('Route saved', 'ok');
}


async function scheduleRouteStart(){
  const rid = state.selectedRouteId;
  if (!rid){ toast('Select a route first','warn'); return; }
  const r = (state.routes||[]).find(x=>x.id===rid);
  const startDate = document.getElementById('routeStartDate')?.value || '';
  if (!startDate){ toast('Set First Service Date first','warn'); return; }
  const cadence = (document.getElementById('routeCadence')?.value || 'biweekly');

  // Persist route schedule in Supabase
  const { error } = await supabaseClient.from('routes').update({ service_start_date: startDate, cadence }).eq('id', rid);
  if (error){ toast(fmtSbError(error),'warn'); return; }
  await loadRoutes();
  renderRoutes();
  renderRouteDetails();

  // Optional: call backend (same-origin /api) to sync Stripe subscription trial_end + apply deposit credit.
  const token = (localStorage.getItem('PROCAN_ROUTE_TOKEN') || '').trim();
  if (!token){
    toast('Route scheduled. Set PROCAN_ROUTE_TOKEN to sync billing.', 'ok');
    return;
  }

  try{
    const resp = await fetch('/api/schedule-route', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ route_id: rid, service_start_date: startDate, cadence })
    });
    const data = await resp.json().catch(()=> ({}));
    if (!resp.ok){
      toast('Billing sync failed: ' + (data.error || resp.status), 'warn');
      return;
    }
    toast('Route scheduled + billing synced', 'ok');
  }catch(err){
    toast('Billing sync failed to fetch', 'warn');
  }
}

async function deleteRoute(){
  const rid = state.selectedRouteId;
  if (!rid) return;
  // Unassign orders first to avoid FK issues if your schema uses FK
  if (state.supportsOrdersRouteId){
    await supabaseClient.from('orders').update({ route_id: null }).eq('route_id', rid);
  }
  const { error } = await supabaseClient.from('routes').delete().eq('id', rid);
  if (error) return toast(fmtSbError(error), 'warn');
  state.selectedRouteId = null;
  await loadRoutes();
  renderRoutes();
  renderRouteDetails();
  toast('Route deleted', 'ok');
}