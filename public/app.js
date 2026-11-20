'use strict';

const TOKEN_KEY = 'ledger.token';
const CACHE_KEY = 'ledger.cache.v1';
const API_BASE_KEY = 'ledger.apiBase';

/* 装在手机里的 App 从本地加载页面，没有"当前域名"，必须显式指定服务器 */
const IS_NATIVE = location.protocol === 'capacitor:' || location.protocol === 'file:'
  || Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

/* 装成 App 之后开箱指向自己的服务器，省得家里人第一次还要手打网址 */
const DEFAULT_API_BASE = 'https://ledger.krshare.site';
let API_BASE = (localStorage.getItem(API_BASE_KEY) || (IS_NATIVE ? DEFAULT_API_BASE : '')).replace(/\/+$/, '');

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
  month: (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1, d: null }; })(),
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

/* 桌宠在场时让她说，别再弹一个 toast 挤在一起 */
function notifyHappy(msg) {
  if (pet.on && !chatState.open && state.view !== 'settings') petSay(msg, 3000);
  else toast(msg);
}

/* ================= 登录 ================= */

function clearSession() {
  state.token = '';
  state.user = null;
  state.analysis = null;
  state.aiConfig = null;
  localStorage.removeItem(TOKEN_KEY);
  /* 换个账号登录时别看到上一个人的聊天记录 */
  try {
    chatState.messages = [];
    chatState.greeted = false;
    chatState.busy = false;
  } catch { /* 页面还没初始化完 */ }
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
  initPet();
  /* 天气走后台，别卡着首页出来 */
  loadWeather();
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
    /* 头像 base64 不塞进离线缓存，太占地方；离线时用默认图标就行 */
    const user = state.user ? { ...state.user } : null;
    if (user?.avatar?.startsWith('data:')) user.avatar = '';

    localStorage.setItem(CACHE_KEY, JSON.stringify({
      records: state.records,
      user,
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

function renderMonthLabel() {
  const el = $('monthLabel');
  if (state.month.d) {
    el.textContent = `${state.month.m}月${state.month.d}日`;
    el.classList.add('day');
  } else {
    el.textContent = `${state.month.y}年${state.month.m}月`;
    el.classList.remove('day');
  }
}

function renderSummary(list) {
  let expense = 0, income = 0;
  for (const r of list) {
    if (r.type === 'income') income += Number(r.amount) || 0;
    else expense += Number(r.amount) || 0;
  }
  const oneDay = Boolean(state.month.d);
  $('sumCap').textContent = oneDay ? `${state.month.m}月${state.month.d}日支出` : '本月支出';
  $('listTitle').textContent = oneDay ? `${state.month.m}月${state.month.d}日的账` : '这个月的账';
  $('backToMonth').hidden = !oneDay;
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
      <b>${state.month.d ? '这天还没记账' : '这个月还没有记账'}</b>点右下角的 + 记一笔
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

function dayKey() {
  return `${state.month.y}-${pad2(state.month.m)}-${pad2(state.month.d || 1)}`;
}

/* 整月的账；选中某天时只看那一天 */
function monthRecords() {
  const all = state.records.filter((r) => String(r.date).startsWith(monthKey()));
  return state.month.d ? all.filter((r) => String(r.date) === dayKey()) : all;
}

function renderSettings() {
  $('userName').textContent = displayName();

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
  $('petToggle').setAttribute('aria-checked', String(pet.on));
  renderInstallHint();
}

/* 安卓和 iPhone 的安装路径完全不一样，别让用户照着错的那句找按钮 */
function renderInstallHint() {
  const el = $('installHint');
  if (!el) return;
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || navigator.standalone === true;
  if (standalone) {
    el.textContent = '已经从桌面图标打开了，不用再装。';
    return;
  }
  if (!$('installBtn').hidden) {
    el.textContent = '点下面这个按钮直接装；找不到的话，用浏览器菜单里的「安装应用」。';
    return;
  }
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  el.textContent = isIOS
    ? 'Safari 里点底部「分享」→「添加到主屏幕」，桌面上就有图标了。'
    : 'Chrome 里点右上角 ⋮ →「安装应用」，桌面上就有图标了。';
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
  /* 统计页永远按整月算，选中某天也不缩水 */
  renderStats(state.records.filter((r) => String(r.date).startsWith(monthKey())));
  renderAnalysis();
  renderSettings();
  renderAvatar();
}

/* ================= 视图切换 ================= */

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('fabAdd').hidden = view === 'settings';
  /* 我的页面不按月看，把月份切换收起来 */
  document.querySelector('.month-switch').hidden = view === 'settings';
  syncPetVisible();
  window.scrollTo({ top: 0 });
}

/* ================= 记账面板 ================= */

function openSheet(type = 'expense') {
  state.draft = {
    type,
    amount: '0',
    category: CATS[type][0][0],
    note: '',
    /* 正在看某一天时，记一笔默认就记到那天 */
    date: state.month.d ? dayKey() : todayStr(),
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
    setPetMood('cheer', 1500);
    notifyHappy(`记好啦，${rec.type === 'income' ? '收入' : '花了'} ¥${money(rec.amount)}`);
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
    setPetMood('cheer', 1500);
    notifyHappy(list.length === 1
      ? `记好啦，${first.category} ¥${money(first.amount)}`
      : `一下记了 ${list.length} 笔～`);
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
  setPetMood('think', 15000);
  try {
    const data = await api('/api/ai/analyze', { method: 'POST', body: { month: monthKey() } });
    state.analysis = data;
    setPetMood('happy', 2200);
  } catch (err) {
    toast(err.message);
    setPetMood('idle', 10);
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

/* ================= 桌宠 ================= */

const PET_KEY = 'ledger.pet.v1';
const PET_FRAMES = {
  idle: 'loopy/01-smile.webp',
  blink: 'loopy/blink.webp',
  happy: 'loopy/happy.webp',
  think: 'loopy/08-study.webp',
  cheer: 'loopy/06-music.webp',
  coin: 'loopy/09-gift.webp',
};

const pet = {
  on: true,
  frame: 'idle',
  mood: '',
  left: null,
  bottom: null,
  blinkTimer: 0,
  moodTimer: 0,
  sayTimer: 0,
  idleTimer: 0,
};

function loadPetPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PET_KEY) || '{}');
    if (typeof saved.on === 'boolean') pet.on = saved.on;
    if (Number.isFinite(saved.left)) pet.left = saved.left;
    if (Number.isFinite(saved.bottom)) pet.bottom = saved.bottom;
  } catch { /* 配置坏了就用默认 */ }
}

function savePetPrefs() {
  try {
    localStorage.setItem(PET_KEY, JSON.stringify({ on: pet.on, left: pet.left, bottom: pet.bottom }));
  } catch { /* 存不下就算了 */ }
}

function petEl() { return $('pet'); }

function petBottomLimit() {
  const bar = document.querySelector('.tabbar');
  return (bar?.offsetHeight || 62) + 6 + (window.visualViewport?.offsetTop || 0);
}

function clampPet(left, bottom) {
  const el = petEl();
  const w = el.offsetWidth || 88;
  const h = el.offsetHeight || 88;
  return {
    left: Math.min(Math.max(left, 4), Math.max(4, window.innerWidth - w - 4)),
    bottom: Math.min(Math.max(bottom, petBottomLimit()), Math.max(80, window.innerHeight - h - 10)),
  };
}

function applyPetRect(left, bottom) {
  const el = petEl();
  const pos = clampPet(left, bottom);
  pet.left = Math.round(pos.left);
  pet.bottom = Math.round(pos.bottom);
  el.style.left = `${pet.left}px`;
  el.style.bottom = `${pet.bottom}px`;
  el.classList.toggle('bubble-right', pet.left + el.offsetWidth / 2 > window.innerWidth / 2);
}

function syncPetVisible() {
  const el = petEl();
  if (!el) return;
  el.hidden = false;
  el.classList.toggle('gone', !pet.on || chatState.open || state.view === 'settings');
}

function applyPetVisibility() {
  const el = petEl();
  if (!el) return;
  el.hidden = false;
  syncPetVisible();
  if (pet.on) applyPetRect(pet.left ?? 12, pet.bottom ?? (petBottomLimit() + 8));
  $('petToggle').setAttribute('aria-checked', String(pet.on));
}

function petFrame(name) {
  if (pet.frame === name) return;
  pet.frame = name;
  $('petImg').src = PET_FRAMES[name] || PET_FRAMES.idle;
}

function setPetMood(name, ms = 1700) {
  clearTimeout(pet.moodTimer);
  pet.mood = name;
  petFrame(name);
  pet.moodTimer = setTimeout(() => {
    pet.mood = '';
    petFrame('idle');
  }, ms);
}

function petSay(text, ms = 4400) {
  if (!pet.on || chatState.open || !text) return;
  const el = $('petBubble');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(pet.sayTimer);
  pet.sayTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function petAnim(cls) {
  const el = petEl();
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 800);
}

function petHop() { if (pet.on) petAnim('hop'); }

function scheduleBlink() {
  clearTimeout(pet.blinkTimer);
  pet.blinkTimer = setTimeout(() => {
    if (pet.on && !pet.mood && !chatState.open && !document.hidden) {
      petFrame('blink');
      setTimeout(() => {
        if (!pet.mood && pet.frame === 'blink') petFrame('idle');
      }, 135);
    }
    scheduleBlink();
  }, 2200 + Math.random() * 3600);
}

/* 闲着的时候偶尔蹦一下、扭一下，看着像活的 */
function scheduleIdleAction() {
  clearTimeout(pet.idleTimer);
  pet.idleTimer = setTimeout(() => {
    if (pet.on && !pet.mood && !chatState.open && !document.hidden) {
      if (Math.random() < 0.55) petHop();
      else petAnim('wiggle');
    }
    scheduleIdleAction();
  }, 7000 + Math.random() * 8000);
}

/* 一天只打一次招呼，别烦人 */
function petGreet() {
  if (!pet.on) return;
  const key = 'ledger.pet.hello';
  if (localStorage.getItem(key) === todayStr()) return;
  localStorage.setItem(key, todayStr());

  let line;
  if (!state.ai?.enabled) {
    line = 'AI 还没接上，先去「我的」';
  } else {
    const today = state.records.filter((r) => r.date === todayStr());
    const list = monthRecords().filter((r) => r.type !== 'income');
    const total = list.reduce((s, r) => s + Number(r.amount), 0);
    if (!today.length) line = '今天还没记呢，点我说一句';
    else if (total > 0 && total > 3000) line = '这月花得有点猛，要看看吗';
    else line = '我在～点我看账';
  }

  setTimeout(() => {
    petSay(line, 3800);
    petAnim('wiggle');
  }, 1300);
}

function initPet() {
  loadPetPrefs();
  Object.values(PET_FRAMES).forEach((src) => { const im = new Image(); im.src = src; });
  applyPetVisibility();
  scheduleBlink();
  scheduleIdleAction();
  petGreet();
}

/* 拖动换位置，轻点一下就是聊天 */
let petDrag = null;

function bindPet() {
  const btn = $('petBtn');

  btn.addEventListener('pointerdown', (e) => {
    if (!pet.on || e.button !== 0) return;
    const rect = petEl().getBoundingClientRect();
    petDrag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: rect.left,
      bottom: window.innerHeight - rect.bottom,
      moved: false,
    };
    petEl().classList.add('dragging');
    try { btn.setPointerCapture(e.pointerId); } catch { /* 某些浏览器不支持 */ }
  });

  btn.addEventListener('pointermove', (e) => {
    if (!petDrag || e.pointerId !== petDrag.id) return;
    const dx = e.clientX - petDrag.x;
    const dy = e.clientY - petDrag.y;
    if (!petDrag.moved && Math.hypot(dx, dy) < 7) return;
    petDrag.moved = true;
    $('petBubble').classList.remove('show');
    applyPetRect(petDrag.left + dx, petDrag.bottom - dy);
  });

  const endDrag = (e) => {
    if (!petDrag || (e && e.pointerId !== petDrag.id)) return;
    const moved = petDrag.moved;
    petDrag = null;
    petEl().classList.remove('dragging');
    if (moved) savePetPrefs();
    else openChat();
  };

  btn.addEventListener('pointerup', endDrag);
  btn.addEventListener('pointercancel', () => {
    petDrag = null;
    petEl().classList.remove('dragging');
  });

  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openChat();
    }
  });

  window.addEventListener('resize', () => {
    if (pet.left != null) applyPetRect(pet.left, pet.bottom);
  });

  let scrollTimer = 0;
  window.addEventListener('scroll', () => {
    if (!pet.on) return;
    petEl().classList.add('peek');
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => petEl().classList.remove('peek'), 780);
  }, { passive: true });

  $('petToggle').addEventListener('click', () => {
    pet.on = !pet.on;
    savePetPrefs();
    applyPetVisibility();
    if (!pet.on) {
      $('petBubble').classList.remove('show');
      if (chatState.open) closeChat();
      toast('Loopy 先躲起来了');
    } else {
      toast('Loopy 出来啦');
      petAnim('wiggle');
    }
  });
}

