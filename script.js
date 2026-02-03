
'use strict';

/* ========= Helpers ========= */
const fmtMoney = (n) => {
  const v = Number(n || 0);
  return v.toLocaleString('en-US', { style:'currency', currency:'USD' });
};
const toISODate = (d) => new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10);
const parseISO = (s) => {
  const m = String(s||'').trim();
  if (!m) return null;
  const d = new Date(m);
  return isNaN(d) ? null : d;
};
const startOfWeek = (date) => {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // Mon=0
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() - day);
  return d;
};
const addDays = (date, n) => { const d=new Date(date); d.setDate(d.getDate()+n); return d; };
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

function stageLabelForOrder(order, assignedSet){
  const st = String(order?.status || 'new').toLowerCase();
  const hasAsn = assignedSet ? assignedSet.has(order.id) : orderHasAnyAssignment(order.id);

  // Explicit deposit flag from Intake/Webhook (preferred).
  const isDeposit =
    order?.is_deposit === true ||
    String(order?.is_deposit || '').toLowerCase() === 'true' ||
    order?.deposit === true ||
    String(order?.deposit || '').toLowerCase() === 'true' ||
    order?.deposit_only === true ||
    String(order?.deposit_only || '').toLowerCase() === 'true' ||
    String(order?.billing_type || '').toLowerCase() === 'deposit' ||
    String(order?.billing || '').toLowerCase().includes('deposit');

  if (st === 'cancelled') return 'cancelled';
  if (st === 'completed') return 'completed';

  // Before route activation: if deposit order, treat paid as reserved deposit.
  if (!hasAsn){
    if (isDeposit){
      if (st === 'paid') return 'reserved (deposit)';
      if (st === 'new') return 'deposit pending';
      return st || 'deposit pending';
    }
    // Non-deposit orders can be scheduled immediately once you know availability.
    if (st === 'paid') return 'ready to schedule';
    if (st === 'new') return 'awaiting payment';
    return st;
  }

  // After route activation: assignments exist.
  if (st === 'paid') return 'scheduled';
  return st;
}

