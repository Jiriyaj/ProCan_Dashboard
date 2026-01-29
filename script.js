
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
  '#9EF01A', '#28c7ff', '#ffb020', '#ff4d4d', '#40ff99', '#b084ff', '#ffd1dc'
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
  // nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  $('btnLogin').addEventListener('click', loginWithPassword);
  $('btnMagic').addEventListener('click', sendMagicLink);
  $('btnLogout').addEventListener('click', async () => {
    if (!supabaseClient) return;
    await supabaseClient.auth.signOut();
  });

  $('btnRefresh').addEventListener('click', async () => { await refreshAll(true); });
  $('btnAutoAssign').addEventListener('click', async () => { await autoAssignCurrentWeek(); });

  $('btnAutoAssign2').addEventListener('click', async () => { await autoAssignCurrentWeek(); switchView('scheduleView'); });
  $('btnGeocode2').addEventListener('click', async () => { await geocodeMissingOrders(15); await renderMap(); });

  $('btnGeocodeMissing').addEventListener('click', async () => {
    await geocodeMissingOrders(15);
    await refreshAll(false);
    await renderMap();
  });

  $('btnGoSchedule').addEventListener('click', () => switchView('scheduleView'));

  // week picker default
  $('weekPicker').value = toISODate(state.weekStart);
  $('weekPicker').addEventListener('change', async () => {
    const d = parseISO($('weekPicker').value);
    state.weekStart = startOfWeek(d || new Date());
    $('weekPicker').value = toISODate(state.weekStart);
    await refreshAll(false);
  });

  // schedule filters
  $('filterOperator').addEventListener('change', () => renderSchedule());
  $('filterDay').addEventListener('change', () => renderSchedule());
  $('mapOperator').addEventListener('change', () => renderMap());
  $('mapDay').addEventListener('change', () => renderMap());
  $('ordersStatus').addEventListener('change', () => renderOrders());
  $('ordersSearch').addEventListener('input', () => renderOrders());
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
    mapView: ['Map', 'Route map (color-coded by operator)'],
    ordersView: ['Orders', 'Intake orders + status'],
    operatorsView: ['Operators', 'Manage payouts & capacity'],
  };
  const t = titles[viewId] || ['ProCan', ''];
  $('pageTitle').textContent = t[0];
  $('pageSub').textContent = t[1];

  if (viewId === 'mapView'){
    setTimeout(() => {
      ensureMap();
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
    supabaseClient.from('assignments').select('*').gte('service_date', toISODate(state.weekStart)).lte('service_date', toISODate(addDays(state.weekStart,6))).order('service_date',{ascending:true}).order('sequence',{ascending:true}),
  ]);

  if (opsRes.error) return showBanner(opsRes.error.message);
  if (ordRes.error) return showBanner(ordRes.error.message);
  if (asnRes.error) return showBanner(asnRes.error.message);

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
    el.innerHTML = '';
    if (includeAll) el.append(new Option('All operators', 'all'));
    state.operators.forEach(o => el.append(new Option(o.name, o.id)));
    if (!state.operators.length) el.append(new Option('No operators', 'none'));
  };

  opSel($('filterOperator'), true);
  opSel($('mapOperator'), true);

  const daySel = (el, includeAll=true) => {
    el.innerHTML='';
    if (includeAll) el.append(new Option('All days', 'all'));
    for (let i=0;i<7;i++){
      const d = addDays(state.weekStart, i);
      el.append(new Option(`${dayName(d.getDay())} ${toISODate(d)}`, toISODate(d)));
    }
  };
  daySel($('filterDay'), true);
  daySel($('mapDay'), true);

  const status = $('ordersStatus');
  status.innerHTML='';
  ['All','new','scheduled','completed','cancelled'].forEach(s=>{
    const val = s==='All' ? 'all' : s;
    status.append(new Option(s==='All'?'All statuses':s, val));
  });
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

  // Join assignments -> orders
  const orderById = new Map(state.orders.map(o => [o.id, o]));
  const opsById = new Map(state.operators.map(o => [o.id, o]));

  const weekAsn = state.assignments.filter(a => a.service_date >= weekStartISO && a.service_date <= weekEndISO);
  const jobsCount = weekAsn.length;

  let gross = 0;
  const payoutsByOp = {};
  for (const a of weekAsn){
    const o = orderById.get(a.order_id);
    if (!o) continue;
    const amt = Number(o.monthly_total || o.due_today || 0);
    gross += amt;

    const op = opsById.get(a.operator_id);
    const rate = Number(op?.payout_rate ?? 30) / 100;
    const pay = amt * rate;
    payoutsByOp[a.operator_id] = (payoutsByOp[a.operator_id]||0) + pay;
  }
  const payouts = Object.values(payoutsByOp).reduce((s,v)=>s+v,0);
  const profit = gross - payouts;

  $('kpiGross').textContent = fmtMoney(gross);
  $('kpiProfit').textContent = fmtMoney(profit);
  $('kpiJobs').textContent = String(jobsCount);
  $('kpiPayouts').textContent = fmtMoney(payouts);

  // Today list
  const todayISO = toISODate(new Date());
  const todayAsn = state.assignments.filter(a => a.service_date === todayISO).slice(0, 12);
  const todayList = $('todayList');
  todayList.innerHTML = '';
  if (!todayAsn.length){
    todayList.innerHTML = `<div class="muted">No jobs scheduled for today.</div>`;
  } else {
    for (const a of todayAsn){
      const o = orderById.get(a.order_id);
      const op = opsById.get(a.operator_id);
      todayList.append(renderRow({
        title: o?.biz_name || o?.contact_name || 'Job',
        sub: o?.address || '',
        badges: [
          { text: op?.name || 'Unassigned', cls:'blue' },
          { text: fmtMoney(o?.monthly_total || o?.due_today || 0), cls:'brand' },
          { text: (o?.cadence || 'monthly'), cls:'' },
        ]
      }));
    }
  }

  // Payout list
  const payoutList = $('payoutList');
  payoutList.innerHTML = '';
  const entries = state.operators
    .filter(o => o.active !== false)
    .map(o => ({ o, amt: payoutsByOp[o.id] || 0 }))
    .sort((a,b)=>b.amt-a.amt);

  if (!entries.length){
    payoutList.innerHTML = `<div class="muted">No operators yet.</div>`;
  } else {
    for (const e of entries){
      payoutList.append(renderRow({
        title: e.o.name,
        sub: `Payout rate: ${Number(e.o.payout_rate||30).toFixed(1)}%`,
        badges: [{ text: fmtMoney(e.amt), cls:'brand' }]
      }));
    }
  }
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
function renderSchedule(){
  const board = $('scheduleBoard');
  if (!board) return;

  const orderById = new Map(state.orders.map(o => [o.id, o]));
  const opsById = new Map(state.operators.map(o => [o.id, o]));

  const opFilter = $('filterOperator').value || 'all';
  const dayFilter = $('filterDay').value || 'all';

  board.innerHTML = '';

  for (let i=0;i<7;i++){
    const date = addDays(state.weekStart, i);
    const iso = toISODate(date);

    if (dayFilter !== 'all' && dayFilter !== iso) continue;

    const col = document.createElement('div');
    col.className = 'daycol';
    col.innerHTML = `<div class="dayhead"><div class="dayname">${dayName(date.getDay())}</div><div class="daydate">${iso}</div></div>`;

    const asn = state.assignments
      .filter(a => a.service_date === iso)
      .filter(a => opFilter === 'all' ? true : a.operator_id === opFilter)
      .sort((a,b)=>(a.sequence||0)-(b.sequence||0));

    if (!asn.length){
      const empty = document.createElement('div');
      empty.className='muted';
      empty.style.padding='8px';
      empty.textContent='No stops';
      col.appendChild(empty);
    } else {
      for (const a of asn){
        const o = orderById.get(a.order_id);
        const op = opsById.get(a.operator_id);
        const stop = document.createElement('div');
        stop.className = 'stop';
        stop.innerHTML = `
          <div class="t">${escapeHtml(o?.biz_name || 'Job')}</div>
          <div class="s">${escapeHtml(o?.address || '')}</div>
          <div class="meta">
            <span class="badge blue">${escapeHtml(op?.name || 'Unassigned')}</span>
            <span class="badge brand">${fmtMoney(o?.monthly_total || o?.due_today || 0)}</span>
            <span class="badge">${escapeHtml(String(o?.cadence || 'monthly'))}</span>
          </div>
        `;
        col.appendChild(stop);
      }
    }

    board.appendChild(col);
  }
}