/* ================= 和 Loopy 聊天 ================= */

const chatState = { open: false, messages: [], busy: false, greeted: false };

const CHAT_CHIPS = ['这个月花了多少', '哪类花得最多', '帮我记：午饭 28', '怎么省一点'];

function chatMsgHtml(m) {
  if (m.role === 'me') {
    return `<div class="msg me"><div class="msg-bubble">${escapeHtml(m.content)}</div></div>`;
  }
  return `<div class="msg">
    <img class="msg-ava" src="loopy/avatar.webp" alt="">
    <div class="msg-bubble">${escapeHtml(m.content)}${m.note ? `<div class="msg-note">${escapeHtml(m.note)}</div>` : ''}</div>
  </div>`;
}

function renderChat() {
  const body = $('chatBody');
  const typing = chatState.busy
    ? `<div class="msg typing"><img class="msg-ava" src="loopy/avatar.webp" alt=""><div class="msg-bubble"><i></i><i></i><i></i></div></div>`
    : '';
  body.innerHTML = chatState.messages.map(chatMsgHtml).join('') + typing;
  body.scrollTop = body.scrollHeight;
}

function renderChatChips() {
  if (!state.ai?.enabled) {
    $('chatChips').innerHTML = '<button class="chip" type="button" data-go="settings">去配置 AI</button>';
    return;
  }
  $('chatChips').innerHTML = CHAT_CHIPS
    .map((t) => `<button class="chip" type="button" data-q="${escapeHtml(t)}">${escapeHtml(t)}</button>`)
    .join('');
}

