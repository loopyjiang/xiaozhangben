'use strict';

const TOKEN_KEY = 'ledger.token';
const CACHE_KEY = 'ledger.cache.v1';
const API_BASE_KEY = 'ledger.apiBase';

/* 装在手机里的 App 从本地加载页面，没有"当前域名"，必须显式指定服务器 */
const IS_NATIVE = location.protocol === 'capacitor:' || location.protocol === 'file:'
  || Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

let API_BASE = (localStorage.getItem(API_BASE_KEY) || '').replace(/\/+$/, '');

const CATS = {
  expense: [
    ['餐饮', '🍚'], ['交通', '🚌'], ['购物', '🛍️'], ['家居', '🏠'], ['娱乐', '🎮'],
    ['医疗', '💊'], ['学习', '📚'], ['人情', '🎁'], ['其他', '📦'],
  ],
  income: [
    ['工资', '💰'], ['奖金', '🎉'], ['理财', '📈'], ['兼职', '💼'], ['红包', '🧧'], ['其他', '📦'],
  ],
};

const CAT_ICON = {};
for (const list of Object.values(CATS)) for (const [name, icon] of list) CAT_ICON[name] = icon;

/* 支出分类用 Loopy 的小表情当图标，收入仍用 emoji，一眼分得清收支 */
const CAT_IMG = {
  餐饮: 'loopy/02-eat.webp',
  交通: 'loopy/03-car.webp',
  购物: 'loopy/04-bag.webp',
  家居: 'loopy/05-home.webp',
  娱乐: 'loopy/06-music.webp',
  医疗: 'loopy/07-flower.webp',
  学习: 'loopy/08-study.webp',
  人情: 'loopy/09-gift.webp',
  其他: 'loopy/01-smile.webp',
};

/* 分类图标：支出用 Loopy 小表情，收入用 emoji，一眼分得清收支 */
const catIcon = (name, type = 'expense', cls = '') => {
  const src = type === 'expense' ? CAT_IMG[name] : '';
  const attr = cls ? ` class="${cls}"` : '';
  if (src) return `<img src="${src}" alt="" decoding="async"${attr}>`;
  return `<span${attr}>${CAT_ICON[name] || '📦'}</span>`;
};

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

const nf = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n) => nf.format(Number(n) || 0);

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  user: null,
  records: [],
  aiEnabled: false,
  ai: { enabled: false, source: '', model: '' },
  aiConfig: null,
  analysis: null,
  month: (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; })(),
  view: 'home',
  offline: false,
  draft: null,
  installEvent: null,
};

/* ================= 网络 ================= */

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('网络连不上，请检查网络或服务器地址', 0);
  }

  if (res.status === 401) {
    clearSession();
    throw new ApiError('登录已失效，请重新登录', 401);
  }

  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }

  if (!res.ok) throw new ApiError(data?.error || `请求失败（${res.status}）`, res.status);
  return data;
}

/* ================= 提示 ================= */

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ================= 登录 ================= */

function clearSession() {
  state.token = '';
  state.user = null;
  state.analysis = null;
  state.aiConfig = null;
  localStorage.removeItem(TOKEN_KEY);
}

/* 备案号由服务端下发，绑域名对外访问时按工信部要求必须展示 */
async function loadIcp() {
  let text = '';
  try {
    const res = await fetch(`${API_BASE}/api/health`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      text = (data && data.icp) || '';
    }
  } catch {
    return;
  }
  for (const id of ['icpAuth', 'icpSettings']) {
    const el = $(id);
    if (!el) continue;
    el.textContent = text;
    el.hidden = !text;
  }
}

function showAuth(message) {
  $('appRoot').hidden = true;
  $('authScreen').hidden = false;
  syncServerField();
  loadIcp();
  if (message) {
    const el = $('authError');
    el.textContent = message;
    el.hidden = false;
  }
}

function showApp() {
  $('authScreen').hidden = true;
  $('appRoot').hidden = false;
  $('offlineBar').hidden = !state.offline;
  loadIcp();
  renderAll();
}

let authMode = 'login';

function normalizeServer(value) {
  let s = String(value || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, '');
}