/* ========= Orders ========= */
function renderOrders(){
  const wrap = $('ordersTable');
  if (!wrap) return;

  const status = $('ordersStatus').value || 'all';
  const q = String($('ordersSearch').value || '').toLowerCase();

  let rows = state.orders.slice();
  if (status !== 'all') rows = rows.filter(o => String(o.status||'new') === status);
  if (q) rows = rows.filter(o =>
    String(o.biz_name||'').toLowerCase().includes(q) ||
    String(o.address||'').toLowerCase().includes(q) ||
    String(o.order_id||'').toLowerCase().includes(q)
  );

  const html = [];
  html.push(`<table><thead><tr>
    <th>Business</th>
    <th>Address</th>
    <th>Cadence</th>
    <th>Preferred day</th>
    <th>Monthly</th>
    <th>Status</th>
    <th>Created</th>
  </tr></thead><tbody>`);

  for (const o of rows.slice(0, 400)){
    html.push(`<tr>
      <td>${escapeHtml(o.biz_name||'')}</td>
      <td>${escapeHtml(o.address||'')}</td>
      <td>${escapeHtml(o.cadence||'')}</td>
      <td>${escapeHtml(o.preferred_service_day||'')}</td>
      <td>${escapeHtml(fmtMoney(o.monthly_total || o.due_today || 0))}</td>
      <td>${escapeHtml(o.status||'new')}</td>
      <td>${escapeHtml(String(o.created_at||'').slice(0,10))}</td>
    </tr>`);
  }
  html.push(`</tbody></table>`);
  wrap.innerHTML = html.join('');
}

