
/* ===== Immediate first paint ===== */
document.addEventListener('DOMContentLoaded', () => {
  const o = document.getElementById('startupOverlay');
  if (o) {
    o.classList.add('hidden');
    setTimeout(()=>o.remove(), 300);
  }
});


let supabaseClient = null;
// Cache the last known session so slow auth checks don't kick you out.
window.__cachedSession = window.__cachedSession || null;
/* ===== Supabase init handled in boot() via initSupabase() ===== */
'use strict';

// === HARD FAILSAFE: never let the startup overlay trap the UI ===
(function hardKillStartupOverlay(){
  const kill = () => {
    const o = document.getElementById('startupOverlay');
    if (!o) return;
    try {
      o.style.opacity = '0';
      o.style.pointerEvents = 'none';
      setTimeout(() => { try { o.remove(); } catch(_) {} }, 300);
    } catch(_) {}
  };
  // Run a few times to beat race conditions / caching oddities
  setTimeout(kill, 1500);
  setTimeout(kill, 3500);
  window.addEventListener('load', () => setTimeout(kill, 250));
})();


/**
 * ProCan Sanitation Ops Tracker (J.A.I.D.A)
 * Adds Supabase:
 * - Auth gate
 * - Orders (from intake webhook) view
 * - Assignments + Routes
 *
 * Keeps your existing local logic intact, but when Supabase is configured,
 * it will read/write Operators + Visits + Orders + Assignments to Supabase.
 */

// ==============================
// Storage (kept for safety/backups)
// ==============================
const STORAGE_KEY = 'procan_ops_tracker_JAIDA_v1';
const BACKUP_KEY  = 'procan_ops_tracker_backup_v1';

// ==============================
// Config
// ==============================
const DEFAULT_CONFIG = {
  defaultPayoutRate: 30,
  payoutDayOfWeek: 5
};

// ==============================
// Pricing (unchanged from your file)
// ==============================
const PRICING = {
  trashCan: {
    biweekly: [
      { min: 1,  max: 10,  pricePerCanMonth: 25 },
      { min: 11, max: 20,  pricePerCanMonth: 23 },
      { min: 21, max: 50,  pricePerCanMonth: 20 },
      { min: 51, max: 100, pricePerCanMonth: 18 },
      { min: 101, max: Infinity, pricePerCanMonth: 16 }
    ],
    monthly: [
      { min: 1,  max: 10,  pricePerCanMonth: 18 },
      { min: 11, max: 20,  pricePerCanMonth: 16 },
      { min: 21, max: 50,  pricePerCanMonth: 14 },
      { min: 51, max: Infinity, pricePerCanMonth: 12 }
    ],
    visitsPerMonth: { biweekly: 2, monthly: 1 }
  },

  dumpsterPad: {
    small:  { weekly: 150, biweekly: 100, monthly: 75  },
    medium: { weekly: 250, biweekly: 175, monthly: 125 },
    large:  { weekly: 400, biweekly: 275, monthly: 200 },
    visitsPerMonth: { weekly: 4, biweekly: 2, monthly: 1 }
  },

  deepCleanOneTime: { standard: 35, heavy: 50, extreme: 75 },

  billingDiscounts: { monthly: 0, quarterly: 0.05, annual: 0.10 },

  multiLocationDiscount: (locationsCount) => {
    const n = Number(locationsCount || 1);
    if (n >= 7) return 0.10;
    if (n >= 4) return 0.08;
    if (n >= 2) return 0.05;
    return 0;
  }
};

// ==============================
// State
// ==============================
let state = {
  sales: [],      // visits
  contracts: [],  // kept (local-only for now)
  reps: [],       // operators
  orders: [],     // intake orders from Supabase
  assignments: [],// route assignments
  customers: [],
  routes: [],
  routeStops: [],
  leads: [],
  jobs: [],
  jobPhotos: [],
  missingTables: [],
  settings: { cycle_anchor: '2026-04-01', lock_window_days: 7 },
  config: DEFAULT_CONFIG
};

// ==============================
// Supabase setup
// ==============================

function supabaseReady() {
    const url = String(window.SUPABASE_URL || '');
    const key = String(window.SUPABASE_ANON_KEY || '');
  
    // Treat placeholder strings as "not configured"
    const looksPlaceholder =
      url.includes('YOURPROJECT') ||
      key.includes('YOUR_SUPABASE') ||
      key.length < 30;
  
    if (looksPlaceholder) return false;
  
    return !!(url && key && window.supabase && typeof window.supabase.createClient === 'function');
}
  