async function pingServer(base) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`${base}/api/health`, { signal: controller.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 服务器地址只在 App 环境或已配置过时显示 */
function syncServerField() {
  const field = $('serverField');
  const input = $('authServer');
  const needServer = IS_NATIVE || Boolean(API_BASE);
  field.hidden = !needServer;
  if (needServer && !input.value) input.value = API_BASE;
  $('serverToggle').hidden = needServer;
}

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-switch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  $('codeField').hidden = mode !== 'register';
  $('authSubmit').textContent = mode === 'login' ? '打开我的小账本' : '开始记账';
  $('authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('authError').hidden = true;
}

async function submitAuth(e) {
  e.preventDefault();
  const username = $('authUser').value.trim();
  const password = $('authPass').value;
  const code = $('authCode').value.trim();
  const errEl = $('authError');
  const btn = $('authSubmit');
  const showErr = (msg) => { errEl.textContent = msg; errEl.hidden = false; };

  if (!username || !password) {
    showErr('用户名和密码都要填');
    return;
  }

  btn.disabled = true;
  btn.textContent = '请稍候…';
  try {
    const typed = normalizeServer($('authServer').value);
    if (typed && typed !== API_BASE) {
      if (!(await pingServer(typed))) throw new ApiError('连不上这个服务器地址，检查一下 IP 和端口', 0);
      API_BASE = typed;
      localStorage.setItem(API_BASE_KEY, typed);
    }
    if (IS_NATIVE && !API_BASE) throw new ApiError('请先填写服务器地址', 0);

    const path = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const data = await api(path, { method: 'POST', body: { username, password, code } });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem(TOKEN_KEY, data.token);
    await loadRecords();
    const me = await api('/api/me').catch(() => null);
    if (me) applyAiStatus(me);
    showApp();
    toast(`欢迎，${data.user.username}`);
  } catch (err) {
    showErr(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = authMode === 'login' ? '登录' : '注册并进入';
  }
}

/* AI 状态：能不能用、用的是自己的接口还是默认的 */
function applyAiStatus(payload) {
  state.ai = payload.ai || { enabled: Boolean(payload.aiEnabled), source: '', model: '' };
  state.aiEnabled = Boolean(state.ai.enabled);
}

/* ================= 数据 ================= */

function writeCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      records: state.records,
      user: state.user,
      aiEnabled: state.aiEnabled,
      ai: state.ai,
      savedAt: Date.now(),
    }));
  } catch { /* 容量满了就算了 */ }
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function loadRecords() {
  const data = await api('/api/records');
  state.records = data.records || [];
  state.offline = false;
  writeCache();
}

/* ================= 渲染：明细 ================= */

function monthRecords() {
  const prefix = `${state.month.y}-${pad2(state.month.m)}`;
  return state.records.filter((r) => String(r.date).startsWith(prefix));
}

function renderMonthLabel() {
  $('monthLabel').textContent = `${state.month.y}年${state.month.m}月`;
}

function renderSummary(list) {
  let expense = 0, income = 0;
  for (const r of list) {
    if (r.type === 'income') income += Number(r.amount) || 0;
    else expense += Number(r.amount) || 0;
  }
  $('sumExpense').textContent = money(expense);
  $('sumIncome').textContent = `¥${money(income)}`;
  $('sumBalance').textContent = `¥${money(income - expense)}`;
  $('sumCount').textContent = String(list.length);
  $('listHint').textContent = list.length ? `共 ${list.length} 笔` : '';
}

