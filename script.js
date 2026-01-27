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
  config: DEFAULT_CONFIG
};

// ==============================
// Supabase setup
// ==============================
let supabase = null;
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
  if (!supabaseReady()) return null;
  supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  return supabase;
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
      if (!supabase) {
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
      const { error } = await supabase.auth.signInWithPassword({ email, password });
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
      if (!supabase) {
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
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;

      setAuthMsg('Account created. If email confirmation is required, confirm then login.', 'info');
    } catch (e) {
      console.error(e);
      setAuthMsg(`Signup failed: ${e?.message || 'Unknown error'}`, 'error');
    }
  });
}

function ensureAuthOverlay() { /* legacy no-op: using #authGate */ }

async function requireAuth() {
  // If no Supabase configured, allow local mode and show app.
  if (!supabase) {
    hideAuthGate();
    showAppShell();
    return true;
  }

  bindAuthGate();

  // Add a timeout so auth calls can’t hang forever.
  const timeoutMs = 4500;
  const withTimeout = (p) =>
    Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Auth check timed out')), timeoutMs))
    ]);

  try {
    const { data } = await withTimeout(supabase.auth.getSession());
    const session = data?.session;

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

// ==============================
// Supabase sync
// ==============================
async function syncFromSupabase() {
  if (!supabase) return;

  // Operators
  {
    const { data, error } = await supabase.from('operators').select('*').order('created_at', { ascending: true });
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
    const { data, error } = await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(250);
    if (error) throw error;
    state.orders = data || [];
  }

  // Assignments
  {
    const { data, error } = await supabase.from('assignments').select('*').order('service_date', { ascending: true });
    if (error) throw error;
    state.assignments = data || [];
  }

  // Visits (optional, your manual “Log Completed Job”)
  {
    const { data, error } = await supabase.from('visits').select('*').order('service_date', { ascending: false }).limit(500);
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
  if (!supabase) return;
  const payload = {
    id: rep.id || undefined,
    name: rep.name,
    payout_rate: Number(rep.payoutRate ?? 30),
    is_manager: !!rep.isManager,
    active: rep.active !== false
  };
  const { data, error } = await supabase.from('operators').upsert(payload).select('*').single();
  if (error) throw error;
  return data;
}

async function insertVisit(visit) {
  if (!supabase) return;
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
  const { data, error } = await supabase.from('visits').insert(payload).select('*').single();
  if (error) throw error;
  return data;
}

async function assignOrder({ orderId, operatorId, serviceDate, sequence = 1 }) {
  if (!supabase) return;

  // Upsert assignment (unique(order_id) prevents dupes)
  const { data: a, error: aErr } = await supabase
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
  const { error: oErr } = await supabase
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
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

  const btn = Array.from(document.querySelectorAll('.tab'))
    .find(b => (b.getAttribute('onclick') || '').includes(`'${tab}'`));
  if (btn) btn.classList.add('active');

  const contentId =
    tab === 'all' ? 'allTab'
    : tab === 'byRep' ? 'byRepTab'
    : tab === 'weekly' ? 'weeklyTab'
    : tab === 'payments' ? 'paymentsTab'
    : tab === 'insights' ? 'insightsTab'
    : tab === 'orders' ? 'ordersTab'
    : tab === 'routes' ? 'routesTab'
    : 'allTab';

  document.getElementById(contentId)?.classList.add('active');

  // render lazy panels
  if (tab === 'orders') renderOrdersPanel();
  if (tab === 'routes') renderRoutesPanel();
}
window.switchTab = switchTab;

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
    id: generateId(), // local id fallback, Supabase will overwrite
    name,
    payoutRate,
    isManager,
    active: true
  };

  try {
    if (supabase) {
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
    if (!supabase) throw new Error('Supabase not configured.');

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

window.refreshSupabase = async function() {
  try {
    if (!supabase) {
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
    if (supabase) {
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
      // Local first so UI has something even if supabase isn't ready.
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
    
      // Try Supabase
      initSupabase();
    
      // If supabase is configured, require auth and then sync.
      // If not configured, we run in local mode.
      if (supabase) {
        ensureAuthOverlay();
    
        // Live auth changes (login/logout)
        try {
          supabase.auth.onAuthStateChange(async (_event, _session) => {
            const ok = await requireAuth();
            if (!ok) return;
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
    
      // Default tab behavior: keep your existing default if you already do it.
      // Otherwise, show "all" by default.
      if (typeof window.switchTab === 'function') {
        try { window.switchTab('all'); } catch (e) {}
      }
  } catch (err) {
    console.error('BOOT ERROR:', err);
    try { setAuthMsg(err?.message || String(err), 'error'); } catch (_) {}
    try {
      // If Supabase is enabled, fall back to showing the auth gate so you can still log in.
      if (supabase) {
        hideAppShell();
        showAuthGate();
      } else {
        hideAuthGate();
        showAppShell();
      }
    } catch (_) {}
  } finally {
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