/* ========= DOM ========= */
const $ = (id) => document.getElementById(id);

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
  view: 'homeView',
  weekStart: startOfWeek(new Date()),
  operators: [],
  orders: [],
  assignments: [],
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

  on('btnRefresh', 'click', async () => { await refreshAll(true); });
  on('btnAutoAssign', 'click', async () => { await autoAssignCurrentWeek(); });

  on('btnAutoAssign2', 'click', async () => { await autoAssignCurrentWeek(); switchView('scheduleView'); });
  on('btnGeocode2', 'click', async () => { await geocodeMissingOrders(15); await renderMap(); });
  on('btnGoOrdersMap', 'click', () => switchView('ordersView'));

  on('btnGeocodeMissing', 'click', async () => {
    await geocodeMissingOrders(15);
    await refreshAll(false);
    await renderMap();
  });

  // NOTE: btnGoSchedule was removed from the simplified Home; keep wiring optional.
  on('btnGoSchedule', 'click', () => switchView('scheduleView'));
  on('btnGoSchedule2', 'click', () => switchView('scheduleView'));

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
  on('filterOperator', 'change', () => renderSchedule());
  on('filterRange', 'change', () => renderSchedule());
  on('mapCadence', 'change', () => renderMap());
  on('mapStatus', 'change', () => renderMap());
  on('ordersStatus', 'change', () => renderOrders());
  on('ordersSearch', 'input', () => renderOrders());
  on('homeCadence', 'change', () => renderHome());
  on('homeAge', 'change', () => renderHome());
  on('homeSearch', 'input', () => renderHome());
  on('btnGoOrdersHome', 'click', () => switchView('ordersView'));
  on('btnPrintSchedule', 'click', () => printSchedulePDF());
  on('btnGoOrders', 'click', () => switchView('ordersView'));
  on('btnBulkAutoAssign', 'click', async () => { await autoAssignCurrentWeek(); await refreshAll(false); });
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
    homeView: ['Home', 'At-a-glance ops overview'],
    scheduleView: ['Schedule', 'Weekly dispatch built from Intake orders'],
    mapView: ['Map', 'All intake orders on the map (hover for details)'],
    ordersView: ['Orders', 'Intake orders + status'],
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
  state.orders = ordRes.data || [];
  state.assignments = asnRes.data || [];

  buildOperatorColors();
  hydrateFilters();

  renderHome();
  renderSchedule();
  renderOrders();
  renderOperators();

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

  // Orders page status
  const status = $('ordersStatus');
  if (status){
    status.innerHTML='';
    ['All','new','paid','scheduled','completed','cancelled'].forEach(s=>{
      const val = s==='All' ? 'all' : s;
      status.append(new Option(s==='All'?'All statuses':s, val));
    });
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
  const weekStartISO = toISODate(state.weekStart);
  const weekEndISO = toISODate(addDays(state.weekStart,6));
  const orderById = new Map(state.orders.map(o => [o.id, o]));
  const opsById = new Map(state.operators.map(o => [o.id, o]));

  const weekAsn = state.assignments.filter(a => a.service_date >= weekStartISO && a.service_date <= weekEndISO);

  // KPI calculations (based on scheduled work)
  let weekGross = 0;
  let weekPayouts = 0;
  const weekOrderSet = new Set();

  for (const a of weekAsn){
    weekOrderSet.add(a.order_id);
    const ord = orderById.get(a.order_id);
    if (!ord) continue;

    const amt = Number(ord.monthly_total || ord.due_today || 0);
    weekGross += amt;

    const op = opsById.get(a.operator_id);
    const rate = Number(op?.payout_rate ?? 30) / 100;
    weekPayouts += amt * rate;
  }

  const weekProfit = Math.max(0, weekGross - weekPayouts);

  $('kpiGross').textContent = fmtMoney(weekGross);
  $('kpiProfit').textContent = fmtMoney(weekProfit);
  $('kpiJobs').textContent = String(weekAsn.length);
  $('kpiPayouts').textContent = fmtMoney(weekPayouts);

  // KPI hovers (fix: consistent hover behavior)
  attachKpiHover($('kpiGross')?.closest('.kpi'), `Profit: ${fmtMoney(weekProfit)}  •  Payouts: ${fmtMoney(weekPayouts)}`);
  attachKpiHover($('kpiProfit')?.closest('.kpi'), `Gross: ${fmtMoney(weekGross)}  •  Payouts: ${fmtMoney(weekPayouts)}`);
  attachKpiHover($('kpiJobs')?.closest('.kpi'), `Unique clients: ${weekOrderSet.size}`);

  // Soonest available (simple capacity-based heuristic)
  renderNextAvailable();

  // Home orders inbox (grouped)
  renderHomeOrdersInbox();

  // Workload visual (scheduled vs total orders)
  const fill = $('workloadFill');
  const sub = $('workloadSub');
  if (fill && sub){
    const total = state.orders.length || 0;
    const assigned = weekAsn.length;
    const pct = total ? Math.min(100, Math.round((assigned / total) * 100)) : 0;
    fill.style.width = pct + '%';
    sub.textContent = `${assigned} scheduled this week • ${total} total intake orders`;
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
    <th>ZIP</th>
    <th>Age</th>
    <th>Preferred day</th>
    <th>Monthly</th>
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
    const stage = stageLabelForOrder(o, assignedSet);
    html.push(`<tr class="clickable" data-order-id="${escapeHtml(o.id)}">
      <td>${escapeHtml(o.biz_name||o.business_name||o.contact_name||'')}</td>
      <td>${escapeHtml(o.address||'')}</td>
      <td>${escapeHtml(r.cad||o.cadence||'')}</td>
      <td>${escapeHtml(r.zip||'')}</td>
      <td>${r.days===null?'—':escapeHtml(String(r.days)+'d')}</td>
      <td>${escapeHtml(o.preferred_service_day||'')}</td>
      <td>${escapeHtml(fmtMoney(o.monthly_total || o.due_today || 0))}</td>
      <td>${escapeHtml(stage)}</td>
    </tr>`);
  }

  html.push(`</tbody></table>`);
  wrap.innerHTML = html.join('');

  // Row click: jump to Orders tab and focus this order
  wrap.querySelectorAll('tr.clickable').forEach(tr=>{
    tr.addEventListener('click', ()=>{
      const id = tr.dataset.orderId;
      switchView('ordersView');
      if ($('ordersSearch')){
        $('ordersSearch').value = id || '';
        renderOrders();
      }
    });
  });
}
function renderNextAvailable(){
  const el = $('nextAvailable');
  const sub = $('nextAvailableSub');
  if (!el) return;

  // Heuristic: total stops per day capacity. Adjust as you learn your market.
  const DAILY_STOP_CAPACITY = 10;
  const LOOKAHEAD_DAYS = 30;

  const today = new Date();
  today.setHours(0,0,0,0);

  // Count scheduled stops per day across loaded assignments
  const counts = {};
  for (const a of state.assignments){
    const d = String(a.service_date||'');
    if (!d) continue;
    counts[d] = (counts[d]||0) + 1;
  }

  let chosen = null;
  for (let i=0;i<=LOOKAHEAD_DAYS;i++){
    const d = addDays(today, i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekend
    const iso = toISODate(d);
    const used = counts[iso] || 0;
    if (used < DAILY_STOP_CAPACITY){
      chosen = { iso, used };
      break;
    }
  }

  if (!chosen){
    el.textContent = 'No openings';
    if (sub) sub.textContent = `Fully booked for the next ${LOOKAHEAD_DAYS} days (capacity ${DAILY_STOP_CAPACITY}/day)`;
    return;
  }

  el.textContent = chosen.iso;
  if (sub) sub.textContent = `Booked: ${chosen.used}/${DAILY_STOP_CAPACITY} stops (next ${LOOKAHEAD_DAYS} days)`;
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

  const orderById = new Map(state.orders.map(o => [o.id, o]));
  const opsById = new Map(state.operators.map(o => [o.id, o]));

  const opFilter = $('filterOperator')?.value || 'all';
  const range = $('filterRange')?.value || 'week';
  const { startISO, endISO } = getRangeWindow(range);

  const rows = state.assignments
    .filter(a => a.service_date >= startISO && a.service_date <= endISO)
    .filter(a => opFilter === 'all' ? true : (a.operator_id === opFilter))
    .sort((a,b)=>{
      if (a.service_date !== b.service_date) return a.service_date.localeCompare(b.service_date);
      if ((a.operator_id||'') !== (b.operator_id||'')) return (a.operator_id||'').localeCompare(b.operator_id||'');
      return Number(a.stop_order||0) - Number(b.stop_order||0);
    });

  // Build table
  board.innerHTML = '';
  const table = document.createElement('div');
  table.className = 'schedule-table';

  const header = document.createElement('div');
  header.className = 'schedule-row header';
  header.innerHTML = `
    <div>Date</div>
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
    empty.innerHTML = `<div class="muted" style="grid-column:1/-1;">No scheduled jobs in this range. Click “Generate schedule”.</div>`;
    table.appendChild(empty);
  } else {
    for (const a of rows){
      const ord = orderById.get(a.order_id) || {};
      const op = opsById.get(a.operator_id) || {};
      const status = ord.status || 'scheduled';

      const row = document.createElement('div');
      row.className = 'schedule-row';
      row.dataset.assignmentId = a.id;

      row.innerHTML = `
        <div>${escapeHtml(a.service_date)}</div>
        <div>${escapeHtml(op.name || 'Unassigned')}</div>
        <div data-col="biz"><div class="title">${escapeHtml(ord.biz_name || ord.business_name || ord.contact_name || 'Order')}</div>
          <div class="sub">${escapeHtml(ord.cadence || '')} • ${fmtMoney(ord.monthly_total || ord.due_today || 0)}</div></div>
        <div data-col="addr" class="sub">${escapeHtml(ord.address || '')}</div>
        <div><span class="badge"><span class="dot"></span>${escapeHtml(status)}</span></div>
        <div class="actions">
          <button class="btn btn-mini ghost" data-action="edit">Edit</button>
          <button class="btn btn-mini ghost" data-action="reassign">Reassign</button>
          <button class="btn btn-mini outline" data-action="delete">Delete</button>
        </div>
      `;
      table.appendChild(row);
    }
  }

  board.appendChild(table);

  // Row actions
  table.querySelectorAll('button[data-action]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      const action = btn.dataset.action;
      const row = btn.closest('.schedule-row');
      const id = row?.dataset.assignmentId;
      if (!id) return;
      if (action === 'delete') return deleteAssignment(id);
      if (action === 'edit') return editAssignment(id);
      if (action === 'reassign') return reassignAssignment(id);
    });
  });
}

async function deleteAssignment(id){
  if (!confirm('Delete this scheduled job?')) return;
  const { error } = await supabaseClient.from('assignments').delete().eq('id', id);
  if (error) return showBanner(error.message);
  await refreshAll(false);
}

async function editAssignment(id){
  const a = state.assignments.find(x => x.id === id);
  if (!a) return;
  const newDate = prompt('Service date (YYYY-MM-DD):', a.service_date);
  if (!newDate) return;
  const { error } = await supabaseClient.from('assignments').update({ service_date: newDate }).eq('id', id);
  if (error) return showBanner(error.message);
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
  if (error) return showBanner(error.message);
  await refreshAll(false);
}


function printSchedulePDF(){
  const opFilter = $('filterOperator')?.value || 'all';
  const range = 'week'; // PDF is weekly dispatch sheet
  const { startISO, endISO } = getRangeWindow(range);
  const orderById = new Map(state.orders.map(o => [o.id, o]));
  const opsById = new Map(state.operators.map(o => [o.id, o]));

  if (opFilter === 'all'){
    alert('Select an operator first (top of Schedule) before printing.');
    return;
  }

  const rows = state.assignments
    .filter(a => a.service_date >= startISO && a.service_date <= endISO)
    .filter(a => a.operator_id === opFilter)
    .sort((a,b)=> a.service_date.localeCompare(b.service_date) || (Number(a.stop_order||0)-Number(b.stop_order||0)));

  const op = opsById.get(opFilter);
  const title = `ProCan Weekly Route Sheet — ${op?.name || 'Operator'} — Week of ${startISO}`;

  const w = window.open('', '_blank');
  if (!w) return alert('Pop-up blocked. Allow pop-ups to print.');

  const style = `
    <style>
      body{font-family:Arial, sans-serif; padding:18px;}
      h1{font-size:18px; margin:0 0 10px;}
      .sub{color:#555; margin:0 0 14px;}
      table{width:100%; border-collapse:collapse; font-size:12px;}
      th,td{border:1px solid #ddd; padding:8px; vertical-align:top;}
      th{background:#f4f4f4; text-align:left;}
      .day{background:#fafafa; font-weight:700;}
    </style>
  `;

  let html = `${style}<h1>${title}</h1><div class="sub">Stops are ordered top-to-bottom for each day.</div>`;
  html += `<table><thead><tr><th>Date</th><th>Stop</th><th>Business</th><th>Address</th><th>Notes</th></tr></thead><tbody>`;

  if (!rows.length){
    html += `<tr><td colspan="5">No jobs scheduled for this operator this week.</td></tr>`;
  } else {
    for (const a of rows){
      const ord = orderById.get(a.order_id) || {};
      html += `<tr>
        <td>${a.service_date}</td>
        <td>${Number(a.stop_order||0)+1}</td>
        <td>${escapeHtml(ord.biz_name || ord.business_name || ord.contact_name || 'Order')}</td>
        <td>${escapeHtml(ord.address || '')}</td>
        <td>${escapeHtml(ord.notes || '')}</td>
      </tr>`;
    }
  }

  html += `</tbody></table>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}


/* ========= Orders ========= */
function renderOrders(){
  const wrap = $('ordersTable');
  if (!wrap) return;

  const status = $('ordersStatus')?.value || 'all';
  const q = String($('ordersSearch')?.value || '').toLowerCase();

  let rows = state.orders.slice();
  if (status !== 'all') rows = rows.filter(o => String(o.status||'new') === status);
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
      <td>${escapeHtml(o.preferred_service_day||'')}</td>
      <td>${escapeHtml(fmtMoney(o.monthly_total || o.due_today || 0))}</td>
      <td>${escapeHtml(o.status||'new')}</td>
      <td>
        <button class="btn btn-mini ghost" data-act="schedule">Schedule</button>
        <button class="btn btn-mini ghost" data-act="status">Status</button>
        <button class="btn btn-mini outline" data-act="delete">Delete</button>
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
      if (act === 'schedule') return scheduleOrder(orderId);
      if (act === 'status') return updateOrderStatus(orderId);
      if (act === 'delete') return deleteOrder(orderId);
    });
  });
}

async function scheduleOrder(orderId){
  const ord = state.orders.find(o => o.id === orderId);
  if (!ord) return;
  const date = prompt('Service date (YYYY-MM-DD):', toISODate(state.weekStart));
  if (!date) return;

  if (!state.operators.length){
    alert('Add an operator first (Operators tab).');
    return;
  }

  const opNameList = state.operators.map(o=>`${o.name} (${o.id})`).join('\n');
  const opIdRaw = prompt(`Operator id (paste one):\n${opNameList}`, state.operators[0].id);
  if (!opIdRaw) return;

  const payload = { order_id: orderId, operator_id: opIdRaw, service_date: date, stop_order: 0 };
  const { error } = await supabaseClient.from('assignments').upsert(payload, { onConflict: 'order_id,service_date' });
  if (error) return showBanner(error.message);

  await refreshAll(false);
  switchView('scheduleView');
}

async function updateOrderStatus(orderId){
  const ord = state.orders.find(o => o.id === orderId);
  if (!ord) return;
  const current = String(ord.status||'new');
  const next = prompt('Set status (new, paid, scheduled, completed, cancelled):', current);
  if (!next) return;

  const { error } = await supabaseClient.from('orders').update({ status: next }).eq('id', orderId);
  if (error) return showBanner(error.message);

  await refreshAll(false);
}

async function deleteOrder(orderId){
  if (!confirm('Delete this order? This cannot be undone.')) return;
  const { error } = await supabaseClient.from('orders').delete().eq('id', orderId);
  if (error) return showBanner(error.message);
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
      <input id="opRate" type="number" step="0.1" value="${escapeHtml(String(o.payout_rate ?? 30))}" />
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
    const { error } = await supabaseClient.from('operators').update({ name, payout_rate: rate, active }).eq('id', o.id);
    if (error) return showBanner(error.message);
    await refreshAll(false);
  });
}

async function addOperator(){
  const name = prompt('Operator name:');
  if (!name) return;
  const rate = Number(prompt('Payout rate (%):', '30') || 30);
  const { error } = await supabaseClient.from('operators').insert({ name, payout_rate: rate, active: true });
  if (error) return showBanner(error.message);
  await refreshAll(false);
  // select the newest
  selectedOperatorId = state.operators[state.operators.length-1]?.id || null;
}

async function deleteOperator(opId){
  const o = state.operators.find(x=>x.id===opId);
  if (!o) return;
  if (!confirm(`Remove operator "${o.name}"?`)) return;
  const { error } = await supabaseClient.from('operators').delete().eq('id', opId);
  if (error) return showBanner(error.message);
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
    const stage = stageLabelForOrder(ord, assignedSet);
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