function openChat() {
  if (chatState.open) return;
  chatState.open = true;
  $('petBubble').classList.remove('show');
  syncPetVisible();

  $('chatSheet').classList.add('open');
  $('chatSheet').setAttribute('aria-hidden', 'false');
  $('chatMask').classList.add('show');

  if (!chatState.greeted) {
    chatState.greeted = true;
    if (!state.ai?.enabled) {
      chatState.messages.push({
        role: 'loopy',
        content: '我的 AI 还没接上呢。去「我的 → AI 记账」填一个接口，我就能陪你看账、帮你记账了。',
      });
      $('chatStatus').textContent = '还没接上 AI';
    } else {
      chatState.messages.push({
        role: 'loopy',
        content: '我在～账本的事都能问我，也可以说「午饭 28」让我直接记上。',
      });
      $('chatStatus').textContent = '问我账本的事，也可以让我记一笔';
    }
  }

  renderChatChips();
  $('chatChips').hidden = false;

  const ready = Boolean(state.ai?.enabled);
  $('chatInput').disabled = !ready;
  $('chatSend').disabled = !ready;
  $('chatInput').placeholder = ready ? '跟 Loopy 说点什么…' : '先接上 AI 才能聊天';

  renderChat();
}

function closeChat() {
  if (!chatState.open) return;
  chatState.open = false;
  $('chatSheet').classList.remove('open');
  $('chatSheet').setAttribute('aria-hidden', 'true');
  $('chatMask').classList.remove('show');
  $('chatInput').blur();
  syncPetVisible();
}