function renderList(list) {
  const box = $('recordList');
  if (!list.length) {
    box.innerHTML = `<div class="empty">
      <img src="loopy/04-bag.webp" alt="" width="132" height="132">
      <b>这个月还没有记账</b>点右下角的 + 记第一笔
    </div>`;
    return;
  }

  const groups = new Map();
  for (const r of list) {
    if (!groups.has(r.date)) groups.set(r.date, []);
    groups.get(r.date).push(r);
  }

  const html = [];
  for (const [date, items] of groups) {
    const d = new Date(`${date}T00:00:00`);
    const label = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`;
    const dayExpense = items.filter((r) => r.type !== 'income').reduce((s, r) => s + Number(r.amount), 0);
    const dayIncome = items.filter((r) => r.type === 'income').reduce((s, r) => s + Number(r.amount), 0);
    const parts = [];
    if (dayExpense) parts.push(`支出 ¥${money(dayExpense)}`);
    if (dayIncome) parts.push(`收入 ¥${money(dayIncome)}`);

    html.push(`<div class="day-group">
      <div class="day-head"><span>${label}</span><span class="day-sum">${parts.join(' · ')}</span></div>
      ${items.map(recordHtml).join('')}
    </div>`);
  }
  box.innerHTML = html.join('');
}

function recordHtml(r) {
  const isIncome = r.type === 'income';
  const sub = r.note ? r.note : r.category;
  return `<div class="record" data-id="${r.id}">
    <div class="ico">${catIcon(r.category, r.type)}</div>
    <div class="meta">
      <div class="name">${escapeHtml(r.category)}</div>
      <div class="sub">${escapeHtml(sub)}</div>
    </div>
    <div class="amt ${isIncome ? 'income' : 'expense'}">${isIncome ? '+' : '-'}${money(r.amount)}</div>
  </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================= 渲染：统计 ================= */

function renderStats(list) {
  const expenseList = list.filter((r) => r.type !== 'income');
  const total = expenseList.reduce((s, r) => s + Number(r.amount), 0);
  $('statTotal').textContent = money(total);
  $('statCount').textContent = String(expenseList.length);

  const now = new Date();
  const isCurrent = now.getFullYear() === state.month.y && now.getMonth() + 1 === state.month.m;
  const days = isCurrent ? now.getDate() : new Date(state.month.y, state.month.m, 0).getDate();
  $('statDaily').textContent = `¥${money(total / days)}`;

  const byCat = new Map();
  for (const r of expenseList) byCat.set(r.category, (byCat.get(r.category) || 0) + Number(r.amount));
  const sorted = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const max = sorted[0]?.[1] || 1;

  $('catList').innerHTML = sorted.length
    ? sorted.map(([name, val]) => {
      const pct = total ? (val / total) * 100 : 0;
      return `<div class="cat-row">
        <div class="cat-top">
          <div class="left">${catIcon(name, 'expense')}<span class="nm">${escapeHtml(name)}</span>
          <span class="pc">${pct.toFixed(0)}%</span></div>
          <div class="val">¥${money(val)}</div>
        </div>
        <div class="bar"><i style="width:${Math.max(3, (val / max) * 100)}%"></i></div>
      </div>`;
    }).join('')
    : `<div class="empty"><b>本月没有支出</b>记几笔就能看到构成</div>`;

  renderTrend();
}

function renderTrend() {
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(state.month.y, state.month.m - 1 - i, 1);
    months.push({ y: d.getFullYear(), m: d.getMonth() + 1 });
  }

  const sums = months.map(({ y, m }) => {
    const prefix = `${y}-${pad2(m)}`;
    return state.records
      .filter((r) => r.type !== 'income' && String(r.date).startsWith(prefix))
      .reduce((s, r) => s + Number(r.amount), 0);
  });
  const max = Math.max(...sums, 1);

  $('trend').innerHTML = months.map((mo, i) => {
    const isCur = mo.y === state.month.y && mo.m === state.month.m;
    const h = Math.max(3, (sums[i] / max) * 88);
    return `<div class="trend-col ${isCur ? 'cur' : ''}">
      <div class="tb" style="height:${h}px" title="${money(sums[i])}"></div>
      <div class="tl">${mo.m}月</div>
    </div>`;
  }).join('');
}

/* ================= 渲染：设置 ================= */

function monthKey() {
  return `${state.month.y}-${pad2(state.month.m)}`;
}

function renderSettings() {
  const name = state.user?.username || '—';
  $('userName').textContent = name;

  if (state.user?.createdAt) {
    const d = new Date(state.user.createdAt);
    $('userSince').textContent = `记账第 ${Math.max(1, Math.ceil((Date.now() - d.getTime()) / 86400000))} 天`;
  }

  const ai = state.ai || {};
  if (!ai.enabled) {
    $('aiStatus').textContent = '还没开启。填一个自己的接口就能用。';
  } else if (ai.source === 'user') {
    $('aiStatus').textContent = `用的是你自己的接口（${ai.model}）。首页输入「午饭 28」就能记。`;
  } else {
    $('aiStatus').textContent = `已开启（${ai.model}）。首页输入「午饭 28」就能记。`;
  }
  $('aiForm').hidden = !ai.enabled || state.offline;
  $('aiConfigToggle').textContent = $('aiConfigBox').hidden
    ? (ai.source === 'user' ? '改我的接口' : '用自己的接口')
    : '收起';
}

/* Loopy 的分析结果，换月份就作废，不串月份 */
function renderAnalysis() {
  const card = $('aiThinkCard');
  const box = $('aiThinkBody');
  const btn = $('aiThinkBtn');
  card.hidden = !state.ai?.enabled;

  const a = state.analysis && state.analysis.month === monthKey() ? state.analysis : null;

  if (!a) {
    box.hidden = true;
    box.innerHTML = '';
    btn.textContent = '帮我看一眼';
    return;
  }

  if (a.empty) {
    box.hidden = false;
    box.innerHTML = `<p class="say-head">${escapeHtml(a.message || '这个月还没有账')}</p>`;
    btn.textContent = '再看一次';
    return;
  }

  const points = (a.points || []).map((p) => `<li>${escapeHtml(p)}</li>`).join('');
  box.hidden = false;
  box.innerHTML = `
    <p class="say-head">${escapeHtml(a.headline || '')}</p>
    ${points ? `<ul class="say-points">${points}</ul>` : ''}
    ${a.tip ? `<p class="say-tip">${escapeHtml(a.tip)}</p>` : ''}
    <p class="say-note">Loopy 随口说说，钱还是你自己管</p>`;
  btn.textContent = '再说两句';
}

function renderAll() {
  renderMonthLabel();
  const list = monthRecords();
  renderSummary(list);
  renderList(list);
  renderStats(list);
  renderAnalysis();
  renderSettings();
}

/* ================= 视图切换 ================= */

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('fabAdd').hidden = view === 'settings';
  /* 我的页面不按月看，把月份切换收起来 */
  document.querySelector('.month-switch').hidden = view === 'settings';
  window.scrollTo({ top: 0 });
}