function initSupabase() {
  const STATE_KEY = '__PROCAN__';
  const st = (window[STATE_KEY] = window[STATE_KEY] || {});

  // Reuse singleton if already created
  if (st.supabaseClient) {
    supabaseClient = st.supabaseClient;
    return supabaseClient;
  }

  if (!supabaseReady()) return null;

  // Guard against using the wrong key type
  const key = String(window.SUPABASE_ANON_KEY || '');
  if (key.startsWith('sb_publishable_')) {
    console.warn('SUPABASE_ANON_KEY looks like a "publishable" key. You must paste the project anon public key from Supabase Settings → API.');
  }

  st.supabaseClient = window.supabase.createClient(
    window.SUPABASE_URL,
    window.SUPABASE_ANON_KEY,
    {
      auth: {
        storageKey: 'procan_auth',
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    }
  );
  supabaseClient = st.supabaseClient;
  return supabaseClient;
}


// ==============================
// UI helpers
// ==============================
function showAlert(message, type = 'success') {
  const container = document.getElementById('alertContainer');
  if (!container) return;

  const alert = document.createElement('div');
  alert.className = `alert ${type}`;
  alert.textContent = message;
  container.innerHTML = '';
  container.appendChild(alert);

  setTimeout(() => {
    alert.style.opacity = '0';
    alert.style.transition = 'opacity 0.3s';
    setTimeout(() => alert.remove(), 300);
  }, 3500);
}

function renderDbNotice(){
  const el = document.getElementById('dbNotice');
  if (!el) return;
  const missing = state.missingTables || [];
  if (!missing.length){
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.style.display = 'block';
  el.innerHTML = `
    <div class="db-notice-inner">
      <div class="db-notice-title">Database not initialized</div>
      <div class="db-notice-text">
        Missing tables in Supabase: <b>${missing.join(', ')}</b>.<br/>
        Run <b>supabase-schema.sql</b> in Supabase → SQL Editor, then refresh.
      </div>
      <button class="btn-secondary btn-small" id="btnDbHowTo" type="button">Show steps</button>
    </div>
  `;
  const btn = document.getElementById('btnDbHowTo');
  if (btn){
    btn.onclick = () => {
      showAlert('Supabase → SQL Editor → paste/run supabase-schema.sql from this repo. Then refresh.', 'info');
    };
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

function money(n) {
  const v = Number(n || 0);
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function setDefaultDate() {
  const el = document.getElementById('saleDate');
  if (el) el.value = new Date().toISOString().split('T')[0];
}

// ==============================
// ==============================
// Auth gate (uses existing #authGate in index.html)
// ==============================
function setAuthMsg(text, kind = 'info') {
  const el = document.getElementById('authMsg');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = text || '';
  el.className = 'empty-state';
  el.style.border = kind === 'error' ? '1px solid rgba(255,80,80,0.35)' : '1px solid rgba(255,255,255,0.12)';
}

function showAuthGate() {
  const gate = document.getElementById('authGate');
  if (gate) gate.style.display = 'flex';
}
function hideAuthGate() {
  const gate = document.getElementById('authGate');
  if (gate) gate.style.display = 'none';
  const msg = document.getElementById('authMsg');
  if (msg) msg.style.display = 'none';
}

function showAppShell() {
  const app = document.getElementById('appShell');
  if (app) app.style.display = 'block';
}
function hideAppShell() {
  const app = document.getElementById('appShell');
  if (app) app.style.display = 'none';
}

// Prevent “stuck on boot” no matter what.
function hideStartupOverlay() {
  try { revealContentWrapper(); } catch (_) {}
  const overlay = document.getElementById('startupOverlay');
  if (!overlay) return;
  overlay.style.transition = 'opacity 0.25s ease';
  overlay.style.opacity = '0';
  overlay.style.pointerEvents = 'none';
  setTimeout(() => overlay.remove(), 260);
}

// Bind login/signup buttons to Supabase auth.
// Safe to call multiple times.
function bindAuthGate() {
  const btnLogin = document.getElementById('btnLogin');
  const btnSignup = document.getElementById('btnSignup');
  if (!btnLogin || !btnSignup) return;

  // Avoid double-binding
  if (btnLogin.dataset.bound === '1') return;
  btnLogin.dataset.bound = '1';
  btnSignup.dataset.bound = '1';

  btnLogin.addEventListener('click', async () => {
    try {
      if (!supabaseClient) {
        setAuthMsg('Supabase client not initialized.', 'error');
        return;
      }
      const email = String(document.getElementById('authEmail')?.value || '').trim();
      const password = String(document.getElementById('authPassword')?.value || '').trim();
      if (!email || !password) {
        setAuthMsg('Enter email and password.', 'error');
        return;
      }
      setAuthMsg('Logging in…');
      const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;

      hideAuthGate();
      showAppShell();

      await syncFromSupabase();
      saveStateLocal();
      renderEverything();
    } catch (e) {
      console.error(e);
      setAuthMsg(`Login failed: ${e?.message || 'Unknown error'}`, 'error');
    }
  });

  btnSignup.addEventListener('click', async () => {
    try {
      if (!supabaseClient) {
        setAuthMsg('Supabase client not initialized.', 'error');
        return;
      }
      const email = String(document.getElementById('authEmail')?.value || '').trim();
      const password = String(document.getElementById('authPassword')?.value || '').trim();
      if (!email || !password) {
        setAuthMsg('Enter email and password.', 'error');
        return;
      }
      setAuthMsg('Creating account…');
      const { error } = await supabaseClient.auth.signUp({ email, password });
      if (error) throw error;

      setAuthMsg('Account created. If email confirmation is required, confirm then login.', 'info');
    } catch (e) {
      console.error(e);
      setAuthMsg(`Signup failed: ${e?.message || 'Unknown error'}`, 'error');
    }
  });
}

// Bind logout button (top-right). Safe to call multiple times.
function bindLogout() {
  const btn = document.getElementById('btnLogout');
  if (!btn) return;
  if (btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';

  btn.addEventListener('click', async () => {
    try {
      // Local-only mode (no Supabase)
      if (!supabaseClient) {
        showAlert('No Supabase session to sign out of.', 'error');
        hideAppShell();
        showAuthGate();
        return;
      }

      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = 'Logging out…';

      // Prefer local sign-out to avoid network 403s on some setups.
      const { error } = await supabaseClient.auth.signOut({ scope: 'local' });
      if (error) {
        // Even if the network sign-out fails, clear local UI/session state.
        console.warn('Sign out error (continuing):', error);
      }

      // Immediately reset UI (don’t rely only on onAuthStateChange timing)
      hideAppShell();
      showAuthGate();
      setAuthMsg('Logged out.', 'info');
    } catch (e) {
      console.error('Logout failed:', e);
      showAlert(`Logout failed: ${e?.message || 'Unknown error'}`, 'error');
    } finally {
      try {
        btn.disabled = false;
        btn.textContent = 'Logout';
      } catch (_) {}
    }
  });
}


function ensureAuthOverlay() { /* legacy no-op: using #authGate */ }

async function requireAuth() {
  // If no Supabase configured, allow local mode and show app.
  if (!supabaseClient) {
    hideAuthGate();
    showAppShell();
    return true;
  }

  bindAuthGate();
      bindLogout();

  // Add a timeout so auth calls can’t hang forever.
  const timeoutMs = 60000;
  const withTimeout = (p) => Promise.race([
      p,
      new Promise((resolve) => setTimeout(() => resolve({ __timed_out: true }), timeoutMs))
    ]);
try {
    const res = await withTimeout(supabaseClient.auth.getSession());
    if (res && res.__timed_out) {
      // Don't force-logout on slow networks. If we already have a cached session, keep the app open.
      if (window.__cachedSession) {
        hideAuthGate();
        showAppShell();
        showAlert('⚠️ Slow auth check — staying signed in.', 'info');
        return true;
      }
      hideAppShell();
      showAuthGate();
      setAuthMsg('Session check is taking longer than expected. Please try again.', 'info');
      return false;
    }
    const { data } = res || {};
    const session = data?.session;
    try { window.__cachedSession = session || null; } catch (_) {}

    if (!session) {
      hideAppShell();
      showAuthGate();
      return false;
    }

    hideAuthGate();
    showAppShell();
    return true;
  } catch (e) {
    console.error(e);
    hideAppShell();
    showAuthGate();
    setAuthMsg(e?.message || 'Auth error', 'error');
    return false;
  }

  state.missingTables = Array.from(__missing);
  renderDbNotice();
}



function revealContentWrapper() {
  const cw = document.getElementById('contentWrapper');
  if (!cw) return;
  // Use a class so CSS transition can animate cleanly
  cw.classList.add('ready');
}

// ==============================
// Local fallback (kept)
// ==============================
function loadStateLocal() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      state = { ...state, ...parsed };
    }
  } catch (error) {
    console.error('Error loading state:', error);
    showAlert('⚠️ Error loading data', 'error');
  }

  state.sales = Array.isArray(state.sales) ? state.sales : [];
  state.contracts = Array.isArray(state.contracts) ? state.contracts : [];
  state.reps = Array.isArray(state.reps) ? state.reps : [];
  state.orders = Array.isArray(state.orders) ? state.orders : [];
  state.assignments = Array.isArray(state.assignments) ? state.assignments : [];
  state.config = { ...DEFAULT_CONFIG, ...(state.config || {}) };
}

function saveStateLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(BACKUP_KEY, JSON.stringify({ ...state, backupDate: new Date().toISOString() }));
  } catch (error) {
    console.error('Error saving state:', error);
  }
}


function isMissingTableError(err, tableName){
  const msg = (err && (err.message || err.error_description)) || '';
  const code = err && err.code;
  return code === 'PGRST205' || msg.includes(`Could not find the table 'public.${tableName}'`) || msg.includes(`Could not find the table "public.${tableName}"`);
}

// ==============================
// Supabase sync
// ==============================
async function syncFromSupabase() {
  if (!supabaseClient) return;
  const __missing = new Set();
  const markMissing = (t) => { if (t) __missing.add(t); };

  // Operators
  {
    const { data, error } = await supabaseClient.from('operators').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    state.reps = (data || []).map(o => ({
      id: o.id,
      name: o.name,
      payoutRate: Number(o.payout_rate ?? 30),
      isManager: !!o.is_manager,
      active: !!o.active
    }));
  }

  // Orders (from intake)
  {
    const { data, error } = await supabaseClient.from('orders').select('*').order('created_at', { ascending: false }).limit(250);
    if (error) throw error;
    state.orders = data || [];
  }

  // Assignments
  {
    const { data, error } = await supabaseClient.from('assignments').select('*').order('service_date', { ascending: true });
    if (error) throw error;
    state.assignments = data || [];
  }

  // Customers (prospecting + deposits + active accounts)
  {
    const { data, error } = await supabaseClient.from('customers').select('*').order('created_at', { ascending: false }).limit(500);
    if (error) {
      if (isMissingTableError(error, 'customers')) {
        state.customers = [];
      } else {
        throw error;
      }
    } else {
      state.customers = data || [];
    }
  }

  // Routes
  {
    const { data, error } = await supabaseClient.from('routes').select('*').order('created_at', { ascending: true });
    if (error) {
      if (isMissingTableError(error, 'routes')) {
        state.routes = [];
      } else {
        throw error;
      }
    } else {
      state.routes = data || [];
    }
  }

  // Route Stops
  {
    const { data, error } = await supabaseClient.from('route_stops').select('*').order('created_at', { ascending: true }).limit(2000);
    if (error) {
      if (isMissingTableError(error, 'route_stops')) {
        state.routeStops = [];
        markMissing('route_stops');
      } else {
        throw error;
      }
    } else {
      state.routeStops = data || [];
    }
  }

  // Leads
  {
    const { data, error } = await supabaseClient.from('leads').select('*').order('updated_at', { ascending: false }).limit(1000);
    if (error) {
      if (isMissingTableError(error, 'leads')) {
        state.leads = [];
        markMissing('leads');
        markMissing('leads');
      } else {
        throw error;
      }
    } else {
      state.leads = data || [];
    }
  }

  // Jobs (dispatch instances)
  {
    const { data, error } = await supabaseClient.from('jobs').select('*').order('job_date', { ascending: false }).limit(2000);
    if (error) {
      if (isMissingTableError(error, 'jobs')) {
        state.jobs = [];
        markMissing('jobs');
        markMissing('jobs');
      } else {
        throw error;
      }
    } else {
      state.jobs = data || [];
    }
  }

  // Job Photos (pointers)
  {
    const { data, error } = await supabaseClient.from('job_photos').select('*').order('created_at', { ascending: false }).limit(2000);
    if (error) {
      if (isMissingTableError(error, 'job_photos')) {
        state.jobPhotos = [];
        markMissing('job_photos');
        markMissing('job_photos');
      } else {
        throw error;
      }
    } else {
      state.jobPhotos = data || [];
    }
  }

  // Settings (single-row key/value)
  {
    const { data, error } = await supabaseClient.from('settings').select('*');
    if (error) {
      if (!isMissingTableError(error, 'settings')) throw error;
    } else {
      const kv = {};
      for (const row of (data || [])) kv[row.key] = row.value;
      if (kv.cycle_anchor) state.settings.cycle_anchor = String(kv.cycle_anchor);
      if (kv.lock_window_days != null) state.settings.lock_window_days = Number(kv.lock_window_days);
    }
  }

  // Visits
  // Visits (optional, your manual “Log Completed Job”)
  {
    const { data, error } = await supabaseClient.from('visits').select('*').order('service_date', { ascending: false }).limit(500);
    if (error) throw error;
    state.sales = (data || []).map(v => ({
      id: v.id,
      repId: v.operator_id,
      customerName: v.customer_name,
      date: String(v.service_date),
      product: v.service_type,
      units: v.quantity,
      billingFrequency: v.billing_frequency,
      locationsCount: v.locations_count,
      jobType: v.job_type,
      visitRevenue: Number(v.visit_revenue || 0),
      fees: Number(v.fees || 0),
      activationStatus: v.payout_status || 'due',
      deepCleanEnabled: !!v.deep_clean_enabled,
      deepCleanCondition: v.deep_clean_condition || null,
      deepCleanTotal: Number(v.deep_clean_total || 0)
    }));
  }
}

async function upsertOperator(rep) {
  if (!supabaseClient) return;
  const payload = {
    id: rep.id || undefined,
    name: rep.name,
    payout_rate: Number(rep.payoutRate ?? 30),
    is_manager: !!rep.isManager,
    active: rep.active !== false
  };
  const { data, error } = await supabaseClient.from('operators').upsert(payload).select('*').single();
  if (error) {
    if (isMissingTableError(error, 'operators')) {
      showAlert("Can't save operator: Supabase table 'operators' is missing. Run supabase-schema.sql first.", 'error');
      return null;
    }
    throw error;
  }
  return data;
}

async function insertVisit(visit) {
  if (!supabaseClient) return;
  const payload = {
    operator_id: visit.repId || null,
    customer_name: visit.customerName,
    service_date: visit.date,
    service_type: visit.product || '',
    quantity: Number(visit.units || 1),
    billing_frequency: visit.billingFrequency || 'monthly',
    locations_count: Number(visit.locationsCount || 1),
    job_type: visit.jobType || 'recurring',
    visit_revenue: Number(visit.visitRevenue || 0),
    fees: Number(visit.fees || 0),
    payout_status: visit.activationStatus || 'due',
    deep_clean_enabled: !!visit.deepCleanEnabled,
    deep_clean_condition: visit.deepCleanCondition || null,
    deep_clean_total: Number(visit.deepCleanTotal || 0)
  };
  const { data, error } = await supabaseClient.from('visits').insert(payload).select('*').single();
  if (error) throw error;
  return data;
}

async function assignOrder({ orderId, operatorId, serviceDate, sequence = 1 }) {
  if (!supabaseClient) return;

  // Upsert assignment (unique(order_id) prevents dupes)
  const { data: a, error: aErr } = await supabaseClient
    .from('assignments')
    .upsert({
      order_id: orderId,
      operator_id: operatorId,
      service_date: serviceDate,
      sequence
    }, { onConflict: 'order_id' })
    .select('*')
    .single();

  if (aErr) throw aErr;

  // Mark order scheduled
  const { error: oErr } = await supabaseClient
    .from('orders')
    .update({ status: 'scheduled' })
    .eq('id', orderId);

  if (oErr) throw oErr;

  return a;
}

// ==============================
// Existing helpers (minimal needed pieces kept)
// ==============================
function repById(id) {
  return state.reps.find(r => r.id === id) || null;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ==============================
// Tabs
// ==============================

function __setActiveNav(tab){
  try{
    const map = {dispatch:'Dispatch', leads:'Leads', map:'Map', operators:'Operators'};
    const t = document.getElementById('pageTitle');
    if(t) t.textContent = map[tab] || 'ProCan';
    const sub = document.getElementById('pageSubtle');
    if(sub){
      sub.textContent = (tab==='dispatch') ? "Today’s operations" :
                        (tab==='leads') ? "Prospecting + follow-ups" :
                        (tab==='map') ? "Visual routes + pins" :
                        (tab==='operators') ? "Team + payouts" : "";
    }
    ['dispatch','leads','map','operators'].forEach(k=>{
      const b=document.getElementById('nav-'+k);
      if(b) b.classList.toggle('active', k===tab);
    });
  }catch(_){}
}

function switchTab(tab) {
  __setActiveNav(tab);
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

  const btn = Array.from(document.querySelectorAll('.tab'))
    .find(b => (b.getAttribute('onclick') || '').includes(`'${tab}'`));
  if (btn) btn.classList.add('active');

  const contentId =
    tab === 'dispatch' ? 'dispatchTab'
    : tab === 'map' ? 'mapTab'
    : tab === 'leads' ? 'leadsTab'
    : tab === 'orders' ? 'ordersTab'
    : tab === 'routes' ? 'routesTab'
    : tab === 'operators' ? 'operatorsTab'
    : 'dispatchTab';

  document.getElementById(contentId)?.classList.add('active');

  // render lazy panels
  if (tab === 'dispatch') renderDispatchPanel();
  if (tab === 'map') renderMapPanel();
  if (tab === 'leads') renderLeadsPanel();
  if (tab === 'orders') renderOrdersPanel();
  if (tab === 'routes') renderRoutesPanel();
  if (tab === 'operators') { try { renderRepsList(); } catch(e){} }
}
window.switchTab = switchTab;

// ==============================
// Dispatch (Level 3)
// ==============================

function fmtTime(t){
  if (!t) return '';
  const s = String(t);
  return s.slice(0,5);
}

function jobBadge(status){
  const s = String(status||'').toLowerCase();
  if (s === 'completed') return '<span class="badge good">Completed</span>';
  if (s === 'in_progress') return '<span class="badge warn">In progress</span>';
  if (s === 'en_route') return '<span class="badge warn">En route</span>';
  if (s === 'skipped' || s === 'cancelled') return '<span class="badge bad">Skipped</span>';
  return '<span class="badge">Scheduled</span>';
}

function jobTarget(job){
  if (job.customer_id){
    const c = state.customers.find(x => x.id === job.customer_id);
    return {
      label: c?.biz_name || 'Customer',
      address: c?.address || job.address || '',
      lat: c?.lat ?? job.lat ?? null,
      lng: c?.lng ?? job.lng ?? null,
      tw_start: c?.tw_start ?? job.tw_start ?? null,
      tw_end: c?.tw_end ?? job.tw_end ?? null,
      service_minutes: c?.service_minutes ?? job.service_minutes ?? 15,
      kind: 'customer'
    };
  }
  if (job.lead_id){
    const l = state.leads.find(x => x.id === job.lead_id);
    return {
      label: l?.biz_name || 'Lead',
      address: l?.address || job.address || '',
      lat: l?.lat ?? job.lat ?? null,
      lng: l?.lng ?? job.lng ?? null,
      tw_start: job.tw_start ?? l?.follow_up_time ?? null,
      tw_end: job.tw_end ?? null,
      service_minutes: job.service_minutes ?? 10,
      kind: 'lead'
    };
  }
  return { label: 'Stop', address: job.address || '', lat: job.lat ?? null, lng: job.lng ?? null, tw_start: job.tw_start ?? null, tw_end: job.tw_end ?? null, service_minutes: job.service_minutes ?? 15, kind: 'generic' };
}

function nearestNeighborOrder(stops){
  // Greedy order by geographic distance (good enough + fast for field ops)
  const pts = stops.filter(s => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)));
  if (pts.length <= 2) return stops.map(s => s.id);

  const remaining = new Map(pts.map(p => [p.id, p]));
  const ordered = [];
  let current = pts[0];
  ordered.push(current.id);
  remaining.delete(current.id);

  const dist2 = (a,b) => {
    const dx = (Number(a.lat)-Number(b.lat));
    const dy = (Number(a.lng)-Number(b.lng));
    return dx*dx + dy*dy;
  };

  while (remaining.size){
    let best = null;
    let bestD = Infinity;
    for (const p of remaining.values()){
      const d = dist2(current, p);
      if (d < bestD){ bestD = d; best = p; }
    }
    if (!best) break;
    ordered.push(best.id);
    remaining.delete(best.id);
    current = best;
  }

  // Append any without coords after
  const noCoords = stops.filter(s => !Number.isFinite(Number(s.lat)) || !Number.isFinite(Number(s.lng))).map(s => s.id);
  return [...ordered, ...noCoords];
}

async function updateJob(jobId, patch){
  if (!supabaseClient) throw new Error('Supabase not configured.');
  const { error } = await supabaseClient.from('jobs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', jobId);
  if (error) throw error;
}

async function addJobEvent(jobId, event_type, detail){
  if (!supabaseClient) return;
  try{
    await supabaseClient.from('job_events').insert({ job_id: jobId, actor_user_id: (await supabaseClient.auth.getUser())?.data?.user?.id || null, event_type, detail: detail || {} });
  } catch(_){ /* non-fatal */ }
}


async function autofillJobsFromOrders(dateStr){
  // Housecall-style automation: pull paid/new orders (from intake webhook) and ensure jobs exist for this date.
  if(!supabaseClient) return;
  const date = dateStr || new Date().toISOString().slice(0,10);
  await autofillJobsFromOrders(date);
  // Fetch jobs for the date once (to avoid dupes)
  const { data: existingJobs, error: ejErr } = await supabaseClient
    .from('jobs')
    .select('id,address,lat,lng,operator_id,job_date,status')
    .eq('job_date', date)
    .limit(5000);
  if(ejErr){
    console.warn('autofill: jobs fetch error', ejErr);
    return;
  }
  const existsKey = new Set((existingJobs||[]).map(j => (String(j.address||'').trim().toLowerCase())));
  // Orders table is written by intake webhook
  const { data: orders, error: oErr } = await supabaseClient
    .from('orders')
    .select('id,order_id,biz_name,address,preferred_service_day,start_date,cadence,notes,status')
    .in('status',['new','active','deposited','paid'])
    .order('created_at',{ascending:false})
    .limit(2000);
  if(oErr){
    console.warn('autofill: orders fetch error', oErr);
    return;
  }
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const dow = dayNames[new Date(date+'T12:00:00').getDay()];
  const normalize = (s)=>String(s||'').trim().toLowerCase();
  const matchPreferred = (pref)=>{
    const p=normalize(pref);
    if(!p) return true; // if no pref, allow (you can assign manually)
    if(p.startsWith(dow.slice(0,3).toLowerCase())) return true;
    if(p===normalize(dow)) return true;
    return false;
  };
  const canStart = (start)=>{
    const s=String(start||'').slice(0,10);
    return !s || s<=date;
  };

  // Build insert rows
  const toInsert=[];
  for(const o of (orders||[])){
    const address = String(o.address||'').trim();
    if(!address) continue;
    if(!canStart(o.start_date)) continue;
    if(!matchPreferred(o.preferred_service_day)) continue;
    const key = address.toLowerCase();
    if(existsKey.has(key)) continue;

    // attempt to geocode now (best effort)
    let lat=null,lng=null;
    try{
      const geo = await __geocodeAddress(address);
      if(geo){ lat=geo.lat; lng=geo.lng; }
    }catch(_){}
    toInsert.push({
      job_date: date,
      address,
      lat, lng,
      status: 'scheduled',
      stop_order: 0,
      notes: (o.biz_name ? `Order: ${o.biz_name}` : 'Order') + (o.order_id ? ` (#${o.order_id})` : '') + (o.notes ? ` — ${o.notes}` : '')
    });
    existsKey.add(key);
    // throttle inserts size per render
    if(toInsert.length>=30) break;
  }

  if(toInsert.length){
    const { error: insErr } = await supabaseClient.from('jobs').insert(toInsert);
    if(insErr){
      console.warn('autofill: insert jobs error', insErr);
    }else{
      console.log('autofill: inserted jobs', toInsert.length);
    }
  }
}