async function sendChat(text) {
  const content = String(text || '').trim();
  if (!content || chatState.busy) return;

  if (!state.ai?.enabled) {
    chatState.messages.push({ role: 'loopy', content: '得先接上 AI 才能聊。点下面的「去配置」，一分钟就能弄好。' });
    renderChat();
    return;
  }

  chatState.messages.push({ role: 'me', content });
  $('chatInput').value = '';
  chatState.busy = true;
  renderChat();
  $('chatSend').disabled = true;

  const history = chatState.messages
    .filter((m) => m.role === 'me' || m.role === 'loopy')
    .map((m) => ({ role: m.role === 'me' ? 'user' : 'assistant', content: m.content }))
    .slice(-10);

  try {
    const data = await api('/api/ai/chat', {
      method: 'POST',
      body: { month: monthKey(), today: todayStr(), messages: history },
    });

    let note = '';
    if (data.records?.length) {
      note = `已记账：${data.records.map((r) => `${r.category} ¥${money(r.amount)}`).join('、')}`;
      state.records.unshift(...data.records);
      writeCache();
      renderAll();
    }

    chatState.messages.push({ role: 'loopy', content: data.reply || '嗯…我没想好说什么', note });
  } catch (err) {
    chatState.messages.push({ role: 'loopy', content: err.message || '我这会儿有点糊涂，再说一次？' });
  } finally {
    chatState.busy = false;
    renderChat();
    $('chatSend').disabled = false;
    $('chatInput').focus();
  }
}