/* ================= 记账面板 ================= */

function openSheet(type = 'expense') {
  state.draft = {
    type,
    amount: '0',
    category: CATS[type][0][0],
    note: '',
    date: todayStr(),
  };
  $('dateInput').value = state.draft.date;
  $('noteInput').value = '';
  $('amountText').textContent = '0';
  document.querySelectorAll('.type-btn').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  renderCatGrid();
  $('sheet').classList.add('open');
  $('sheetMask').classList.add('show');
}

function closeSheet() {
  $('sheet').classList.remove('open');
  $('sheetMask').classList.remove('show');
}

function renderCatGrid() {
  const list = CATS[state.draft.type];
  $('catGrid').innerHTML = list.map(([name]) => `
    <button class="cat-item ${state.draft.category === name ? 'active' : ''}" data-cat="${name}">
      ${catIcon(name, state.draft.type, 'ci')}<span>${name}</span>
    </button>`).join('');
}

function pressKey(k) {
  const d = state.draft;
  let val = d.amount;

  if (k === 'del') {
    val = val.length > 1 ? val.slice(0, -1) : '0';
  } else if (k === '.') {
    if (!val.includes('.')) val = `${val}.`;
  } else {
    if (val.includes('.') && val.split('.')[1].length >= 2) return;
    if (val.replace('.', '').length >= 9) return;
    val = val === '0' ? k : val + k;
  }
  d.amount = val;
  $('amountText').textContent = val;
}

async function saveRecord() {
  const d = state.draft;
  const amount = Number(d.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    toast('先输入金额');
    return;
  }

  const payload = {
    type: d.type,
    amount,
    category: d.category,
    note: $('noteInput').value.trim(),
    date: $('dateInput').value || todayStr(),
  };

  $('sheetSave').disabled = true;
  try {
    const data = await api('/api/records', { method: 'POST', body: payload });
    const rec = data.record;
    state.records.unshift(rec);
    writeCache();

    const [y, m] = rec.date.split('-').map(Number);
    state.month = { y, m };
    closeSheet();
    renderAll();
    toast(`${rec.type === 'income' ? '收入' : '支出'} ¥${money(rec.amount)} 已记上`);
  } catch (err) {
    toast(err.message);
  } finally {
    $('sheetSave').disabled = false;
  }
}

/* ================= AI 记账 ================= */

async function askAI(e) {
  e.preventDefault();
  const input = $('aiInput');
  const text = input.value.trim();
  if (!text) return;

  const btn = $('aiSend');
  btn.disabled = true;
  btn.textContent = '记着…';
  try {
    const data = await api('/api/ai', { method: 'POST', body: { text } });
    const list = data.records || [];
    if (!list.length) {
      toast('没看懂这句话，换个说法试试');
      return;
    }
    state.records.unshift(...list);
    writeCache();
    input.value = '';
    renderAll();
    const first = list[0];
    toast(list.length === 1
      ? `已记账：${first.category} ¥${money(first.amount)}`
      : `已记账 ${list.length} 笔`);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '记一笔';
  }
}

/* ================= AI 看账 ================= */