/* ========= Operators ========= */
function renderOperators(){
  const list = $('operatorsList');
  if (!list) return;
  list.innerHTML = '';
  state.operators.forEach(o => {
    list.append(renderRow({
      title: o.name,
      sub: `Payout: ${Number(o.payout_rate||30).toFixed(1)}% • ${o.active===false?'Inactive':'Active'}`,
      badges: [{ text: o.is_manager ? 'Manager' : 'Operator', cls:'' }]
    }));
  });
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

  clearMapLayers();

  const orderById = new Map(state.orders.map(o => [o.id, o]));
  const opsById = new Map(state.operators.map(o => [o.id, o]));

  const opFilter = $('mapOperator').value || 'all';
  const dayFilter = $('mapDay').value || 'all';

  const weekStartISO = toISODate(state.weekStart);
  const weekEndISO = toISODate(addDays(state.weekStart,6));

  let asn = state.assignments.filter(a => a.service_date >= weekStartISO && a.service_date <= weekEndISO);
  if (dayFilter !== 'all') asn = asn.filter(a => a.service_date === dayFilter);
  if (opFilter !== 'all') asn = asn.filter(a => a.operator_id === opFilter);

  // Build routes per operator per day
  const groups = {};
  for (const a of asn){
    const key = `${a.operator_id || 'unassigned'}__${a.service_date}`;
    (groups[key] = groups[key] || []).push(a);
  }

  const boundsPts = [];

  for (const key of Object.keys(groups)){
    const items = groups[key].sort((a,b)=>(a.sequence||0)-(b.sequence||0));
    const [opId, dateISO] = key.split('__');
    const color = state.operatorColors[opId] || '#9099a8';
    const pts = [];

    for (const a of items){
      const o = orderById.get(a.order_id);
      if (!o) continue;
      const lat = Number(o.lat);
      const lng = Number(o.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      pts.push([lat,lng]);
      boundsPts.push([lat,lng]);

      const marker = L.circleMarker([lat,lng], {
        radius: 8,
        color: color,
        weight: 2,
        fillColor: color,
        fillOpacity: 0.55
      }).addTo(state.map);

      marker.bindPopup(`
        <div style="font-family:system-ui">
          <div style="font-weight:800;margin-bottom:4px">${escapeHtml(o.biz_name || 'Job')}</div>
          <div style="color:rgba(255,255,255,.75);font-size:12px;margin-bottom:8px">${escapeHtml(o.address || '')}</div>
          <div style="font-size:12px">
            <b>${escapeHtml(opsById.get(a.operator_id)?.name || 'Unassigned')}</b> • ${escapeHtml(dateISO)}
          </div>
        </div>
      `);

      state.mapLayers.markers.push(marker);
    }

    if (pts.length >= 2){
      const line = L.polyline(pts, { color: color, weight: 4, opacity: 0.55 }).addTo(state.map);
      state.mapLayers.lines.push(line);
    }
  }

  // empty overlay
  const empty = $('mapEmpty');
  if (!boundsPts.length){
    empty.style.display='flex';
    // still ensure map sizes correctly
    setTimeout(()=>state.map.invalidateSize(), 50);
    return;
  }
  empty.style.display='none';

  const b = L.latLngBounds(boundsPts);
  state.map.fitBounds(b.pad(0.18));
  setTimeout(()=>state.map.invalidateSize(), 50);
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