async function renderDispatchPanel(){
  const panel = document.getElementById('dispatchPanel');
  if (!panel) return;

  const todayISO = new Date().toISOString().split('T')[0];
  const date = String(
    document.getElementById('dispatchDate')?.value ||
    document.getElementById('mapDate')?.value ||
    todayISO
  );

  // Dispatch = single mental model: Date → Operators → Stops → Map
  panel.innerHTML = `
    <div class="dispatch-shell">
      <div class="dispatch-topbar">
        <div class="dispatch-title">
          <div class="dispatch-title-main">Dispatch</div>
          <div class="dispatch-title-sub">Daily operations console</div>
        </div>

        <div class="dispatch-controls">
          <label class="control">
            <span>Date</span>
            <input id="dispatchDate" type="date" value="${escapeHtml(date)}">
          </label>

          <div class="control-group">
            <button class="btn-secondary" type="button" onclick="renderDispatchPanel()">Refresh</button>
            <button class="btn-primary" type="button" onclick="generateDailyJobsFromRoutes()">Generate jobs</button>
            <button class="btn-secondary" type="button" onclick="optimizeAllOperators()">Optimize all</button>
            <button class="btn-secondary" type="button" onclick="switchTab('map'); __mapFocus = { type:'day', date: '${escapeHtml(date)}' }; renderMapPanel();">Map</button>
          </div>
        </div>
      </div>

      <div class="dispatch-columns" id="dispatchBoard"></div>
    </div>
  `;

  const board = document.getElementById('dispatchBoard');
  if (!board) return;

  const d = String(document.getElementById('dispatchDate')?.value || todayISO);
  const dayJobs = (state.jobs||[]).filter(j => String(j.job_date) === d);

  const ops = (state.reps || []).filter(r => r.active !== false);
  if (!ops.length){
    board.innerHTML = `<div class="empty-state">Add at least one operator first.</div>`;
    return;
  }

  const jobsByOp = new Map(ops.map(o => [o.id, []]));
  const unassigned = [];
  for (const j of dayJobs){
    if (j.operator_id && jobsByOp.has(j.operator_id)) jobsByOp.get(j.operator_id).push(j);
    else unassigned.push(j);
  }

  const normalizeOrders = (jobs) => {
    jobs.sort((a,b) => (Number(a.stop_order||9999) - Number(b.stop_order||9999)) || String(a.id).localeCompare(String(b.id)));
    jobs.forEach((j, idx) => { j.stop_order = idx + 1; });
  };

  const colMetrics = (jobs) => {
    let svc = 0;
    let tw = 0;
    let completed = 0;
    for (const j of jobs){
      const t = jobTarget(j);
      svc += Number(t.service_minutes || 0);
      if (t.tw_start || t.tw_end) tw += 1;
      if (String(j.status||'').toLowerCase() === 'completed') completed += 1;
    }
    return { svc, tw, completed, total: jobs.length };
  };

  const renderStopCard = (j, opId) => {
    const t = jobTarget(j);
    const tw = (t.tw_start || t.tw_end) ? `${fmtTime(t.tw_start)}–${fmtTime(t.tw_end)}` : '';
    const status = String(j.status || 'scheduled');

    return `
      <div class="stop-card"
           draggable="true"
           data-job-id="${escapeHtml(String(j.id))}"
           data-op-id="${escapeHtml(String(opId||''))}">
        <div class="stop-head">
          <div class="stop-title">
            <span class="stop-order">#${escapeHtml(String(j.stop_order ?? 999))}</span>
            <span class="stop-name">${escapeHtml(t.label)}</span>
          </div>
          <div class="stop-badge">${jobBadge(status)}</div>
        </div>

        <div class="stop-meta">${escapeHtml(t.address || '')}</div>
        <div class="stop-meta">
          ${tw ? `Window: <b>${escapeHtml(tw)}</b> • ` : ''}Svc: <b>${escapeHtml(String(t.service_minutes||15))}m</b>
        </div>

        <div class="stop-actions">
          <button class="btn-secondary btn-small" type="button" onclick="setJobStatus('${j.id}','en_route')">En route</button>
          <button class="btn-secondary btn-small" type="button" onclick="setJobStatus('${j.id}','in_progress')">Start</button>
          <button class="btn-primary btn-small" type="button" onclick="setJobStatus('${j.id}','completed')">Complete</button>
          <button class="btn-secondary btn-small" type="button" onclick="setJobStatus('${j.id}','skipped')">Skip</button>
          <button class="btn-secondary btn-small" type="button" onclick="openPhotoUpload('${j.id}')">Photo</button>
          <button class="btn-secondary btn-small" type="button" onclick="openReassign('${j.id}')">${opId ? 'Reassign' : 'Assign'}</button>
          <button class="btn-secondary btn-small" type="button" onclick="focusJobOnMap('${j.id}', '${escapeHtml(d)}')">Map</button>
        </div>
      </div>
    `;
  };

  const renderColumn = (title, opId, jobs, isUnassigned=false) => {
    normalizeOrders(jobs);
    const m = colMetrics(jobs);

    const headRight = isUnassigned
      ? `<div class="col-metrics"><span>${m.total} stops</span></div>`
      : `
        <div class="col-metrics">
          <span>${m.completed}/${m.total}</span>
          <span>${m.svc ? `${m.svc}m` : '—'}</span>
          <span>${m.tw ? `${m.tw} windows` : '—'}</span>
        </div>
      `;

    const tools = isUnassigned ? '' : `
      <div class="col-tools">
        <button class="btn-secondary btn-small" type="button" onclick="optimizeOperator('${opId}')">Optimize</button>
        <button class="btn-secondary btn-small" type="button" onclick="focusOperatorOnMap('${opId}', '${escapeHtml(d)}')">View map</button>
      </div>
    `;

    return `
      <section class="dispatch-column ${isUnassigned ? 'is-unassigned' : ''}"
               data-drop-op-id="${escapeHtml(String(opId||''))}">
        <header class="dispatch-col-head">
          <div class="col-title">
            <div class="col-name">${escapeHtml(title)}</div>
            ${headRight}
          </div>
          ${tools}
        </header>

        <div class="dispatch-dropzone" data-drop-op-id="${escapeHtml(String(opId||''))}">
          ${jobs.length ? jobs.map(j => renderStopCard(j, opId)).join('') : `<div class="col-empty">No stops</div>`}
        </div>
      </section>
    `;
  };

  const cols = [];
  cols.push(renderColumn('Unassigned', '', unassigned, true));
  for (const op of ops){ cols.push(renderColumn(op.name, op.id, jobsByOp.get(op.id) || [], false)); }
  board.innerHTML = cols.join('');

  attachDispatchDnD(d);
}
window.renderDispatchPanel = renderDispatchPanel;

// Drag/drop: move stops between operators and reorder within a column.
function attachDispatchDnD(dateISO){
  const board = document.getElementById('dispatchBoard');
  if (!board) return;

  const getDayJobsByOp = () => {
    const dayJobs = (state.jobs||[]).filter(j => String(j.job_date) === String(dateISO));
    const groups = new Map();
    for (const j of dayJobs){
      const op = j.operator_id ? String(j.operator_id) : '';
      if (!groups.has(op)) groups.set(op, []);
      groups.get(op).push(j);
    }
    // sort by stop_order
    for (const [k, arr] of groups){
      arr.sort((a,b) => (Number(a.stop_order||9999) - Number(b.stop_order||9999)) || String(a.id).localeCompare(String(b.id)));
    }
    return groups;
  };

  let dragJobId = null;

  board.querySelectorAll('.stop-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      dragJobId = card.getAttribute('data-job-id');
      card.classList.add('dragging');
      try{ e.dataTransfer.setData('text/plain', dragJobId); } catch(_){}
      try{ e.dataTransfer.effectAllowed = 'move'; } catch(_){}
    });
    card.addEventListener('dragend', () => {
      dragJobId = null;
      card.classList.remove('dragging');
      board.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    });
    // Allow dropping onto a card to insert before it
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      const jobId = dragJobId || (function(){ try{return e.dataTransfer.getData('text/plain')}catch(_){return null}})();
      if (!jobId) return;

      const targetJobId = card.getAttribute('data-job-id');
      const targetOpId = card.getAttribute('data-op-id') || '';
      await moveJob(jobId, targetOpId, targetJobId, dateISO);
    });
  });

  // Dropzone drop = append to end
  board.querySelectorAll('.dispatch-dropzone').forEach(zone => {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drop-target'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drop-target'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('drop-target');
      const jobId = dragJobId || (function(){ try{return e.dataTransfer.getData('text/plain')}catch(_){return null}})();
      if (!jobId) return;
      const targetOpId = zone.getAttribute('data-drop-op-id') || '';
      await moveJob(jobId, targetOpId, null, dateISO);
    });
  });

  async function moveJob(jobId, targetOpId, insertBeforeJobId, dateISO){
    // Find job in state
    const job = (state.jobs||[]).find(j => String(j.id) === String(jobId));
    if (!job) return;

    const fromOp = job.operator_id ? String(job.operator_id) : '';
    const toOp = String(targetOpId || '');

    // Update operator_id immediately in memory
    job.operator_id = toOp || null;

    // Recompute ordering within the destination column (+ source column)
    const groups = getDayJobsByOp();

    const dest = groups.get(toOp) || [];
    // Ensure job is in dest
    const exists = dest.find(j => String(j.id) === String(jobId));
    if (!exists) dest.push(job);

    // Remove from source if different
    if (fromOp !== toOp){
      const src = groups.get(fromOp) || [];
      const idx = src.findIndex(j => String(j.id) === String(jobId));
      if (idx >= 0) src.splice(idx, 1);
      groups.set(fromOp, src);
    }

    // If inserting before another card in dest
    if (insertBeforeJobId){
      const i = dest.findIndex(j => String(j.id) === String(jobId));
      if (i >= 0) dest.splice(i, 1);
      const beforeIdx = dest.findIndex(j => String(j.id) === String(insertBeforeJobId));
      if (beforeIdx >= 0) dest.splice(beforeIdx, 0, job);
      else dest.push(job);
    }

    // normalize stop_order
    dest.forEach((j, idx) => { j.stop_order = idx + 1; });
    groups.set(toOp, dest);

    const updates = [];
    // Persist job operator_id + stop_order for affected groups (src + dest)
    const affectedOps = new Set([fromOp, toOp]);
    for (const opId of affectedOps){
      const arr = groups.get(opId) || [];
      arr.forEach((j, idx) => {
        updates.push({ id: j.id, operator_id: opId || null, stop_order: idx + 1 });
      });
    }

    // Deduplicate by id (last write wins)
    const byId = new Map();
    for (const u of updates) byId.set(String(u.id), u);
    const payload = Array.from(byId.values());

    try{
      if (supabaseClient && payload.length){
        // Update sequentially to keep it simple/reliable
        for (const u of payload){
          await supabaseClient.from('jobs').update({ operator_id: u.operator_id, stop_order: u.stop_order }).eq('id', u.id);
        }
      }
    }catch(err){
      console.warn('moveJob persist failed', err);
    }

    // Re-render dispatch quickly and keep map in sync
    renderDispatchPanel();
    try{ renderMapPanel(); } catch(_){}
  }
}


window.setJobStatus = async function(jobId, status){
  try{
    const now = new Date().toISOString();
    const patch = { status };
    if (status === 'in_progress' && !state.jobs.find(j => j.id === jobId)?.actual_start) patch.actual_start = now;
    if (status === 'completed') patch.actual_end = now;
    await updateJob(jobId, patch);
    await addJobEvent(jobId, status, { status });
    await syncFromSupabase();
    renderDispatchPanel();
    renderMapPanel();
  } catch(e){
    console.error(e);
    showAlert(`Job update failed: ${e?.message || 'error'}`, 'error');
  }
};

window.openReassign = async function(jobId){
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;
  const ops = (state.reps||[]).filter(r => r.active !== false);
  const opts = ops.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('');
  const cur = job.operator_id || '';
  const html = `
    <div class="card" style="max-width:520px; margin: 0 auto;">
      <div class="card-header"><h2>Assign / Reassign</h2></div>
      <div class="form-group">
        <label>Operator</label>
        <select id="reassignOp" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.22); color:#fff;">
          <option value="">Unassigned</option>
          ${opts}
        </select>
      </div>
      <div class="form-group">
        <label>Stop order</label>
        <input id="reassignOrder" type="number" min="1" step="1" value="${Number(job.stop_order||999)}" />
      </div>
      <div class="form-row">
        <button class="btn-primary" type="button" onclick="confirmReassign('${jobId}')">Save</button>
        <button class="btn-secondary" type="button" onclick="renderDispatchPanel()">Cancel</button>
      </div>
    </div>
  `;
  document.getElementById('dispatchPanel').innerHTML = html;
  const sel = document.getElementById('reassignOp');
  if (sel) sel.value = cur;
};

window.confirmReassign = async function(jobId){
  try{
    const op = String(document.getElementById('reassignOp')?.value || '');
    const ord = Number(document.getElementById('reassignOrder')?.value || 999);
    await updateJob(jobId, { operator_id: op || null, stop_order: Number.isFinite(ord) ? ord : 999 });
    await addJobEvent(jobId, 'reassigned', { operator_id: op || null, stop_order: ord });
    await syncFromSupabase();
    renderDispatchPanel();
  } catch(e){
    console.error(e);
    showAlert(`Reassign failed: ${e?.message || 'error'}`, 'error');
  }
};

window.optimizeOperator = async function(operatorId){
  try{
    const d = String(document.getElementById('dispatchDate')?.value || new Date().toISOString().split('T')[0]);
    const jobs = state.jobs.filter(j => String(j.job_date) === d && String(j.operator_id||'') === String(operatorId));
    const stops = jobs.map(j => {
      const t = jobTarget(j);
      return { id: j.id, lat: Number(t.lat), lng: Number(t.lng) };
    });
    const ordered = nearestNeighborOrder(stops);
    // Persist stop_order as 1..n in that order
    for (let i=0; i<ordered.length; i++){
      await updateJob(ordered[i], { stop_order: i+1 });
    }
    await syncFromSupabase();
    renderDispatchPanel();
    renderMapPanel();
    showAlert('✅ Route optimized', 'success');
  } catch(e){
    console.error(e);
    showAlert(`Optimize failed: ${e?.message || 'error'}`, 'error');
  }
};

window.optimizeAllOperators = async function(){
  const ops = (state.reps||[]).filter(r => r.active !== false);
  for (const op of ops){
    // eslint-disable-next-line no-await-in-loop
    await window.optimizeOperator(op.id);
  }
};