async function askAnalyze() {
  const btn = $('aiThinkBtn');
  if (!state.ai?.enabled) {
    toast('先去「我的」里配一个 AI 接口');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Loopy 在翻账本…';
  try {
    const data = await api('/api/ai/analyze', { method: 'POST', body: { month: monthKey() } });
    state.analysis = data;
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    renderAnalysis();
  }
}

/* ================= 自己的 AI 接口 ================= */

function aiConfigMsg(text, ok = false) {
  const el = $('aiConfigMsg');
  el.hidden = !text;
  el.textContent = text || '';
  el.style.color = ok ? 'var(--green)' : 'var(--pink-deep)';
}

async function openAiConfig() {
  const box = $('aiConfigBox');
  const toggle = $('aiConfigToggle');

  if (!box.hidden) {
    box.hidden = true;
    toggle.textContent = state.ai?.source === 'user' ? '改我的接口' : '用自己的接口';
    return;
  }

  box.hidden = false;
  toggle.textContent = '收起';
  aiConfigMsg('');
  try {
    const cfg = await api('/api/ai/config');
    state.aiConfig = cfg;
    if (cfg.custom) {
      $('aiBase').value = cfg.custom.base;
      $('aiModel').value = cfg.custom.model;
      $('aiKey').placeholder = `${cfg.custom.hint} 已保存，要改就填新的`;
      $('aiClearBtn').hidden = false;
    } else if (cfg.suggest) {
      $('aiBase').value = cfg.suggest.base || '';
      $('aiModel').value = cfg.suggest.model || '';
    }
  } catch (err) {
    aiConfigMsg(err.message);
  }
}

async function testAi() {
  const btn = $('aiTestBtn');
  btn.disabled = true;
  aiConfigMsg('接通中…', true);
  try {
    const r = await api('/api/ai/config/test', {
      method: 'POST',
      body: {
        base: $('aiBase').value.trim(),
        model: $('aiModel').value.trim(),
        key: $('aiKey').value.trim(),
      },
    });
    aiConfigMsg(`通了，${r.ms} 毫秒，模型 ${r.model}`, true);
  } catch (err) {
    aiConfigMsg(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function saveAi() {
  const btn = $('aiSaveBtn');
  btn.disabled = true;
  try {
    const r = await api('/api/ai/config', {
      method: 'PUT',
      body: {
        base: $('aiBase').value.trim(),
        model: $('aiModel').value.trim(),
        key: $('aiKey').value.trim(),
      },
    });
    applyAiStatus({ ai: r.ai });
    $('aiKey').value = '';
    $('aiConfigBox').hidden = true;
    $('aiConfigToggle').hidden = false;
    state.analysis = null;
    renderAll();
    toast('已换成你的接口');
  } catch (err) {
    aiConfigMsg(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function clearAi() {
  if (!confirm('改回默认接口？你自己的 Key 会被删掉。')) return;
  try {
    const r = await api('/api/ai/config', { method: 'DELETE' });
    applyAiStatus({ ai: r.ai });
    $('aiBase').value = '';
    $('aiModel').value = '';
    $('aiKey').value = '';
    $('aiKey').placeholder = 'sk-…';
    $('aiClearBtn').hidden = true;
    aiConfigMsg('已改回默认', true);
    state.analysis = null;
    renderAll();
  } catch (err) {
    aiConfigMsg(err.message);
  }
}

/* ================= 备份 ================= */

async function exportBackup() {
  try {
    const res = await fetch(`${API_BASE}/api/export`, { headers: { Authorization: `Bearer ${state.token}` } });
    if (!res.ok) throw new Error('导出失败');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `小账本-${state.user?.username || 'backup'}-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('已导出');
  } catch (err) {
    toast(err.message);
  }
}

async function importBackup(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const records = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(records) || !records.length) {
      toast('这个文件里没有账目');
      return;
    }
    if (!confirm(`将导入 ${records.length} 条记录，并覆盖当前所有账目。继续吗？`)) return;

    const result = await api('/api/import', { method: 'POST', body: { records, replace: true } });
    await loadRecords();
    renderAll();
    toast(`已导入 ${result.imported} 条`);
  } catch (err) {
    toast(`导入失败：${err.message}`);
  }
}

/* ================= 登录态初始化 ================= */

async function boot() {
  if (!state.token) {
    showAuth();
    return;
  }
  if (IS_NATIVE && !API_BASE) {
    showAuth('请先填写服务器地址');
    return;
  }

  try {
    const me = await api('/api/me');
    state.user = me.user;
    applyAiStatus(me);
    await loadRecords();
    showApp();
  } catch (err) {
    const cache = readCache();
    if (err.status === 401) {
      showAuth(err.message);
      return;
    }
    if (cache?.records) {
      state.records = cache.records;
      state.user = cache.user;
      state.aiEnabled = Boolean(cache.aiEnabled);
      state.ai = cache.ai || { enabled: Boolean(cache.aiEnabled), source: '', model: '' };
      state.offline = true;
      $('offlineBar').hidden = false;
      $('appRoot').hidden = false;
      $('authScreen').hidden = true;
      renderAll();
    } else {
      showAuth(err.message);
    }
  }
}

/* ================= 事件绑定 ================= */

function bind() {
  document.querySelectorAll('.auth-switch button').forEach((b) => {
    b.addEventListener('click', () => setAuthMode(b.dataset.mode));
  });
  $('authForm').addEventListener('submit', submitAuth);
  $('serverToggle').addEventListener('click', () => {
    $('serverField').hidden = false;
    $('serverToggle').hidden = true;
    $('authServer').focus();
  });

  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => switchView(t.dataset.view));
  });

  $('prevMonth').addEventListener('click', () => {
    const d = new Date(state.month.y, state.month.m - 2, 1);
    state.month = { y: d.getFullYear(), m: d.getMonth() + 1 };
    state.analysis = null;
    renderAll();
  });
  $('nextMonth').addEventListener('click', () => {
    const d = new Date(state.month.y, state.month.m, 1);
    state.month = { y: d.getFullYear(), m: d.getMonth() + 1 };
    state.analysis = null;
    renderAll();
  });

  $('fabAdd').addEventListener('click', () => openSheet('expense'));
  $('sheetCancel').addEventListener('click', closeSheet);
  $('sheetMask').addEventListener('click', closeSheet);
  $('sheetSave').addEventListener('click', saveRecord);

  document.querySelectorAll('.type-btn').forEach((b) => {
    b.addEventListener('click', () => {
      state.draft.type = b.dataset.type;
      state.draft.category = CATS[b.dataset.type][0][0];
      document.querySelectorAll('.type-btn').forEach((x) => x.classList.toggle('active', x === b));
      renderCatGrid();
    });
  });

  $('catGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.cat-item');
    if (!btn) return;
    state.draft.category = btn.dataset.cat;
    renderCatGrid();
  });

  $('numpad').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) pressKey(btn.dataset.k);
  });

  $('recordList').addEventListener('click', async (e) => {
    const row = e.target.closest('.record');
    if (!row) return;
    const rec = state.records.find((r) => r.id === row.dataset.id);
    if (!rec) return;
    if (!confirm(`删除这笔「${rec.category} ¥${money(rec.amount)}」？`)) return;
    try {
      await api(`/api/records/${rec.id}`, { method: 'DELETE' });
      state.records = state.records.filter((r) => r.id !== rec.id);
      writeCache();
      renderAll();
      toast('已删除');
    } catch (err) {
      toast(err.message);
    }
  });

  $('aiForm').addEventListener('submit', askAI);
  $('aiThinkBtn').addEventListener('click', askAnalyze);

  $('aiConfigToggle').addEventListener('click', openAiConfig);
  $('aiTestBtn').addEventListener('click', testAi);
  $('aiSaveBtn').addEventListener('click', saveAi);
  $('aiClearBtn').addEventListener('click', clearAi);

  $('exportBtn').addEventListener('click', exportBackup);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importBackup(file);
    e.target.value = '';
  });

  $('logoutBtn').addEventListener('click', async () => {
    if (!confirm('确定退出登录？')) return;
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
    clearSession();
    localStorage.removeItem(CACHE_KEY);
    showAuth();
  });

  window.addEventListener('online', async () => {
    if (!state.token) return;
    try {
      await loadRecords();
      $('offlineBar').hidden = true;
      renderAll();
      toast('已恢复连接');
    } catch { /* 还是不行 */ }
  });

  window.addEventListener('offline', () => {
    state.offline = true;
    $('offlineBar').hidden = false;
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installEvent = e;
    $('installBtn').hidden = false;
  });

  $('installBtn').addEventListener('click', async () => {
    if (!state.installEvent) return;
    state.installEvent.prompt();
    await state.installEvent.userChoice;
    state.installEvent = null;
    $('installBtn').hidden = true;
  });
}

/* ================= 启动 ================= */

bind();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

boot();