function bindChat() {
  $('chatMask').addEventListener('click', closeChat);
  $('chatClose').addEventListener('click', closeChat);

  /* 键盘弹起来时把面板顶上去，别把输入框盖住 */
  if (window.visualViewport) {
    const syncKeyboardInset = () => {
      const vv = window.visualViewport;
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb', `${Math.round(kb)}px`);
      if (chatState.open) {
        const body = $('chatBody');
        body.scrollTop = body.scrollHeight;
      }
    };
    window.visualViewport.addEventListener('resize', syncKeyboardInset);
    window.visualViewport.addEventListener('scroll', syncKeyboardInset);
  }

  $('chatInput').addEventListener('focus', () => {
    setTimeout(() => {
      const body = $('chatBody');
      body.scrollTop = body.scrollHeight;
    }, 300);
  });

  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat($('chatInput').value);
  });

  $('chatChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.go) {
      closeChat();
      switchView(chip.dataset.go);
      return;
    }
    sendChat(chip.dataset.q);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && chatState.open) closeChat();
  });
}

/* ================= 选日期 ================= */

/* 面板里正在翻的年月，和页面当前看的月份分开，取消时不串 */
const calView = { y: 0, m: 0 };

function showPanel(panelId, maskId) {
  const panel = $(panelId);
  const mask = $(maskId);
  mask.hidden = false;
  panel.hidden = false;
  requestAnimationFrame(() => {
    mask.classList.add('show');
    panel.classList.add('show');
  });
}

function hidePanel(panelId, maskId) {
  const panel = $(panelId);
  const mask = $(maskId);
  panel.classList.remove('show');
  mask.classList.remove('show');
  setTimeout(() => {
    if (!panel.classList.contains('show')) panel.hidden = true;
    if (!mask.classList.contains('show')) mask.hidden = true;
  }, 300);
}