window.generateDailyJobsFromRoutes = async function(){
  try{
    if (!supabaseClient) throw new Error('Supabase not configured.');
    const d = String(document.getElementById('dispatchDate')?.value || new Date().toISOString().split('T')[0]);

    // Prevent duplicates: fetch existing job targets for the day
    const existing = new Set(state.jobs.filter(j => String(j.job_date) === d).map(j => j.customer_id || j.lead_id || j.id));

    // Create jobs for customers that are on a route and are due in the cycle week.
    const anchor = String(state.settings.cycle_anchor || '2026-04-01');
    const wk = cycleWeekForDate(anchor, d);
    const weekStart = nextWeekStartISO(anchor, d, wk);

    if (!(state.routes||[]).length || !(state.customers||[]).length){
      showAlert('Routes/customers not configured yet. Add routes & customers (from intake) or schedule leads manually.', 'error');
    }
    const dueCustomers = (state.customers||[])
      .filter(c => !!c.route_id)
      .filter(c => {
        const route = state.routes.find(r => r.id === c.route_id);
        if (!route) return false;
        const weeks = routeServiceWeeks(route);
        return weeks.includes(wk);
      });

    const rows = [];
    for (const c of dueCustomers){
      if (existing.has(c.id)) continue;
      const route = state.routes.find(r => r.id === c.route_id);
      rows.push({
        job_date: d,
        operator_id: route?.operator_id || null,
        customer_id: c.id,
        status: 'scheduled',
        stop_order: 999,
        service_minutes: Number(c.service_minutes || 15),
        tw_start: c.tw_start || null,
        tw_end: c.tw_end || null,
        address: c.address || null,
        lat: c.lat ?? null,
        lng: c.lng ?? null,
        notes: null
      });
    }

    if (!rows.length){
      showAlert('No new jobs to generate for that date.', 'success');
      return;
    }

    const { error } = await supabaseClient.from('jobs').insert(rows);
    if (error) throw error;
    await syncFromSupabase();
    renderDispatchPanel();
    renderMapPanel();
    showAlert(`✅ Generated ${rows.length} jobs`, 'success');
  } catch(e){
    console.error(e);
    showAlert(`Generate failed: ${e?.message || 'error'}`, 'error');
  }
};

// Photo uploads (proof)
window.openPhotoUpload = async function(jobId){
  const panel = document.getElementById('dispatchPanel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="card" style="max-width:560px; margin: 0 auto;">
      <div class="card-header"><h2>Upload proof photo</h2></div>
      <div class="form-group">
        <label>Caption (optional)</label>
        <input id="photoCaption" type="text" placeholder="e.g., After clean" />
      </div>
      <div class="form-group">
        <label>Choose image</label>
        <input id="photoFile" type="file" accept="image/*" />
      </div>
      <div class="form-row">
        <button class="btn-primary" type="button" onclick="uploadJobPhoto('${jobId}')">Upload</button>
        <button class="btn-secondary" type="button" onclick="renderDispatchPanel()">Back</button>
      </div>
      <div class="empty-state" id="photoMsg" style="margin-top:12px; display:none;"></div>
    </div>
  `;
};

window.uploadJobPhoto = async function(jobId){
  try{
    if (!supabaseClient) throw new Error('Supabase not configured.');
    const file = document.getElementById('photoFile')?.files?.[0];
    const caption = String(document.getElementById('photoCaption')?.value || '');
    const msg = document.getElementById('photoMsg');
    if (!file) throw new Error('Choose a file first.');

    // Requires a storage bucket named 'job-photos'
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${jobId}/${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`;

    const { error: upErr } = await supabaseClient.storage.from('job-photos').upload(path, file, { upsert: false });
    if (upErr) throw upErr;

    const { error: dbErr } = await supabaseClient.from('job_photos').insert({ job_id: jobId, path, caption: caption || null });
    if (dbErr) throw dbErr;

    await addJobEvent(jobId, 'photo_added', { path, caption });
    if (msg){ msg.style.display='block'; msg.textContent = '✅ Uploaded'; }
    await syncFromSupabase();
    renderDispatchPanel();
  } catch(e){
    console.error(e);
    showAlert(`Upload failed: ${e?.message || 'error'}`, 'error');
  }
};