function openDatePanel() {
  calView.y = state.month.y;
  calView.m = state.month.m;
  renderDatePanel();
  showPanel('datePanel', 'dateMask');
}

function renderDatePanel() {
  $('calYear').textContent = String(calView.y);

  /* 有账的月份标个小点，一眼能看出哪几个月记过 */
  const monthHits = new Set();
  const dayHits = new Set();
  for (const r of state.records) {
    const s = String(r.date || '');
    if (!s.startsWith(`${calView.y}-`)) continue;
    const m = Number(s.slice(5, 7));
    monthHits.add(m);
    if (m === calView.m) dayHits.add(Number(s.slice(8, 10)));
  }

  $('monthGrid').innerHTML = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const cls = `month-cell${m === calView.m ? ' on' : ''}`;
    const dot = monthHits.has(m) ? '<i class="dot"></i>' : '';
    return `<button class="${cls}" type="button" data-m="${m}">${m}月${dot}</button>`;
  }).join('');

  const firstDay = new Date(calView.y, calView.m - 1, 1).getDay();
  const lead = (firstDay + 6) % 7;              /* 周一开头 */
  const days = new Date(calView.y, calView.m, 0).getDate();
  const prevDays = new Date(calView.y, calView.m - 1, 0).getDate();
  const today = todayStr();

  const cells = [];
  for (let i = lead - 1; i >= 0; i--) {
    cells.push(`<span class="cal-cell out">${prevDays - i}</span>`);
  }
  for (let d = 1; d <= days; d++) {
    const key = `${calView.y}-${pad2(calView.m)}-${pad2(d)}`;
    const cls = ['cal-cell'];
    if (key === today) cls.push('today');
    if (state.month.d && state.month.y === calView.y && state.month.m === calView.m && state.month.d === d) {
      cls.push('on');
    }
    const dot = dayHits.has(d) ? '<i class="dot"></i>' : '';
    cells.push(`<button class="${cls.join(' ')}" type="button" data-d="${d}">${d}${dot}</button>`);
  }
  const tail = (7 - (cells.length % 7)) % 7;
  for (let i = 1; i <= tail; i++) cells.push(`<span class="cal-cell out">${i}</span>`);

  $('calGrid').innerHTML = cells.join('');
}

function applyCalPick(day) {
  state.month = { y: calView.y, m: calView.m, d: day };
  state.analysis = null;
  hidePanel('datePanel', 'dateMask');
  if (state.view !== 'home') switchView('home');
  renderAll();
}

function pickToday() {
  const d = new Date();
  calView.y = d.getFullYear();
  calView.m = d.getMonth() + 1;
  applyCalPick(d.getDate());
}

/* ================= 天气 ================= */

const WEATHER_CITY_KEY = 'ledger.weather.city';
const weather = { data: null, loading: false, failed: false };

function weatherEmoji(text) {
  const t = String(text || '');
  if (/雷/.test(t)) return '⛈️';
  if (/雪/.test(t)) return '❄️';
  if (/雨/.test(t)) return '🌧️';
  if (/雾|霾|沙|尘/.test(t)) return '🌫️';
  if (/阴/.test(t)) return '☁️';
  if (/多云/.test(t)) return '⛅';
  if (/晴/.test(t)) return '☀️';
  return '🌤️';
}

function aqiLabel(aqi) {
  if (!Number.isFinite(aqi)) return '—';
  if (aqi <= 50) return `${aqi} 优`;
  if (aqi <= 100) return `${aqi} 良`;
  if (aqi <= 150) return `${aqi} 轻度污染`;
  if (aqi <= 200) return `${aqi} 中度污染`;
  if (aqi <= 300) return `${aqi} 重度污染`;
  return `${aqi} 严重污染`;
}