async function geocodeAndPatchLead(id, address){
  const geo = await geocodeAddress(address);
  if (!geo) return { ok:false };
  const { error } = await supabaseClient.from('leads').update({ lat: geo.lat, lng: geo.lng, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
  return { ok:true };
}

async function geocodeAndPatchJob(id, address){
  const geo = await geocodeAddress(address);
  if (!geo) return { ok:false };
  const { error } = await supabaseClient.from('jobs').update({ lat: geo.lat, lng: geo.lng, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
  return { ok:true };
}

window.geocodeMissingForDay = async function(max=15){
  try{
    const date = String(document.getElementById('dispatchDate')?.value || document.getElementById('mapDate')?.value || new Date().toISOString().split('T')[0]);
    const dayJobs = (state.jobs||[]).filter(j => String(j.job_date) === date);
    const missingJobs = dayJobs.filter(j => (!Number.isFinite(Number(j.lat)) || !Number.isFinite(Number(j.lng))) && (j.address || '').trim());
    const missingLeads = (state.leads||[]).filter(l => (!Number.isFinite(Number(l.lat)) || !Number.isFinite(Number(l.lng))) && (l.address || '').trim());

    const targets = [];
    for (const j of missingJobs) targets.push({ type:'job', id:j.id, address:j.address });
    for (const l of missingLeads) targets.push({ type:'lead', id:l.id, address:l.address });

    if (!targets.length){
      showAlert('No missing coordinates found.', 'success');
      return;
    }

    let done = 0;
    for (const t of targets.slice(0, Number(max)||15)){
      if (t.type === 'job'){
        const r = await geocodeAndPatchJob(t.id, t.address);
        if (r.ok) done++;
      } else {
        const r = await geocodeAndPatchLead(t.id, t.address);
        if (r.ok) done++;
      }
      // small delay to reduce rate-limit risk
      await new Promise(res => setTimeout(res, 250));
    }

    await syncFromSupabase();
    try{ renderDispatchPanel(); }catch(_){}
    try{ renderMapPanel(); }catch(_){}
    showAlert(`✅ Geocoded ${done} item(s).`, 'success');
  } catch(e){
    console.error(e);
    showAlert(`Geocode failed: ${e?.message || 'error'}`, 'error');
  }
};
// ==============================
// Leads
// ==============================

async function geocodeAddress(address){
  const q = String(address||'').trim();
  if (!q) return null;
  try{
    // Free geocoder (rate-limited). For production, replace with Google/Mapbox.
    // Nominatim can be strict; include a basic Accept header and handle non-200/429 gracefully.
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      // avoid cached failures
      cache: 'no-store'
    });
    if (!r.ok) return null;
    const j = await r.json();
    const first = Array.isArray(j) ? j[0] : null;
    if (!first) return null;
    const lat = Number(first.lat), lng = Number(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch(e){
    return null;
  }
}

async function __geocodeAddress(address){
  return geocodeAddress(address);
}


async function renderLeadsPanel(){
  const panel = document.getElementById('leadsPanel');
  if (!panel) return;

  const status = String(document.getElementById('leadFilter')?.value || '');
  const list = (state.leads||[]).filter(l => !status || String(l.status) === status);

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; gap:10px; align-items:center; margin-bottom:12px;">
      <div style="font-weight:800;">Leads</div>
      <div style="display:flex; gap:8px; align-items:center;">
        <select id="leadFilter" onchange="renderLeadsPanel()" style="padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.22); color:#fff;">
          <option value="">All</option>
          <option value="new">New</option>
          <option value="presented">Presented</option>
          <option value="comeback">Comeback</option>
          <option value="not_interested">Not interested</option>
          <option value="dnk">Do not knock</option>
          <option value="sold">Sold</option>
        </select>
        <button class="btn-secondary btn-small" type="button" onclick="renderLeadsPanel()">Refresh</button>
      </div>
    </div>

    <div class="card" style="padding:14px; margin-bottom:12px;">
      <div style="font-weight:800; margin-bottom:10px;">Add lead</div>
      <div class="form-row">
        <div class="form-group">
          <label>Business name</label>
          <input id="leadBiz" type="text" placeholder="e.g., QuickMart" />
        </div>
        <div class="form-group">
          <label>Address</label>
          <input id="leadAddress" type="text" placeholder="123 Main St, City, ST" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Status</label>
          <select id="leadStatus" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.22); color:#fff;">
            <option value="new">New</option>
            <option value="presented">Presented</option>
            <option value="comeback">Comeback</option>
            <option value="not_interested">Not interested</option>
            <option value="dnk">Do not knock</option>
            <option value="sold">Sold</option>
          </select>
        </div>
        <div class="form-group">
          <label>Follow up date</label>
          <input id="leadFollow" type="date" />
        </div>
      </div>
      <div class="form-group">
        <label>Notes</label>
        <input id="leadNotes" type="text" placeholder="Gate code, best time, decision maker name…" />
      </div>
      <div class="form-row">
        <button class="btn-primary" type="button" onclick="createLead()">Save lead</button>
      </div>
    </div>

    <div style="display:grid; gap:10px;">
      ${list.map(l => {
        const op = repById(l.assigned_operator_id);
        return `
          <div style="border:1px solid rgba(255,255,255,0.10); border-radius:14px; padding:12px; background: rgba(0,0,0,0.18);">
            <div style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
              <div style="font-weight:800;">${escapeHtml(l.biz_name || 'Lead')}</div>
              <div class="badge">${escapeHtml(l.status || 'new')}</div>
            </div>
            <div style="opacity:.85; font-size:12px; margin-top:6px;">${escapeHtml(l.address)}</div>
            <div style="opacity:.75; font-size:12px; margin-top:6px;">Follow up: ${escapeHtml(l.follow_up_date || '—')} ${op ? `• Assigned: <b>${escapeHtml(op.name)}</b>` : ''}</div>
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
              <button class="btn-secondary btn-small" type="button" onclick="quickLeadStatus('${l.id}','comeback')">Comeback</button>
              <button class="btn-secondary btn-small" type="button" onclick="quickLeadStatus('${l.id}','dnk')">DNK</button>
              <button class="btn-secondary btn-small" type="button" onclick="quickLeadStatus('${l.id}','sold')">Sold</button>
              <button class="btn-secondary btn-small" type="button" onclick="scheduleLead('${l.id}')">Schedule</button>
            </div>
          </div>
        `;
      }).join('')}
      ${list.length ? '' : `<div class="empty-state">No leads match this filter.</div>`}
    </div>
  `;

  const f = document.getElementById('leadFilter');
  if (f) f.value = status;
}

window.renderLeadsPanel = renderLeadsPanel;

window.createLead = async function(){
  try{
    if (!supabaseClient) throw new Error('Supabase not configured.');
    const biz = String(document.getElementById('leadBiz')?.value || '').trim();
    const address = String(document.getElementById('leadAddress')?.value || '').trim();
    const status = String(document.getElementById('leadStatus')?.value || 'new');
    const follow = String(document.getElementById('leadFollow')?.value || '');
    const notes = String(document.getElementById('leadNotes')?.value || '').trim();
    if (!address) throw new Error('Address is required.');

    const geo = await geocodeAddress(address);
    if (!geo){
      showAlert('⚠️ Could not auto-locate that address. Lead saved, but it will not show on the map until it has coordinates. Use “Geocode missing” to retry.', 'error');
    }
    const payload = { biz_name: biz || null, address, status, follow_up_date: follow || null, notes: notes || null, lat: geo?.lat ?? null, lng: geo?.lng ?? null, updated_at: new Date().toISOString() };
    const { error } = await supabaseClient.from('leads').insert(payload);
    if (error){
      if (isMissingTableError(error, 'leads')){
        state.missingTables = Array.from(new Set([...(state.missingTables||[]), 'leads']));
        renderDbNotice();
        showAlert('Leads table missing in Supabase. Run supabase-schema.sql then refresh.', 'error');
        return;
      }
      throw error;
    }
    await syncFromSupabase();
    renderLeadsPanel();
    renderMapPanel();
    showAlert('✅ Lead saved', 'success');
  } catch(e){
    console.error(e);
    showAlert(`Lead save failed: ${e?.message || 'error'}`, 'error');
  }
};

window.quickLeadStatus = async function(leadId, status){
  try{
    if (!supabaseClient) throw new Error('Supabase not configured.');
    await supabaseClient.from('leads').update({ status, updated_at: new Date().toISOString() }).eq('id', leadId);
    await syncFromSupabase();
    renderLeadsPanel();
    renderMapPanel();
  } catch(e){
    console.error(e);
    showAlert(`Update failed: ${e?.message || 'error'}`, 'error');
  }
};

window.scheduleLead = async function(leadId){
  const lead = state.leads.find(l => l.id === leadId);
  if (!lead) return;
  const ops = (state.reps||[]).filter(r => r.active !== false);
  const opts = ops.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('');
  document.getElementById('leadsPanel').innerHTML = `
    <div class="card" style="max-width:560px; margin: 0 auto;">
      <div class="card-header"><h2>Schedule lead visit</h2></div>
      <div style="opacity:.85; margin-bottom:10px;"><b>${escapeHtml(lead.biz_name || 'Lead')}</b><div style="font-size:12px; opacity:.75; margin-top:6px;">${escapeHtml(lead.address)}</div></div>
      <div class="form-row">
        <div class="form-group">
          <label>Date</label>
          <input id="leadJobDate" type="date" value="${lead.follow_up_date || new Date().toISOString().split('T')[0]}" />
        </div>
        <div class="form-group">
          <label>Operator</label>
          <select id="leadJobOp" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.22); color:#fff;">
            <option value="">Unassigned</option>
            ${opts}
          </select>
        </div>
      </div>
      <div class="form-row">
        <button class="btn-primary" type="button" onclick="confirmScheduleLead('${leadId}')">Create job</button>
        <button class="btn-secondary" type="button" onclick="renderLeadsPanel()">Cancel</button>
      </div>
    </div>
  `;
  const sel = document.getElementById('leadJobOp');
  if (sel) sel.value = lead.assigned_operator_id || '';
};

window.confirmScheduleLead = async function(leadId){
  try{
    if (!supabaseClient) throw new Error('Supabase not configured.');
    const lead = state.leads.find(l => l.id === leadId);
    if (!lead) throw new Error('Lead not found.');
    const d = String(document.getElementById('leadJobDate')?.value || '');
    const op = String(document.getElementById('leadJobOp')?.value || '');
    if (!d) throw new Error('Pick a date.');

    const { error } = await supabaseClient.from('jobs').insert({
      job_date: d,
      operator_id: op || null,
      lead_id: leadId,
      status: 'scheduled',
      stop_order: 999,
      service_minutes: 10,
      tw_start: null,
      tw_end: null,
      address: lead.address,
      lat: lead.lat ?? null,
      lng: lead.lng ?? null
    });
    if (error) throw error;
    await supabaseClient.from('leads').update({ status: 'presented', updated_at: new Date().toISOString(), assigned_operator_id: op || null, follow_up_date: d || null }).eq('id', leadId);
    await syncFromSupabase();
    switchTab('dispatch');
    showAlert('✅ Lead scheduled', 'success');
  } catch(e){
    console.error(e);
    showAlert(`Schedule failed: ${e?.message || 'error'}`, 'error');
  }
};

// ==============================
// Map
// ==============================
let __leaflet = { map: null, markers: [], lines: [], activeOpId: null, activeJobId: null };

function clearMapLayers(){
  for (const m of (__leaflet.markers||[])){
    try{ m.remove(); } catch(_){}
  }
  for (const l of (__leaflet.lines||[])){
    try{ l.remove(); } catch(_){}
  }
  __leaflet.markers = [];
  __leaflet.lines = [];
}

async function renderMapPanel(){
  const panel = document.getElementById('mapPanel');
  if (!panel) return;

  const todayISO = new Date().toISOString().split('T')[0];
  const date = String(
    document.getElementById('mapDate')?.value ||
    document.getElementById('dispatchDate')?.value ||
    todayISO
  );

  const ops = (state.reps || []).filter(r => r.active !== false);

  // keep selected operator across renders
  const selectedOp = String(window.__mapSelectedOpId || '');
  const focus = window.__mapFocus || null;

  panel.innerHTML = `
    <div class="map-shell">
      <div class="map-topbar">
        <div class="map-title">
          <div class="map-title-main">Map</div>
          <div class="map-title-sub">Pins + routes for ${escapeHtml(date)}</div>
        </div>

        <div class="map-controls">
          <label class="control">
            <span>Date</span>
            <input id="mapDate" type="date" value="${escapeHtml(date)}">
          </label>

          <label class="control">
            <span>Operator</span>
            <select id="mapOperator">
              <option value="">All</option>
              ${ops.map(o => `<option value="${escapeHtml(String(o.id))}" ${selectedOp===String(o.id) ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('')}
            </select>
          </label>

          <div class="control-group">
            <button class="btn-secondary btn-small" type="button" onclick="renderMapPanel()">Refresh</button>
            <button class="btn-secondary btn-small" type="button" onclick="geocodeMissingForDay(15)">Geocode missing</button>
            <button class="btn-secondary btn-small" type="button" onclick="switchTab('dispatch')">Back</button>
          </div>
        </div>
      </div>

      <div id="leafletMap" class="leaflet-wrap"></div>

      <div class="map-legend">
        <span class="legend-dot legend-job"></span> Scheduled job
        <span class="legend-dot legend-lead"></span> Lead
        <span class="legend-dot legend-complete"></span> Completed
      </div>
    </div>
  `;

  // Init map once
  if (!window.L){
    document.getElementById('leafletMap').innerHTML = `<div class="empty-state">Map library failed to load. Check network/CSP and refresh.</div>`;
    return;
  }
  // Ensure Leaflet marker icons load correctly on Vercel (no local image 404)
  try{
    if (window.L && L.Icon && L.Icon.Default){
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
        iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
        shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
      });
    }
  }catch(e){}
  if (!__leaflet.map){
    __leaflet.map = L.map('leafletMap', { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(__leaflet.map);
    __leaflet.map.setView([37.208957, -93.292299], 11); // Springfield default
  } else {
    setTimeout(() => { try{ __leaflet.map.invalidateSize(); } catch(_){} }, 60);
  }

  const palette = ['#7aa2c9','#9aa3aa','#9ee6b8','#c9d0d6','#d1b07a','#b38bdc'];
  const opColor = (opId) => {
    if (!opId) return '#9aa3aa';
    const s = String(opId);
    let h = 0; for (let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  };

  clearMapLayers();

  const opSelect = document.getElementById('mapOperator');
  if (opSelect){
    opSelect.addEventListener('change', () => {
      window.__mapSelectedOpId = String(opSelect.value || '');
      // clearing focus if user manually filters
      window.__mapFocus = null;
      renderMapPanel();
    });
  }

  const filterOpId = String(document.getElementById('mapOperator')?.value || '');
  const jobsAll = (state.jobs||[]).filter(j => String(j.job_date) === date);
  const jobs = filterOpId ? jobsAll.filter(j => String(j.operator_id||'') === filterOpId) : jobsAll;

  const leads = (state.leads||[]).filter(l => Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng)));

  const points = [];

  // Route lines: group by operator and draw ordered polyline
  const byOp = new Map();
  for (const j of jobs){
    const opId = String(j.operator_id || '');
    if (!byOp.has(opId)) byOp.set(opId, []);
    byOp.get(opId).push(j);
  }
  for (const [opId, arr] of byOp){
    arr.sort((a,b) => (Number(a.stop_order||9999) - Number(b.stop_order||9999)) || String(a.id).localeCompare(String(b.id)));
    const coords = [];
    for (const j of arr){
      const t = jobTarget(j);
      const lat = Number(t.lat), lng = Number(t.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      coords.push([lat,lng]);
      points.push([lat,lng]);
    }
    if (coords.length >= 2){
      const line = L.polyline(coords, { weight: 4, opacity: 0.55, dashArray: '8 10', color: opColor(opId) }).addTo(__leaflet.map);
      __leaflet.lines.push(line);
    }
  }

  // Job pins
  for (const j of jobs){
    const t = jobTarget(j);
    const lat = Number(t.lat), lng = Number(t.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const op = repById(j.operator_id);
    const status = String(j.status||'scheduled').toLowerCase();
    const isDone = status === 'completed';

    const popup = `
      <div style="font-size:12px;">
        <div style="font-weight:800;">${escapeHtml(t.label)}</div>
        <div style="opacity:.85;">${escapeHtml(t.address)}</div>
        <div style="opacity:.85; margin-top:6px;">
          ${escapeHtml(String(j.status||'scheduled'))}
          ${op ? ` • ${escapeHtml(op.name)}` : ''}
          ${t.tw_start || t.tw_end ? ` • ${escapeHtml(fmtTime(t.tw_start))}-${escapeHtml(fmtTime(t.tw_end))}` : ''}
        </div>
        <div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;">
          <button class="btn-secondary btn-small" type="button" onclick="switchTab('dispatch'); renderDispatchPanel();">Open in dispatch</button>
        </div>
      </div>
    `;

    const c = opColor(j.operator_id);
    const marker = L.circleMarker([lat,lng], {
      radius: 8,
      weight: 2,
      opacity: 0.95,
      color: c,
      fillColor: c,
      fillOpacity: isDone ? 0.25 : 0.55
    }).addTo(__leaflet.map).bindPopup(popup);

    marker.on('click', () => {
      __leaflet.activeJobId = String(j.id);
      window.__mapFocus = { type:'job', jobId: String(j.id), date };
    });

    __leaflet.markers.push(marker);
  }

  // Leads pins (optional; not filtered by operator)
  for (const l of leads){
    const lat = Number(l.lat), lng = Number(l.lng);
    points.push([lat,lng]);

    const popup = `
      <div style="font-size:12px;">
        <div style="font-weight:800;">${escapeHtml(l.biz_name || 'Lead')}</div>
        <div style="opacity:.85;">${escapeHtml(l.address || '')}</div>
        <div style="opacity:.8; margin-top:6px;">Lead: ${escapeHtml(l.status || 'new')}</div>
      </div>
    `;
    const marker = L.circleMarker([lat,lng], { radius: 6, weight: 2, opacity: 0.9, fillOpacity: 0.15 }).addTo(__leaflet.map).bindPopup(popup);
    __leaflet.markers.push(marker);
  }

  // Fit bounds
  if (points.length){
    try{ __leaflet.map.fitBounds(points, { padding: [30,30] }); } catch(_){}
  }

  // Apply focus (operator/job)
  try{
    if (focus && focus.type === 'operator' && String(focus.opId||'') ){
      const opId = String(focus.opId);
      window.__mapSelectedOpId = opId;
      // Re-render with filter (one-time)
      if (String(document.getElementById('mapOperator')?.value||'') !== opId){
        document.getElementById('mapOperator').value = opId;
      }
    }
  }catch(_){}

  // Job focus: pan and open popup
  if (focus && focus.type === 'job' && focus.jobId){
    const jobId = String(focus.jobId);
    const job = (state.jobs||[]).find(j => String(j.id) === jobId);
    if (job){
      const t = jobTarget(job);
      const lat = Number(t.lat), lng = Number(t.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)){
        try{ __leaflet.map.setView([lat,lng], 14); } catch(_){}
      }
    }
  }

  
  if (!points.length){
    const mapEl = document.getElementById('leafletMap');
    if (mapEl){
      mapEl.insertAdjacentHTML('beforeend', `
        <div class="map-empty-overlay">
          <div class="map-empty-card">
            <div style="font-weight:900; font-size:14px;">No mappable stops yet</div>
            <div style="opacity:.85; font-size:12px; margin-top:6px;">
              Leads and jobs need coordinates (lat/lng) to appear on the map.
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
              <button class="btn-primary btn-small" type="button" onclick="geocodeMissingForDay(15)">Geocode missing</button>
              <button class="btn-secondary btn-small" type="button" onclick="switchTab('leads')">Go to Leads</button>
            </div>
          </div>
        </div>
      `);
    }
  }
// Fit view to points if we have any
  try{
    if (points.length){
      __leaflet.map.fitBounds(points, { padding: [20,20] });
    }
    setTimeout(() => { try{ __leaflet.map.invalidateSize(); } catch(_){} }, 80);
  }catch(e){}
}
window.renderMapPanel = renderMapPanel;

// Dispatch → Map helpers
window.focusOperatorOnMap = function(opId, dateISO){
  window.__mapSelectedOpId = String(opId || '');
  window.__mapFocus = { type: 'operator', opId: String(opId||''), date: String(dateISO||'') };
  switchTab('map');
  renderMapPanel();
};

window.focusJobOnMap = function(jobId, dateISO){
  window.__mapFocus = { type:'job', jobId: String(jobId||''), date: String(dateISO||'') };
  switchTab('map');
  renderMapPanel();
};


window.renderMapPanel = renderMapPanel;

// ==============================
// KPIs (Orders-focused)
// ==============================
function renderOpsKpis(){
  const paidEl = document.getElementById('kpiPaidOrders');
  const unassignedEl = document.getElementById('kpiUnassigned');
  const scheduledEl = document.getElementById('kpiScheduled');
  const opsEl = document.getElementById('kpiOperators');

  if (!paidEl && !unassignedEl && !scheduledEl && !opsEl) return;

  const orders = Array.isArray(state.orders) ? state.orders : [];
  const assignments = Array.isArray(state.assignments) ? state.assignments : [];
  const reps = Array.isArray(state.reps) ? state.reps : [];

  const paidOrders = orders.filter(o => String(o.status || '').toLowerCase() === 'paid').length;

  const assignedOrderIds = new Set(assignments.map(a => a.order_id));
  const unassignedOrders = orders.filter(o => !assignedOrderIds.has(o.id)).length;

  const today = new Date();
  const in7 = new Date(today.getTime() + 7*24*60*60*1000);
  const scheduledNext7 = assignments.filter(a => {
    const d = new Date(String(a.service_date));
    return !isNaN(d) && d >= today && d <= in7;
  }).length;

  const activeOps = reps.filter(r => r.active !== false).length;

  if (paidEl) paidEl.textContent = String(paidOrders);
  if (unassignedEl) unassignedEl.textContent = String(unassignedOrders);
  if (scheduledEl) scheduledEl.textContent = String(scheduledNext7);
  if (opsEl) opsEl.textContent = String(activeOps);
}

// ==============================
// Render: Operators select/list (uses existing DOM ids)
// ==============================
function renderRepSelect() {
  const select = document.getElementById('saleRep');
  if (!select) return;

  select.innerHTML = '<option value="">Select operator...</option>';
  state.reps.filter(r => r.active !== false).forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `${r.name}${r.isManager ? ' (Lead)' : ''}`;
    select.appendChild(opt);
  });
}

function toggleRepForm() {
  const el = document.getElementById('repForm');
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
window.toggleRepForm = toggleRepForm;

async function addRep() {
  const name = String(document.getElementById('repName')?.value || '').trim();
  const payoutRate = Number(document.getElementById('repChurn')?.value || DEFAULT_CONFIG.defaultPayoutRate);
  const isManager = !!document.getElementById('repIsManager')?.checked;

  if (!name) {
    showAlert('Enter operator name', 'error');
    return;
  }

  const rep = {
    id: null, // let Supabase generate uuid
    name,
    payoutRate,
    isManager,
    active: true
  };

  try {
    if (supabaseClient) {
      const saved = await upsertOperator(rep);
      rep.id = saved.id;
    }
    state.reps.push(rep);

    renderRepSelect();
    renderRepsList();
    saveStateLocal();
    showAlert('✅ Operator saved', 'success');
  } catch (e) {
    console.error(e);
    showAlert(`Operator save failed: ${e?.message || 'error'}`, 'error');
  }
}
window.addRep = addRep;

function renderRepsList() {
  const wrap = document.getElementById('repsList');
  if (!wrap) return;

  if (!state.reps.length) {
    wrap.innerHTML = '<div style="opacity:.75; padding:10px 0;">No operators yet.</div>';
    return;
  }

  wrap.innerHTML = state.reps.map(r => `
    <div style="display:flex; justify-content:space-between; gap:10px; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
      <div>
        <div style="font-weight:700;">${escapeHtml(r.name)}</div>
        <div style="opacity:.75; font-size:12px;">Payout: ${Number(r.payoutRate||30).toFixed(1)}% ${r.isManager ? '• Lead' : ''}</div>
      </div>
      <div style="opacity:.7; font-size:12px; align-self:center;">${r.active === false ? 'Inactive' : 'Active'}</div>
    </div>
  `).join('');
}

// ==============================
// Minimal: Orders + Assignments + Routes panels
// ==============================
function formatOrderLine(o) {
  const biz = o.biz_name || o.bizName || '—';
  const addr = o.address || '—';
  const cans = o.cans || '—';
  const cadence = o.cadence || '—';
  const billing = o.billing || '—';
  const status = o.status || 'new';
  return { biz, addr, cans, cadence, billing, status };
}

function renderOrdersPanel() {
  const panel = document.getElementById('ordersPanel');
  if (!panel) return;

  const repsOpts = state.reps
    .filter(r => r.active !== false)
    .map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`)
    .join('');

  if (!state.orders.length) {
    panel.innerHTML = `<div style="opacity:.75;">No intake orders found yet.</div>`;
    return;
  }

  // Map assignments by order_id for quick display
  const asgByOrder = new Map(state.assignments.map(a => [a.order_id, a]));

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px;">
      <div style="font-weight:700;">Intake Orders</div>
      <button class="btn-secondary btn-small" type="button" onclick="refreshSupabase()">Refresh</button>
    </div>

    <div style="display:grid; gap:10px;">
      ${state.orders.map(o => {
        const f = formatOrderLine(o);
        const a = asgByOrder.get(o.id);
        const assignedOperator = a?.operator_id || '';
        const assignedDate = a?.service_date || '';

        return `
          <div style="border:1px solid rgba(255,255,255,0.10); border-radius:14px; padding:12px; background: rgba(0,0,0,0.18);">
            <div style="display:flex; justify-content:space-between; gap:10px;">
              <div>
                <div style="font-weight:800;">${escapeHtml(f.biz)}</div>
                <div style="opacity:.8; font-size:12px; margin-top:4px;">${escapeHtml(f.addr)}</div>
                <div style="opacity:.75; font-size:12px; margin-top:6px;">
                  Cans: ${escapeHtml(f.cans)} • Cadence: ${escapeHtml(f.cadence)} • Billing: ${escapeHtml(f.billing)} • Status: <strong>${escapeHtml(f.status)}</strong>
                </div>
              </div>
              <div style="text-align:right; opacity:.8; font-size:12px;">
                <div>${o.customer_email ? escapeHtml(o.customer_email) : ''}</div>
                <div>${o.phone ? escapeHtml(o.phone) : ''}</div>
              </div>
            </div>

            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:10px; align-items:end;">
              <div style="min-width:220px; flex:1;">
                <label style="display:block; font-size:12px; opacity:.75; margin-bottom:6px;">Assign operator</label>
                <select id="asg_op_${o.id}" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.22); color:#fff;">
                  <option value="">Select...</option>
                  ${repsOpts}
                </select>
              </div>

              <div style="min-width:180px;">
                <label style="display:block; font-size:12px; opacity:.75; margin-bottom:6px;">Service date</label>
                <input id="asg_dt_${o.id}" type="date" value="${assignedDate || ''}" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.22); color:#fff;" />
              </div>

              <button class="btn-primary" type="button" onclick="assignOrderFromUI('${o.id}')">Assign</button>

              ${o.terms_url ? `<a class="btn-secondary btn-small" href="${o.terms_url}" target="_blank" rel="noopener">Terms</a>` : ''}
            </div>

            <script>
              (function(){
                const op = document.getElementById('asg_op_${o.id}');
                if (op) op.value = '${assignedOperator || ''}';
              })();
            </script>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

window.assignOrderFromUI = async function(orderUuid) {
  try {
    if (!supabaseClient) throw new Error('Supabase not configured.');

    const op = String(document.getElementById(`asg_op_${orderUuid}`)?.value || '');
    const dt = String(document.getElementById(`asg_dt_${orderUuid}`)?.value || '');

    if (!op) throw new Error('Select an operator.');
    if (!dt) throw new Error('Select a service date.');

    await assignOrder({ orderId: orderUuid, operatorId: op, serviceDate: dt, sequence: 1 });
    showAlert('✅ Assigned', 'success');
    await syncFromSupabase();
    renderOrdersPanel();
    renderRoutesPanel();
  } catch (e) {
    console.error(e);
    showAlert(`Assign failed: ${e?.message || 'error'}`, 'error');
  }
};

function renderRoutesPanel() {
  const panel = document.getElementById('routesPanel');
  if (!panel) return;

  const todayISO = new Date().toISOString().split('T')[0];

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px;">
      <div style="font-weight:700;">Routes</div>
      <div style="display:flex; gap:8px; align-items:center;">
        <input id="routeDate" type="date" value="${todayISO}" style="padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.22); color:#fff;">
        <button class="btn-secondary btn-small" type="button" onclick="renderRoutesPanel()">View</button>
      </div>
    </div>
    <div id="routesList"></div>
  `;

  const date = String(document.getElementById('routeDate')?.value || todayISO);
  const list = document.getElementById('routesList');
  if (!list) return;

  const ordersById = new Map(state.orders.map(o => [o.id, o]));
  const dayAssignments = state.assignments.filter(a => String(a.service_date) === date);

  if (!dayAssignments.length) {
    list.innerHTML = `<div style="opacity:.75;">No assignments for ${escapeHtml(date)}.</div>`;
    return;
  }

  // Group by operator
  const byOp = new Map();
  for (const a of dayAssignments) {
    const arr = byOp.get(a.operator_id) || [];
    arr.push(a);
    byOp.set(a.operator_id, arr);
  }

  // Render each operator route
  list.innerHTML = Array.from(byOp.entries()).map(([opId, items]) => {
    const op = repById(opId);
    const name = op ? op.name : 'Unknown operator';

    items.sort((x,y) => (x.sequence||1) - (y.sequence||1));

    return `
      <div style="border:1px solid rgba(255,255,255,0.10); border-radius:14px; padding:12px; background: rgba(0,0,0,0.18); margin-bottom:10px;">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
          <div style="font-weight:800;">${escapeHtml(name)}</div>
          <div style="opacity:.75; font-size:12px;">Stops: ${items.length}</div>
        </div>
        <div style="margin-top:10px; display:grid; gap:8px;">
          ${items.map(a => {
            const o = ordersById.get(a.order_id);
            const f = o ? formatOrderLine(o) : { biz:'—', addr:'—', cans:'—', cadence:'—', billing:'—', status:'—' };
            return `
              <div style="display:flex; justify-content:space-between; gap:10px; padding:10px; border-radius:12px; border:1px solid rgba(255,255,255,0.08);">
                <div>
                  <div style="font-weight:700;">#${a.sequence || 1} — ${escapeHtml(f.biz)}</div>
                  <div style="opacity:.8; font-size:12px; margin-top:4px;">${escapeHtml(f.addr)}</div>
                  <div style="opacity:.75; font-size:12px; margin-top:4px;">Cans: ${escapeHtml(f.cans)} • ${escapeHtml(f.cadence)}</div>
                </div>
                <div style="text-align:right; opacity:.75; font-size:12px;">
                  ${o?.customer_email ? escapeHtml(o.customer_email) : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }).join('');
}

window.renderRoutesPanel = renderRoutesPanel;

// ==============================
// Onboarding + Auto-routing + Availability
// ==============================

function iso(d){ return new Date(d).toISOString().split('T')[0]; }
const DOW_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function addDaysISO(dateISO, days){
  const d = new Date(dateISO + 'T00:00:00');
  d.setDate(d.getDate() + Number(days||0));
  return iso(d);
}

function windowRangeForRoute(route, weekStartISO){
  const s = Number(route.window_start_dow ?? 1);
  const e = Number(route.window_end_dow ?? 4);
  const start = addDaysISO(weekStartISO, Math.max(0, Math.min(6, s)));
  const end = addDaysISO(weekStartISO, Math.max(0, Math.min(6, e)));
  return { start, end };
}

function daysBetween(aISO, bISO){
  const a = new Date(aISO + 'T00:00:00');
  const b = new Date(bISO + 'T00:00:00');
  return Math.floor((b - a) / (1000*60*60*24));
}
function cycleWeekForDate(anchorISO, dateISO){
  const diff = daysBetween(anchorISO, dateISO);
  if (!Number.isFinite(diff)) return 1;
  const w = Math.floor(diff / 7);
  const mod = ((w % 4) + 4) % 4;
  return mod + 1; // 1..4
}
function nextWeekStartISO(anchorISO, fromISO, targetWeek){
  // Find the next week-start (anchor + n*7) that is in the targetWeek (1..4) and >= fromISO
  const fromDiff = Math.max(0, daysBetween(anchorISO, fromISO));
  let n = Math.floor(fromDiff / 7);
  for (let i=0; i<40; i++){
    const candidate = addDaysISO(anchorISO, (n+i)*7);
    const wk = cycleWeekForDate(anchorISO, candidate);
    if (wk === targetWeek && candidate >= fromISO) return candidate;
  }
  return addDaysISO(fromISO, 7);
}
function normalizeFrequency(freq){
  const f = String(freq||'').toLowerCase();
  if (f.includes('bi')) return 'biweekly';
  return 'monthly';
}
function getZipFromAddress(address){
  const s = String(address||'');
  const m = s.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : '';
}
function inferZone(address){
  // MVP: zone = ZIP if present; else first 10 chars of address; else 'default'
  const zip = getZipFromAddress(address);
  if (zip) return zip;
  const a = String(address||'').trim();
  if (a) return a.slice(0, 10).toUpperCase();
  return 'default';
}

function routeServiceWeeks(route){
  // routes.frequency_type: monthly|biweekly_a|biweekly_b
  const t = String(route.frequency_type || route.frequency || '').toLowerCase();
  if (t === 'monthly') return [Number(route.monthly_week || 1)];
  if (t === 'biweekly_a') return [1,3];
  if (t === 'biweekly_b') return [2,4];
  // fallback based on route.service_weeks array
  if (Array.isArray(route.service_weeks) && route.service_weeks.length) return route.service_weeks.map(Number);
  return [1,3];
}

function routeLoad(routeId){
  const stops = state.routeStops.filter(s => s.route_id === routeId && (s.active !== false));
  let cans = 0;
  const custById = new Map(state.customers.map(c => [c.id, c]));
  for (const s of stops){
    const c = custById.get(s.customer_id);
    if (c) cans += Number(c.cans || 0);
  }
  return { stops: stops.length, cans };
}

function hasCapacity(route, neededCans=0){
  const capStops = Number(route.capacity_stops || 0);
  const capCans  = Number(route.capacity_cans  || 0);
  const load = routeLoad(route.id);
  const stopsOk = capStops ? (load.stops + 1 <= capStops) : true;
  const cansOk  = capCans  ? (load.cans + Number(neededCans||0) <= capCans) : true;
  return { ok: stopsOk && cansOk, load };
}

function nextServiceForRoute(route, fromISO){
  const anchor = String(state.settings.cycle_anchor || '2026-04-01');
  const weeks = routeServiceWeeks(route);
  // find soonest among weeks
  let best = null;
  for (const w of weeks){
    const dt = nextWeekStartISO(anchor, fromISO, Number(w));
    if (!best || dt < best) best = dt;
  }
  return best || fromISO;
}

function formatAvailabilityRow(r){
  const op = repById(r.operator_id);
  const opName = op ? op.name : (r.operator_id ? 'Operator' : 'Unassigned');
  const load = routeLoad(r.id);
  const capStops = Number(r.capacity_stops || 0);
  const capCans = Number(r.capacity_cans || 0);
  const loadText = `${load.stops}${capStops ? ' / ' + capStops : ''} stops • ${load.cans}${capCans ? ' / ' + capCans : ''} cans`;
  return { opName, loadText };
}

function computeAvailability({ address, frequency, cans, fromISO }){
  const zone = inferZone(address);
  const f = normalizeFrequency(frequency);
  const from = String(fromISO || iso(new Date()));
  const routes = state.routes.filter(rt => (rt.active !== false) && String(rt.zone||'') === String(zone));
  const candidates = routes.filter(rt => {
    const t = String(rt.frequency_type || rt.frequency || '').toLowerCase();
    if (f === 'monthly') return t === 'monthly';
    return (t === 'biweekly_a' || t === 'biweekly_b' || t === 'biweekly');
  });

  const options = [];
  for (const r of candidates){
    const cap = hasCapacity(r, cans);
    if (!cap.ok) continue;
    const next = nextServiceForRoute(r, from);
    const extra = formatAvailabilityRow(r);
    options.push({
      route: r,
      nextServiceWeekStart: next,
      operatorName: extra.opName,
      loadText: extra.loadText
    });
  }

  options.sort((a,b)=> a.nextServiceWeekStart.localeCompare(b.nextServiceWeekStart));
  return { zone, options };
}

async function insertCustomer(customer){
  if (!supabaseClient) throw new Error('Supabase not configured.');
  const payload = {
    biz_name: customer.biz_name || null,
    contact_name: customer.contact_name || null,
    customer_email: customer.customer_email || null,
    phone: customer.phone || null,
    address: customer.address || null,
    zone: customer.zone || inferZone(customer.address),
    frequency: normalizeFrequency(customer.frequency || 'monthly'),
    cans: Number(customer.cans || 0),
    status: customer.status || 'deposited',
    deposit_amount: Number(customer.deposit_amount || 25),
    deposit_paid_at: customer.deposit_paid_at || new Date().toISOString(),
  };
  const { data, error } = await supabaseClient.from('customers').insert(payload).select('*').single();
  if (error) throw error;
  return data;
}

async function assignCustomerToRoute(customerId, routeId){
  if (!supabaseClient) throw new Error('Supabase not configured.');
  const customer = state.customers.find(c => c.id === customerId);
  const route = state.routes.find(r => r.id === routeId);
  if (!customer) throw new Error('Customer not found in state.');
  if (!route) throw new Error('Route not found.');

  const start = nextServiceForRoute(route, iso(new Date()));

  // create stop
  const { data: stop, error: sErr } = await supabaseClient
    .from('route_stops')
    .insert({ route_id: routeId, customer_id: customerId, sequence: 999, active: true })
    .select('*')
    .single();
  if (sErr) throw sErr;

  // update customer
  const { error: cErr } = await supabaseClient
    .from('customers')
    .update({ route_id: routeId, start_week_start: start, status: 'scheduled' })
    .eq('id', customerId);
  if (cErr) throw cErr;

  return stop;
}

async function createRoute(route){
  if (!supabaseClient) throw new Error('Supabase not configured.');
  const payload = {
    name: route.name,
    zone: route.zone,
    frequency_type: route.frequency_type,
    monthly_week: route.frequency_type === 'monthly' ? Number(route.monthly_week || 1) : null,
    capacity_stops: route.capacity_stops ? Number(route.capacity_stops) : null,
    capacity_cans: route.capacity_cans ? Number(route.capacity_cans) : null,
    operator_id: route.operator_id || null,
    window_start_dow: Number(route.window_start_dow ?? 1),
    window_end_dow: Number(route.window_end_dow ?? 4),
    active: true
  };
  const { data, error } = await supabaseClient.from('routes').insert(payload).select('*').single();
  if (error) throw error;
  return data;
}

function renderOnboardingPanel(){
  const panel = document.getElementById('onboardingPanel');
  if (!panel) return;

  const today = iso(new Date());

  const operatorOptions = state.reps
    .filter(r=>r.active !== false)
    .map(r=>`<option value="${r.id}">${escapeHtml(r.name)}</option>`)
    .join('');

  panel.innerHTML = `
    <div style="display:grid; gap:12px;">
      <div class="card">
        <div class="card-header">
          <h2>Instant Availability (Prospecting Mode)</h2>
          <span class="tier-badge tier-2">Shows soonest route slot</span>
        </div>

        <div class="form-row">
          <div class="form-group" style="flex:2;">
            <label for="availAddress">Customer Address</label>
            <input id="availAddress" type="text" placeholder="123 Main St, Kansas City, MO 64108" />
            <div style="margin-top:6px; font-size:12px; opacity:.75;">
              Tip: include ZIP for best automation. Zone is inferred from ZIP.
            </div>
          </div>
          <div class="form-group" style="flex:1;">
            <label for="availFreq">Frequency</label>
            <select id="availFreq">
              <option value="biweekly">Bi-weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div class="form-group" style="flex:1;">
            <label for="availCans"># Cans</label>
            <input id="availCans" type="number" min="1" step="1" value="8" />
          </div>
        </div>

        <div class="form-row" style="align-items:end;">
          <button class="btn-primary" type="button" id="btnCheckAvail">Check availability</button>
          <button class="btn-secondary" type="button" id="btnQuickDeposit">Add as $25 deposit</button>
          <div style="flex:1;"></div>
        </div>

        <div id="availResults" style="margin-top:12px;"></div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>Deposits Queue</h2>
          <span class="tier-badge tier-1">Auto-suggests routes</span>
        </div>
        <div id="depositQueue"></div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>Routes Manager</h2>
          <span class="tier-badge tier-3">Capacity + operator</span>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="newRouteName">Route Name</label>
            <input id="newRouteName" type="text" placeholder="KC-64108-BW-A" />
          </div>
          <div class="form-group">
            <label for="newRouteZone">Zone (ZIP)</label>
            <input id="newRouteZone" type="text" placeholder="64108" />
          </div>
          <div class="form-group">
            <label for="newRouteFreqType">Route Type</label>
            <select id="newRouteFreqType">
              <option value="biweekly_a">Bi-weekly A (Weeks 1 & 3)</option>
              <option value="biweekly_b">Bi-weekly B (Weeks 2 & 4)</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          
          <div class="form-group">
            <label for="newRouteWinStart">Service Window Start</label>
            <select id="newRouteWinStart">
              ${DOW_LABELS.map((d,i)=>`<option value="${i}" ${i===1?'selected':''}>${d}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label for="newRouteWinEnd">Service Window End</label>
            <select id="newRouteWinEnd">
              ${DOW_LABELS.map((d,i)=>`<option value="${i}" ${i===4?'selected':''}>${d}</option>`).join('')}
            </select>
          </div>

<div class="form-group" id="monthlyWeekWrap" style="display:none;">
            <label for="newRouteMonthlyWeek">Monthly Week</label>
            <select id="newRouteMonthlyWeek">
              <option value="1">Week 1</option>
              <option value="2">Week 2</option>
              <option value="3">Week 3</option>
              <option value="4">Week 4</option>
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="newRouteCapStops">Capacity (stops)</label>
            <input id="newRouteCapStops" type="number" min="1" step="1" placeholder="25" />
          </div>
          <div class="form-group">
            <label for="newRouteCapCans">Capacity (cans)</label>
            <input id="newRouteCapCans" type="number" min="1" step="1" placeholder="200" />
          </div>
          <div class="form-group">
            <label for="newRouteOperator">Operator</label>
            <select id="newRouteOperator">
              <option value="">Unassigned</option>
              ${operatorOptions}
            </select>
          </div>
          <button class="btn-secondary" type="button" id="btnCreateRoute" style="align-self:end;">Create Route</button>
        </div>

        <div style="margin-top:10px; opacity:.75; font-size:12px;">
          Cycle anchor: <strong>${escapeHtml(state.settings.cycle_anchor || '2026-04-01')}</strong> • Lock window: <strong>${Number(state.settings.lock_window_days||7)} days</strong>
        </div>

        <div id="routesTable" style="margin-top:12px;"></div>
      </div>
    </div>
  `;

  // Handlers
  const freqTypeEl = document.getElementById('newRouteFreqType');
  const monthlyWrap = document.getElementById('monthlyWeekWrap');
  if (freqTypeEl && monthlyWrap){
    const sync = () => { monthlyWrap.style.display = (freqTypeEl.value === 'monthly') ? 'block' : 'none'; };
    freqTypeEl.addEventListener('change', sync);
    sync();
  }

  const resEl = document.getElementById('availResults');
  document.getElementById('btnCheckAvail')?.addEventListener('click', ()=>{
    const address = String(document.getElementById('availAddress')?.value || '').trim();
    const frequency = String(document.getElementById('availFreq')?.value || 'biweekly');
    const cans = Number(document.getElementById('availCans')?.value || 0);
    if (!address){
      if (resEl) resEl.innerHTML = `<div class="empty-state">Enter an address (include ZIP if possible).</div>`;
      return;
    }
    const out = computeAvailability({ address, frequency, cans, fromISO: today });
    if (!out.options.length){
      if (resEl) resEl.innerHTML = `
        <div class="empty-state">No available routes found for zone <strong>${escapeHtml(out.zone)}</strong>. Create a route below, or change zone/address.</div>
      `;
      return;
    }
    if (resEl) resEl.innerHTML = `
      <div style="opacity:.8; font-size:12px; margin-bottom:10px;">Zone inferred: <strong>${escapeHtml(out.zone)}</strong></div>
      <div style="display:grid; gap:10px;">
        ${out.options.slice(0,5).map(o=>{
          const rt = o.route;
          const type = String(rt.frequency_type || rt.frequency || '');
          const cap = hasCapacity(rt, cans);
          const badge = type === 'monthly' ? 'Monthly' : (type === 'biweekly_a' ? 'Bi-weekly A' : 'Bi-weekly B');
          return `
            <div style="border:1px solid rgba(255,255,255,0.10); border-radius:14px; padding:12px; background: rgba(0,0,0,0.18);">
              <div style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
                <div style="font-weight:800;">${escapeHtml(rt.name || 'Route')}</div>
                <span class="tier-badge tier-2">${badge}</span>
              </div>
              <div style="opacity:.8; font-size:12px; margin-top:6px;">Next service window: <strong>${escapeHtml(windowRangeForRoute(rt, o.nextServiceWeekStart).start)}</strong> → <strong>${escapeHtml(windowRangeForRoute(rt, o.nextServiceWeekStart).end)}</strong></div>
              <div style="opacity:.75; font-size:12px; margin-top:6px;">Operator: ${escapeHtml(o.operatorName)} • Load: ${escapeHtml(o.loadText)}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  });

  document.getElementById('btnQuickDeposit')?.addEventListener('click', async ()=>{
    try{
      const address = String(document.getElementById('availAddress')?.value || '').trim();
      const frequency = String(document.getElementById('availFreq')?.value || 'biweekly');
      const cans = Number(document.getElementById('availCans')?.value || 0);
      if (!address) throw new Error('Enter an address first.');
      const zone = inferZone(address);

      const saved = await insertCustomer({
        address,
        zone,
        frequency,
        cans,
        deposit_amount: 25,
        status: 'deposited'
      });

      showAlert('✅ Deposit customer added', 'success');
      await syncFromSupabase();
      renderOnboardingPanel();
    }catch(e){
      console.error(e);
      showAlert(`Add deposit failed: ${e?.message || 'error'}`, 'error');
    }
  });

  document.getElementById('btnCreateRoute')?.addEventListener('click', async ()=>{
    try{
      const name = String(document.getElementById('newRouteName')?.value || '').trim();
      const zone = String(document.getElementById('newRouteZone')?.value || '').trim();
      const frequency_type = String(document.getElementById('newRouteFreqType')?.value || 'biweekly_a');
      const monthly_week = Number(document.getElementById('newRouteMonthlyWeek')?.value || 1);
      const capacity_stops = Number(document.getElementById('newRouteCapStops')?.value || 0) || null;
      const capacity_cans = Number(document.getElementById('newRouteCapCans')?.value || 0) || null;
      const operator_id = String(document.getElementById('newRouteOperator')?.value || '');
      const window_start_dow = Number(document.getElementById('newRouteWinStart')?.value ?? 1);
      const window_end_dow = Number(document.getElementById('newRouteWinEnd')?.value ?? 4);

      if (!name) throw new Error('Route name required.');
      if (!zone) throw new Error('Zone (ZIP) required.');

      await createRoute({ name, zone, frequency_type, monthly_week, capacity_stops, capacity_cans, operator_id: operator_id || null, window_start_dow, window_end_dow });
      showAlert('✅ Route created', 'success');
      await syncFromSupabase();
      renderOnboardingPanel();
    }catch(e){
      console.error(e);
      showAlert(`Create route failed: ${e?.message || 'error'}`, 'error');
    }
  });

  // Deposit queue render
  renderDepositQueue();
  renderRoutesTable();
}

function renderDepositQueue(){
  const wrap = document.getElementById('depositQueue');
  if (!wrap) return;

  const deposited = state.customers.filter(c => String(c.status||'').toLowerCase() === 'deposited' || (String(c.status||'').toLowerCase()==='scheduled' && !c.route_id));
  if (!deposited.length){
    wrap.innerHTML = `<div class="empty-state">No deposited customers waiting for routing.</div>`;
    return;
  }

  wrap.innerHTML = `<div style="display:grid; gap:10px;">
    ${deposited.map(c=>{
      const address = c.address || '';
      const freq = normalizeFrequency(c.frequency || 'monthly');
      const cans = Number(c.cans || 0);
      const out = computeAvailability({ address, frequency: freq, cans, fromISO: iso(new Date()) });
      const top = out.options[0];
      const suggestion = top ? `${top.route.name} • ${top.nextServiceWeekStart}` : `No route available in zone ${out.zone}`;
      const btn = top ? `<button class="btn-primary btn-small" type="button" onclick="assignSuggested('${c.id}','${top.route.id}')">Assign</button>` : '';
      return `
        <div style="border:1px solid rgba(255,255,255,0.10); border-radius:14px; padding:12px; background: rgba(0,0,0,0.18);">
          <div style="display:flex; justify-content:space-between; gap:10px;">
            <div>
              <div style="font-weight:800;">${escapeHtml(c.biz_name || 'Deposited Customer')}</div>
              <div style="opacity:.8; font-size:12px; margin-top:4px;">${escapeHtml(address)}</div>
              <div style="opacity:.75; font-size:12px; margin-top:6px;">${escapeHtml(freq)} • Cans: ${escapeHtml(cans)} • Deposit: ${money(c.deposit_amount || 25)}</div>
              <div style="opacity:.85; font-size:12px; margin-top:8px;">Suggested: <strong>${escapeHtml(suggestion)}</strong></div>
            </div>
            <div style="text-align:right; display:flex; flex-direction:column; gap:8px; align-items:flex-end;">
              ${btn}
            </div>
          </div>
        </div>
      `;
    }).join('')}
  </div>`;
}

window.assignSuggested = async function(customerId, routeId){
  try{
    await assignCustomerToRoute(customerId, routeId);
    showAlert('✅ Customer scheduled', 'success');
    await syncFromSupabase();
    renderOnboardingPanel();
  }catch(e){
    console.error(e);
    showAlert(`Assign failed: ${e?.message || 'error'}`, 'error');
  }
};

function renderRoutesTable(){
  const wrap = document.getElementById('routesTable');
  if (!wrap) return;
  if (!state.routes.length){
    wrap.innerHTML = `<div class="empty-state">No routes yet. Create one above.</div>`;
    return;
  }

  wrap.innerHTML = `
    <div style="display:grid; gap:10px;">
      ${state.routes.map(r=>{
        const load = routeLoad(r.id);
        const type = String(r.frequency_type || r.frequency || '');
        const badge = type === 'monthly' ? 'Monthly' : (type === 'biweekly_a' ? 'Bi-weekly A' : 'Bi-weekly B');
        const capStops = Number(r.capacity_stops || 0);
        const capCans = Number(r.capacity_cans || 0);
        const op = repById(r.operator_id);
        const opName = op ? op.name : 'Unassigned';
        return `
          <div style="border:1px solid rgba(255,255,255,0.10); border-radius:14px; padding:12px; background: rgba(0,0,0,0.18);">
            <div style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
              <div>
                <div style="font-weight:800;">${escapeHtml(r.name || 'Route')}</div>
                <div style="opacity:.8; font-size:12px; margin-top:4px;">Zone: <strong>${escapeHtml(r.zone || 'default')}</strong> • Operator: ${escapeHtml(opName)}</div>
              </div>
              <span class="tier-badge tier-2">${badge}</span>
            </div>
            <div style="opacity:.75; font-size:12px; margin-top:8px;">
              Load: ${load.stops}${capStops ? ' / ' + capStops : ''} stops • ${load.cans}${capCans ? ' / ' + capCans : ''} cans
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}



window.refreshSupabase = async function() {
  try {
    if (!supabaseClient) {
      showAlert('Supabase not configured (local mode).', 'error');
      return;
    }
    await syncFromSupabase();
    showAlert('✅ Refreshed', 'success');
    renderEverything();
  } catch (e) {
    console.error(e);
    showAlert(`Refresh failed: ${e?.message || 'error'}`, 'error');
  }
};

// ==============================
// EXISTING: Keep your “Log Completed Job” flow,
// but persist to Supabase visits table if configured.
// ==============================
function setupStatusToggle() {
  const group = document.querySelector('#saleForm .toggle-group');
  const hidden = document.getElementById('activationStatus');
  if (!group || !hidden) return;

  group.addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    group.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    hidden.value = btn.getAttribute('data-value') || 'due';
  });
}

// ---- your existing pricing functions (unchanged essentials) ----
function tierPrice(tiers, qty) {
  const q = Number(qty || 0);
  for (const t of tiers) {
    if (q >= t.min && q <= t.max) return Number(t.pricePerCanMonth);
  }
  return Number(tiers[tiers.length - 1]?.pricePerCanMonth || 0);
}

function parseService(serviceType) {
  const s = String(serviceType || '').toLowerCase();
  if (s.includes('trash') || s.includes('can') || s.includes('bin')) {
    const cadence = s.includes('bi') ? 'biweekly' : (s.includes('month') ? 'monthly' : 'biweekly');
    return { kind: 'trashCan', cadence };
  }
  if (s.includes('pad')) {
    const cadence = s.includes('week') && !s.includes('bi') ? 'weekly'
                 : (s.includes('bi') ? 'biweekly' : 'monthly');
    return { kind: 'dumpsterPad', cadence };
  }
  return { kind: 'unknown' };
}

function computeServicePricing({ serviceType, qty, billingFrequency, locationsCount, padSize }) {
  const parsed = parseService(serviceType);
  const q = Number(qty || 0);
  if (!Number.isFinite(q) || q < 1) return { ok: false, error: 'Quantity must be at least 1.' };

  const bill = String(billingFrequency || 'monthly').toLowerCase();
  const billDisc = Number(PRICING.billingDiscounts[bill] ?? 0);
  const locDisc = Number(PRICING.multiLocationDiscount(locationsCount) ?? 0);

  let baseMonthly = 0;
  let visitsPerMonth = 1;

  if (parsed.kind === 'trashCan') {
    const perCan = tierPrice(PRICING.trashCan[parsed.cadence], q);
    baseMonthly = perCan * q;
    visitsPerMonth = Number(PRICING.trashCan.visitsPerMonth[parsed.cadence] || 1);
  } else if (parsed.kind === 'dumpsterPad') {
    const sizeKey = (padSize || 'small');
    const size = PRICING.dumpsterPad[sizeKey];
    if (!size) return { ok: false, error: 'Select a pad size (Small/Medium/Large).' };
    baseMonthly = Number(size[parsed.cadence] || 0);
    visitsPerMonth = Number(PRICING.dumpsterPad.visitsPerMonth[parsed.cadence] || 1);
  } else {
    return { ok: false, error: 'Unknown service type.' };
  }

  const afterLocation = baseMonthly * (1 - locDisc);
  const monthlyValue = afterLocation * (1 - billDisc);
  const monthsInTerm = bill === 'quarterly' ? 3 : (bill === 'annual' ? 12 : 1);

  if (bill === 'annual' && monthlyValue < 1000) {
    return { ok: false, error: 'Annual prepay requires $1,000+/mo contract value.' };
  }

  const invoiceTotal = monthlyValue * monthsInTerm;
  const visitRevenue = monthlyValue / Math.max(1, visitsPerMonth);

  return { ok: true, kind: parsed.kind, cadence: parsed.cadence, baseMonthly, monthlyValue, invoiceTotal, visitsPerMonth, visitRevenue, locDisc, billDisc, monthsInTerm };
}

// Deep clean selection (kept)
function getDeepCleanSelection() {
  const enabled = !!document.getElementById('deepClean')?.checked;
  if (!enabled) return { enabled: false, condition: null, perCan: 0, total: 0 };

  const condition = String(document.getElementById('deepCleanCondition')?.value || 'standard').toLowerCase();
  const perCan = Number(PRICING.deepCleanOneTime[condition] ?? PRICING.deepCleanOneTime.standard);
  const qty = Number(document.getElementById('units')?.value || 0);
  const total = Math.max(0, qty) * perCan;

  return { enabled: true, condition, perCan, total };
}

function setupAutoPricing() {
  const form = document.getElementById('saleForm');
  if (!form) return;

  const ids = ['productLine','units','billingFrequency','locationsCount','padSize','jobType','fees','saleRep','deepClean','deepCleanCondition','addPadAddon','addonPadCadence','addonPadSize'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    el?.addEventListener('input', updatePricingPreview);
    el?.addEventListener('change', updatePricingPreview);
  });

  const padChk = document.getElementById('addPadAddon');
  if (padChk) {
    padChk.addEventListener('change', () => {
      const sec = document.getElementById('padAddonSection');
      if (sec) sec.style.display = padChk.checked ? 'block' : 'none';
      updatePricingPreview();
    });
    const sec = document.getElementById('padAddonSection');
    if (sec) sec.style.display = padChk.checked ? 'block' : 'none';
  }

  updatePricingPreview();
}

function updatePricingPreview() {
  const product = document.getElementById('productLine')?.value;
  const units = Number(document.getElementById('units')?.value || 0);
  const billingFrequency = String(document.getElementById('billingFrequency')?.value || 'monthly').toLowerCase();
  const locationsCount = Number(document.getElementById('locationsCount')?.value || 1);
  const padSize = String(document.getElementById('padSize')?.value || '').toLowerCase();
  const jobType = String(document.getElementById('jobType')?.value || 'recurring');

  const addPad = !!document.getElementById('addPadAddon')?.checked;
  const addonCadence = String(document.getElementById('addonPadCadence')?.value || 'oneTime');
  const addonSize = String(document.getElementById('addonPadSize')?.value || 'small');

  const preview = document.getElementById('pricingPreview');
  const revenueInput = document.getElementById('revenue');

  const deep = getDeepCleanSelection();

  if (!product || !Number.isFinite(units) || units < 1) {
    if (preview) preview.innerHTML = '<span style="opacity:.7">Select a service + quantity to auto-calculate revenue.</span>';
    if (revenueInput) revenueInput.value = '';
    return;
  }

  const pricing = computeServicePricing({ serviceType: product, qty: units, billingFrequency, locationsCount, padSize });
  if (!pricing.ok) {
    if (preview) preview.innerHTML = `<span style="color:var(--error);">${escapeHtml(pricing.error)}</span>`;
    if (revenueInput) revenueInput.value = '';
    return;
  }

  // Optional stacked pad add-on (kept from your logic)
  let addon = null;
  if (addPad) {
    if (addonCadence === 'oneTime') {
      const p = PRICING.dumpsterPad[addonSize];
      const oneTime = Number(p?.monthly || 0);
      addon = { visitRevenue: oneTime, invoiceTotal: oneTime, monthlyValue: 0, padSize: addonSize, cadence: 'oneTime' };
    } else {
      const label = addonCadence === 'weekly' ? 'Weekly' : (addonCadence === 'biweekly' ? 'Biweekly' : 'Monthly');
      const padPricing = computeServicePricing({
        serviceType: `Dumpster Pad Cleaning - ${label}`,
        qty: 1,
        billingFrequency,
        locationsCount,
        padSize: addonSize
      });
      if (padPricing.ok) addon = { visitRevenue: padPricing.visitRevenue, invoiceTotal: padPricing.invoiceTotal, monthlyValue: padPricing.monthlyValue, padSize: addonSize, cadence: addonCadence };
    }
  }

  const addonVisit = Number(addon?.visitRevenue || 0);
  const addonInvoice = Number(addon?.invoiceTotal || 0);
  const addonMonthly = Number(addon?.monthlyValue || 0);

  const visitRevenue = pricing.visitRevenue + addonVisit + deep.total;
  if (revenueInput) revenueInput.value = visitRevenue.toFixed(2);

  const cashCollected = (jobType === 'oneTime')
    ? visitRevenue
    : (pricing.invoiceTotal + addonInvoice + (deep.enabled ? deep.total : 0));

  const repId = document.getElementById('saleRep')?.value;
  const rep = repById(repId);
  const payoutRatePct = Number(rep?.payoutRate ?? state.config.defaultPayoutRate);
  const payoutRate = payoutRatePct / 100;

  const costs = Number(document.getElementById('fees')?.value || 0);
  const netForPayout = Math.max(0, visitRevenue - costs);
  const payout = netForPayout * payoutRate;
  const youKeepVisit = netForPayout - payout;

  if (preview) {
    preview.innerHTML = `
      <div style="display:grid;gap:8px;">
        <div><strong>Cash Collected Upfront:</strong> ${money(cashCollected)}</div>
        <div><strong>Visit Revenue (for payout):</strong> ${money(visitRevenue)}</div>
        <div style="display:flex;justify-content:space-between;gap:10px;opacity:.9;">
          <div><span style="opacity:.75">Operator payout (${payoutRatePct.toFixed(1)}%):</span> <strong>${money(payout)}</strong></div>
          <div><span style="opacity:.75">You keep (this visit):</span> <strong>${money(youKeepVisit)}</strong></div>
        </div>
        ${addon ? `<div style="opacity:.8;font-size:12px;">Stacked pad add-on: ${escapeHtml(addon.padSize)} • ${escapeHtml(addon.cadence)} • ${money(addon.visitRevenue)} per visit</div>` : ''}
        ${deep.enabled ? `<div style="opacity:.8;font-size:12px;">Deep clean added: ${money(deep.total)} (${escapeHtml(deep.condition)})</div>` : ''}
      </div>
    `;
  }
}

// Handle “Log Completed Job”
async function handleSaleSubmit(e) {
  e.preventDefault();

  const customerName = String(document.getElementById('customerName')?.value || '').trim();
  const date = String(document.getElementById('saleDate')?.value || '').trim();
  const repId = String(document.getElementById('saleRep')?.value || '').trim();
  const product = String(document.getElementById('productLine')?.value || '').trim();
  const units = Number(document.getElementById('units')?.value || 1);
  const billingFrequency = String(document.getElementById('billingFrequency')?.value || 'monthly');
  const locationsCount = Number(document.getElementById('locationsCount')?.value || 1);
  const jobType = String(document.getElementById('jobType')?.value || 'recurring');
  const fees = Number(document.getElementById('fees')?.value || 0);
  const activationStatus = String(document.getElementById('activationStatus')?.value || 'due');

  const deep = getDeepCleanSelection();

  const visitRevenue = Number(document.getElementById('revenue')?.value || 0);

  if (!customerName || !date || !product) {
    showAlert('Fill required fields', 'error');
    return;
  }

  const visit = {
    id: generateId(),
    repId: repId || null,
    customerName,
    date,
    product,
    units,
    billingFrequency,
    locationsCount,
    jobType,
    visitRevenue,
    fees,
    activationStatus,
    deepCleanEnabled: deep.enabled,
    deepCleanCondition: deep.condition,
    deepCleanTotal: deep.total
  };

  try {
    if (supabaseClient) {
      await insertVisit(visit);
      await syncFromSupabase();
    } else {
      state.sales.unshift(visit);
      saveStateLocal();
    }

    showAlert('✅ Job logged', 'success');
    renderEverything();

    // reset minimal fields
    document.getElementById('customerName').value = '';
    document.getElementById('fees').value = '';
  } catch (err) {
    console.error(err);
    showAlert(`Save failed: ${err?.message || 'error'}`, 'error');
  }
}

// ==============================
// Minimal render hooks for existing dashboard sections
// (If you already have these functions in your original script,
// keep them there—this file focuses on Supabase + Orders/Routes.)
//
// If you want your old summaries/tables back exactly as before,
// keep your existing renderSummary/renderSalesTable/etc. and call them.
// ==============================
function renderEverything() {
  renderRepSelect();
  renderRepsList();

  // Orders-focused KPIs
  try { renderOpsKpis(); } catch (e) {}

  // If you already have these render functions in your original dashboard script,
  // keep them and we’ll call them safely (only if they exist).
  // This prevents breaking your existing summaries/tables.
  try { if (typeof window.renderSummary === 'function') window.renderSummary(); } catch (e) {}
  try { if (typeof window.renderSalesTable === 'function') window.renderSalesTable(); } catch (e) {}
  try { if (typeof window.renderByRep === 'function') window.renderByRep(); } catch (e) {}
  try { if (typeof window.renderWeekly === 'function') window.renderWeekly(); } catch (e) {}
  try { if (typeof window.renderPayments === 'function') window.renderPayments(); } catch (e) {}
  try { if (typeof window.renderInsights === 'function') window.renderInsights(); } catch (e) {}

  // If these panels exist, keep them up to date.
  try { renderDispatchPanel(); } catch (e) {}
  try { renderMapPanel(); } catch (e) {}
  try { renderLeadsPanel(); } catch (e) {}
  try { renderOrdersPanel(); } catch (e) {}
  try { renderRoutesPanel(); } catch (e) {}
}

// ==============================
// Init + event bindings
// ==============================
async function boot() {
  // Failsafe: never let the startup overlay trap the UI
  setTimeout(() => { try { hideStartupOverlay(); } catch (_) {} }, 4000);

  try {
      // Local first so UI has something even if supabaseClient isn't ready.
      loadStateLocal();
    
      // Set defaults / bind local UI
      setDefaultDate();
      setupStatusToggle();
      setupAutoPricing();
    
      // Bind your “Log Completed Job” form
      const saleForm = document.getElementById('saleForm');
      if (saleForm) saleForm.addEventListener('submit', handleSaleSubmit);
    
      // Bind operator add form (if you have one)
      // (You already expose addRep() on window; this just makes Enter work if you have a form wrapper.)
      const repForm = document.getElementById('repForm');
      if (repForm) {
        repForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          await addRep();
        });
      }
    
      // Try Supabase (singleton)
      const sb = initSupabase();
      if (sb) {
        sb.auth.getSession()
          .then(({ data }) => {
            const session = data && data.session ? data.session : null;
            console.log(session ? 'Session restored' : 'No session');
            document.dispatchEvent(new CustomEvent('auth:ready', { detail: session }));
          })
          .catch(err => console.warn('Auth hydrate failed', err));
      }
    
      // If supabaseClient is configured, require auth and then sync.
      // If not configured, we run in local mode.
      if (supabaseClient) {
        ensureAuthOverlay();
    
        // Live auth changes (login/logout)
        try {
          supabaseClient.auth.onAuthStateChange(async (_event, _session) => {
            // Avoid kicking you out due to slow getSession() calls.
            try { window.__cachedSession = _session || null; } catch (_) {}
            if (!_session) {
              hideAppShell();
              showAuthGate();
              return;
            }
            hideAuthGate();
            showAppShell();
            await syncFromSupabase();
            saveStateLocal(); // keep local backup copy
            renderEverything();
          });
        } catch (e) {
          console.warn('Auth listener error:', e);
        }
    
        const ok = await requireAuth();
        if (ok) {
          await syncFromSupabase();
          saveStateLocal();
        }
      }
    
      // First render
      renderEverything();
    
      // Default tab
      if (typeof window.switchTab === 'function') {
        try { window.switchTab('dispatch'); } catch (e) {}
      }
  } catch (err) {
    console.error('BOOT ERROR:', err);
    try { setAuthMsg(err?.message || String(err), 'error'); } catch (_) {}
    try {
      // If Supabase is enabled, fall back to showing the auth gate so you can still log in.
      if (supabaseClient) {
        hideAppShell();
        showAuthGate();
      } else {
        hideAuthGate();
        showAppShell();
      }
    } catch (_) {}
  } finally {
    try { revealContentWrapper(); } catch (_) {}

    // Always dismiss startup overlay (even if boot throws or auth hangs)
    try { hideStartupOverlay(); } catch (_) {}
  }
}


// Make sure these are available globally (your HTML onclicks rely on this)
window.renderEverything = renderEverything;

// Boot on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}