function renderWeather() {
  const pill = $('weatherPill');
  const d = weather.data;

  if (!d) {
    pill.hidden = false;
    $('weatherEmoji').textContent = '🌡️';
    $('weatherTemp').textContent = weather.failed ? '—' : '…';
    $('weatherCity').textContent = '天气';
    pill.classList.toggle('stale', weather.failed);
    return;
  }

  pill.hidden = false;
  pill.classList.remove('stale');
  $('weatherEmoji').textContent = weatherEmoji(d.text);
  $('weatherTemp').textContent = `${d.temp}°`;
  $('weatherCity').textContent = d.city || '';

  $('wxEmoji').textContent = weatherEmoji(d.text);
  $('wxTemp').textContent = String(d.temp);
  $('wxText').textContent = d.text || '—';
  $('wxCity').textContent = d.city || '—';
  $('wxWind').textContent = d.wind || '—';
  $('wxHumid').textContent = d.humidity || '—';
  $('wxAqi').textContent = aqiLabel(d.aqi);
  $('wxTime').textContent = d.observedAt ? `今天 ${d.observedAt}` : '—';
}

async function loadWeather(force = false) {
  if (weather.loading || state.offline) return;
  if (!force && weather.data) return;
  weather.loading = true;
  if (!weather.data) {
    $('weatherPill').hidden = false;
    $('weatherTemp').textContent = '…';
    $('weatherCity').textContent = '天气';
  }

  try {
    const saved = localStorage.getItem(WEATHER_CITY_KEY) || '';
    const data = await api(`/api/weather${saved ? `?city=${encodeURIComponent(saved)}` : ''}`);
    if (data?.ok) {
      weather.data = data;
      weather.failed = false;
    } else {
      weather.data = null;
      weather.failed = true;
    }
  } catch {
    weather.failed = true;
  } finally {
    weather.loading = false;
    renderWeather();
  }
}

function openWeatherPanel() {
  if (weather.failed && !weather.loading) loadWeather(true);
  $('wxHint').textContent = weather.data
    ? '数据来自中国天气网，每十分钟更新一次'
    : '查不到天气时，可以手动选一个城市';
  $('wxCityInput').value = localStorage.getItem(WEATHER_CITY_KEY) || '';
  showPanel('weatherPanel', 'weatherMask');
}

function saveWeatherCity() {
  const city = $('wxCityInput').value.trim();
  if (!city) return;
  localStorage.setItem(WEATHER_CITY_KEY, city);
  weather.data = null;
  hidePanel('weatherPanel', 'weatherMask');
  loadWeather(true);
}

/* ================= 昵称与头像 ================= */

const AVATAR_PICKS = [
  '01-smile', '02-eat', '03-car', '04-bag', '05-home',
  '06-music', '07-flower', '08-study', '09-gift',
];

const profile = { avatar: '' };

function displayName() {
  return state.user?.nickname || state.user?.username || '我';
}

function avatarSrc() {
  return state.user?.avatar || 'loopy/avatar.webp';
}

function renderAvatar() {
  const src = avatarSrc();
  $('userAvatar').src = src;
  $('topFace').src = src;
}

function renderAvatarPicks() {
  const current = profile.avatar;
  const custom = current && current.startsWith('data:') ? ' on' : '';
  const items = AVATAR_PICKS.map((name) => {
    const src = `loopy/${name}.webp`;
    const on = current === src ? ' on' : '';
    return `<button type="button" data-src="${src}" aria-label="用这个头像">
      <img src="${src}" alt="">
    </button>`;
  });
  items.push(`<button type="button" class="pick-photo${custom}" id="pickPhoto" aria-label="用相册里的照片">
    <img src="${current.startsWith('data:') ? current : 'loopy/avatar.webp'}" alt="">
  </button>`);
  $('avatarPicks').innerHTML = items.join('');
}

function openProfilePanel() {
  profile.avatar = state.user?.avatar || '';
  $('profileNick').value = state.user?.nickname || '';
  $('profilePreview').src = avatarSrc();
  $('profileMsg').hidden = true;
  renderAvatarPicks();
  showPanel('profilePanel', 'profileMask');
}

/* 上传的图先裁成正方形再压到 256px，JPEG 一般十几 KB */
function usePhoto(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { toast('要选一张图片'); return; }

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const side = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    profile.avatar = dataUrl;
    $('profilePreview').src = dataUrl;
    renderAvatarPicks();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast('这张图片读不出来');
  };
  img.src = url;
}

async function saveProfile() {
  const btn = $('profileSave');
  const nickname = $('profileNick').value.trim();
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const data = await api('/api/me', {
      method: 'PATCH',
      body: { nickname, avatar: profile.avatar },
    });
    state.user = data.user;
    writeCache();
    renderAll();
    hidePanel('profilePanel', 'profileMask');
    toast('改好啦');
  } catch (err) {
    $('profileMsg').textContent = err.message;
    $('profileMsg').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
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
      initPet();
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
    state.month = { y: d.getFullYear(), m: d.getMonth() + 1, d: null };
    state.analysis = null;
    renderAll();
  });
  $('nextMonth').addEventListener('click', () => {
    const d = new Date(state.month.y, state.month.m, 1);
    state.month = { y: d.getFullYear(), m: d.getMonth() + 1, d: null };
    state.analysis = null;
    renderAll();
  });

  /* ---- 选日期 ---- */
  $('monthLabel').addEventListener('click', openDatePanel);
  $('dateMask').addEventListener('click', () => hidePanel('datePanel', 'dateMask'));
  $('dateClose').addEventListener('click', () => hidePanel('datePanel', 'dateMask'));
  $('yearPrev').addEventListener('click', () => { calView.y -= 1; renderDatePanel(); });
  $('yearNext').addEventListener('click', () => { calView.y += 1; renderDatePanel(); });
  $('monthGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.month-cell');
    if (!btn) return;
    calView.m = Number(btn.dataset.m);
    renderDatePanel();
  });
  $('calGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.cal-cell[data-d]');
    if (btn) applyCalPick(Number(btn.dataset.d));
  });
  $('calToday').addEventListener('click', pickToday);
  $('calWholeMonth').addEventListener('click', () => applyCalPick(null));
  $('backToMonth').addEventListener('click', () => {
    calView.y = state.month.y;
    calView.m = state.month.m;
    applyCalPick(null);
  });

  /* ---- 天气 ---- */
  $('weatherPill').addEventListener('click', openWeatherPanel);
  $('weatherMask').addEventListener('click', () => hidePanel('weatherPanel', 'weatherMask'));
  $('weatherClose').addEventListener('click', () => hidePanel('weatherPanel', 'weatherMask'));
  $('wxCitySave').addEventListener('click', saveWeatherCity);
  $('wxCityInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveWeatherCity(); }
  });

  /* ---- 昵称与头像 ---- */
  $('editProfileBtn').addEventListener('click', openProfilePanel);
  $('userAvatarBtn').addEventListener('click', openProfilePanel);
  $('profileMask').addEventListener('click', () => hidePanel('profilePanel', 'profileMask'));
  $('profileClose').addEventListener('click', () => hidePanel('profilePanel', 'profileMask'));
  $('avatarUploadBtn').addEventListener('click', () => $('avatarFile').click());
  $('avatarPicks').addEventListener('click', (e) => {
    if (e.target.closest('#pickPhoto')) { $('avatarFile').click(); return; }
    const btn = e.target.closest('button[data-src]');
    if (!btn) return;
    profile.avatar = btn.dataset.src;
    $('profilePreview').src = profile.avatar;
    renderAvatarPicks();
  });
  $('avatarFile').addEventListener('change', (e) => {
    usePhoto(e.target.files?.[0]);
    e.target.value = '';
  });
  $('profileSave').addEventListener('click', saveProfile);

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
  $('chatOpenBtn').addEventListener('click', openChat);
  bindPet();
  bindChat();

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
    renderInstallHint();
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
