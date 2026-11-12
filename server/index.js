import './env.js';
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { store } from './store.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  userFromToken, publicUser,
} from './auth.js';
import {
  parseRecords, analyzeMonth, chatWithLoopy, testAiConfig,
  aiEnabled, aiInfo, aiStatusFor, configFor, EXPENSE_CATS, INCOME_CATS,
} from './ai.js';
import { encryptSecret, decryptSecret, maskSecret } from './secret.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8080);
/* 默认只监听本机，由 nginx 反代对外；确实需要直连时把 HOST 设成 0.0.0.0 */
const HOST = process.env.HOST || '127.0.0.1';
const REGISTER_CODE = process.env.REGISTER_CODE || '';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const fail = (status, message) => Object.assign(new Error(message), { status });

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const user = userFromToken(token);
  if (!user) return res.status(401).json({ error: '登录已失效，请重新登录' });
  req.user = user;
  req.token = token;
  next();
}

/* ---------- 登录限流：同一 IP 10 分钟内最多 10 次失败 ---------- */
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const item = attempts.get(ip);
  if (!item || now - item.first > 10 * 60 * 1000) {
    attempts.set(ip, { count: 0, first: now });
    return false;
  }
  return item.count >= 10;
}
function noteFailure(ip) {
  const now = Date.now();
  const item = attempts.get(ip);
  if (!item || now - item.first > 10 * 60 * 1000) {
    attempts.set(ip, { count: 1, first: now });
  } else {
    item.count += 1;
  }
}
function clearFailures(ip) {
  attempts.delete(ip);
}

/* ---------- 用户 ---------- */
app.post('/api/auth/register', (req, res) => {
  const ip = req.ip || 'unknown';
  if (tooManyAttempts(ip)) return res.status(429).json({ error: '尝试太频繁，请稍后再试' });

  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const code = String(req.body?.code || '');

  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(username)) {
    return res.status(400).json({ error: '用户名需 2-20 位，仅限中英文、数字、下划线' });
  }
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (REGISTER_CODE && code !== REGISTER_CODE) {
    noteFailure(ip);
    return res.status(403).json({ error: '注册码不正确' });
  }
  if (store.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: '这个用户名已经存在了' });
  }

  const user = {
    id: crypto.randomUUID(),
    username,
    password: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  store.users.push(user);
  store.save();
  clearFailures(ip);

  const token = createSession(user.id);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (tooManyAttempts(ip)) return res.status(429).json({ error: '尝试太频繁，请 10 分钟后再试' });

  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const user = store.users.find((u) => u.username.toLowerCase() === username.toLowerCase());

  if (!user || !verifyPassword(password, user.password)) {
    noteFailure(ip);
    return res.status(401).json({ error: '用户名或密码不对' });
  }

  clearFailures(ip);
  const token = createSession(user.id);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/logout', auth, (req, res) => {
  destroySession(req.token);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const ai = aiStatusFor(req.user);
  res.json({ user: publicUser(req.user), aiEnabled: ai.enabled, ai });
});

/* ---------- 账目 ---------- */
function sanitizeRecord(input) {
  const type = input?.type === 'income' ? 'income' : 'expense';
  const allowed = type === 'income' ? INCOME_CATS : EXPENSE_CATS;
  const amount = Math.round(Number(input?.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw fail(400, '金额必须大于 0');
  if (amount > 100000000) throw fail(400, '金额太大了');

  const category = allowed.includes(input?.category) ? input.category : allowed[allowed.length - 1];
  const note = String(input?.note || '').trim().slice(0, 40);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input?.date)) ? input.date : new Date().toISOString().slice(0, 10);

  return { type, amount, category, note, date };
}

app.get('/api/records', auth, (req, res) => {
  const list = store.records
    .filter((r) => r.userId === req.user.id)
    .sort((a, b) => (a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date)));
  res.json({ records: list });
});

app.post('/api/records', auth, (req, res, next) => {
  try {
    const base = sanitizeRecord(req.body);
    const record = {
      id: crypto.randomUUID(),
      userId: req.user.id,
      ...base,
      createdAt: new Date().toISOString(),
    };
    store.records.push(record);
    store.save();
    res.json({ record });
  } catch (e) { next(e); }
});

app.delete('/api/records/:id', auth, (req, res) => {
  const i = store.records.findIndex((r) => r.id === req.params.id && r.userId === req.user.id);
  if (i < 0) return res.status(404).json({ error: '记录不存在' });
  store.records.splice(i, 1);
  store.save();
  res.json({ ok: true });
});

/* ---------- AI 记账 ---------- */
app.post('/api/ai', auth, async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) throw fail(400, '说点什么吧');
    if (text.length > 200) throw fail(400, '太长啦，一句一句来');

    const drafts = await parseRecords(text, `用户时区偏移 ${-new Date().getTimezoneOffset()} 分钟。`, req.user);
    const created = drafts.map((d) => {
      const record = {
        id: crypto.randomUUID(),
        userId: req.user.id,
        ...sanitizeRecord(d),
        createdAt: new Date().toISOString(),
      };
      store.records.push(record);
      return record;
    });
    if (created.length) store.save();
    res.json({ records: created, drafts });
  } catch (e) { next(e); }
});

/* ---------- 每人自己的 AI 接口 ---------- */
app.get('/api/ai/config', auth, (req, res) => {
  const status = aiStatusFor(req.user);
  const saved = req.user.aiConfig;
  const key = saved?.key ? decryptSecret(saved.key) : '';
  const fallback = configFor(null);
  res.json({
    serverDefault: aiEnabled(),
    enabled: status.enabled,
    source: status.source,
    model: status.model,
    /* 只给地址和模型名当占位参考，不含任何 Key */
    suggest: { base: fallback.base, model: fallback.model },
    custom: key ? { base: saved.base, model: saved.model, hint: maskSecret(key) } : null,
  });
});

app.put('/api/ai/config', auth, (req, res) => {
  const base = String(req.body?.base || '').trim().replace(/\/+$/, '');
  const model = String(req.body?.model || '').trim();
  const key = String(req.body?.key || '').trim();

  if (!/^https?:\/\/\S+$/i.test(base)) return res.status(400).json({ error: '接口地址要以 http:// 或 https:// 开头' });
  if (base.length > 300) return res.status(400).json({ error: '接口地址太长了' });
  if (!model) return res.status(400).json({ error: '填一下模型名字' });
  if (model.length > 80) return res.status(400).json({ error: '模型名太长了' });
  if (key.length < 8) return res.status(400).json({ error: 'Key 看起来太短，检查一下' });
  if (key.length > 300) return res.status(400).json({ error: 'Key 太长了' });

  req.user.aiConfig = { base, model, key: encryptSecret(key), updatedAt: new Date().toISOString() };
  store.save();
  res.json({ ok: true, ai: aiStatusFor(req.user) });
});

app.delete('/api/ai/config', auth, (req, res) => {
  delete req.user.aiConfig;
  store.save();
  res.json({ ok: true, ai: aiStatusFor(req.user) });
});

app.post('/api/ai/config/test', auth, async (req, res, next) => {
  try {
    const saved = req.user.aiConfig;
    const key = String(req.body?.key || '').trim() || (saved?.key ? decryptSecret(saved.key) : '');
    const base = String(req.body?.base || '').trim() || saved?.base || '';
    const model = String(req.body?.model || '').trim() || saved?.model || '';
    if (!key) throw fail(400, '先填 Key');
    const result = await testAiConfig({ base, key, model });
    res.json(result);
  } catch (e) { next(e); }
});

/* ---------- AI 月度分析 ---------- */
function buildMonthSummary(userId, month) {
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const prevDate = new Date(y, m - 2, 1);
  const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

  const list = store.records.filter((r) => r.userId === userId && String(r.date).startsWith(month));
  const expenseList = list.filter((r) => r.type !== 'income');
  const sum = (arr) => arr.reduce((s, r) => s + Number(r.amount || 0), 0);
  const expense = sum(expenseList);
  const income = sum(list.filter((r) => r.type === 'income'));

  const byCat = new Map();
  for (const r of expenseList) byCat.set(r.category, (byCat.get(r.category) || 0) + Number(r.amount || 0));
  const cats = [...byCat.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, amount]) => ({ name, amount, share: expense ? (amount / expense) * 100 : 0 }));

  const top = [...expenseList]
    .sort((a, b) => Number(b.amount) - Number(a.amount))
    .slice(0, 3)
    .map((r) => ({ category: r.category, amount: Number(r.amount), note: r.note || '' }));

  const prevExpense = sum(store.records.filter(
    (r) => r.userId === userId && r.type !== 'income' && String(r.date).startsWith(prevMonth),
  ));

  const now = new Date();
  const isCurrent = now.getFullYear() === y && now.getMonth() + 1 === m;
  const elapsed = isCurrent ? Math.max(1, now.getDate()) : daysInMonth;

  return {
    month,
    expense,
    income,
    count: list.length,
    expenseCount: expenseList.length,
    activeDays: new Set(expenseList.map((r) => r.date)).size,
    days: elapsed,
    avg: expense / elapsed,
    cats,
    top,
    prevExpense,
  };
}

app.post('/api/ai/analyze', auth, async (req, res, next) => {
  try {
    const raw = String(req.body?.month || '');
    const month = /^\d{4}-\d{2}$/.test(raw) ? raw : new Date().toISOString().slice(0, 7);
    const summary = buildMonthSummary(req.user.id, month);

    if (!summary.count) {
      return res.json({ ok: true, empty: true, month, message: '这个月还没有账，先记两笔我再看。' });
    }

    const result = await analyzeMonth(summary, req.user);
    res.json({
      ok: true,
      month,
      ...result,
      stats: {
        expense: summary.expense,
        income: summary.income,
        count: summary.count,
        avg: summary.avg,
      },
    });
  } catch (e) { next(e); }
});

/* ---------- 桌宠聊天 ---------- */
const chatHits = new Map();
function chatRateLimited(userId) {
  const now = Date.now();
  const recent = (chatHits.get(userId) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 60) {
    chatHits.set(userId, recent);
    return true;
  }
  recent.push(now);
  chatHits.set(userId, recent);
  return false;
}

/* 聊天只带统计和最近几笔，不把整本流水都发出去 */
function buildChatContext(userId, summary, today) {
  const lines = [
    `正在看的月份：${summary.month}`,
    `本月支出 ${summary.expense.toFixed(2)} 元，收入 ${summary.income.toFixed(2)} 元，共 ${summary.count} 笔`,
    `有支出的天数 ${summary.activeDays} 天，日均支出 ${summary.avg.toFixed(2)} 元`,
  ];

  if (summary.cats.length) {
    lines.push(`支出分类：${summary.cats.map((c) => `${c.name} ${c.amount.toFixed(0)}元(${c.share.toFixed(0)}%)`).join('、')}`);
  }
  if (summary.top.length) {
    lines.push(`最大的几笔：${summary.top.map((r) => `${r.category} ${r.amount.toFixed(0)}元${r.note ? `(${r.note})` : ''}`).join('、')}`);
  }
  if (summary.prevExpense > 0) {
    const diff = ((summary.expense - summary.prevExpense) / summary.prevExpense) * 100;
    lines.push(`上月支出 ${summary.prevExpense.toFixed(2)} 元，本月${diff >= 0 ? '多了' : '少了'} ${Math.abs(diff).toFixed(0)}%`);
  } else {
    lines.push('上月没有支出记录，没法比较');
  }

  const fmt = (r) => `${r.type === 'income' ? '收入' : '支出'} ${r.category} ${Number(r.amount).toFixed(2)}元${r.note ? `(${r.note})` : ''}`;
  const todayList = store.records.filter((r) => r.userId === userId && r.date === today);
  lines.push(todayList.length
    ? `今天（${today}）：${todayList.map(fmt).join('；')}`
    : `今天（${today}）还没有记账`);

  const recent = store.records
    .filter((r) => r.userId === userId)
    .sort((a, b) => (a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date)))
    .slice(0, 12);
  if (recent.length) lines.push(`最近 12 笔：${recent.map((r) => `${r.date} ${fmt(r)}`).join('；')}`);

  return lines.join('\n');
}

app.post('/api/ai/chat', auth, async (req, res, next) => {
  try {
    if (!aiStatusFor(req.user).enabled) {
      throw fail(503, '还没接上 AI，去「我的 → AI 记账」填一个接口');
    }

    const messages = (Array.isArray(req.body?.messages) ? req.body.messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 400) }))
      .filter((m) => m.content);

    if (!messages.length || messages[messages.length - 1].role !== 'user') throw fail(400, '说点什么吧');
    if (chatRateLimited(req.user.id)) throw fail(429, '聊得有点快，歇一会儿再说');

    const rawMonth = String(req.body?.month || '');
    const month = /^\d{4}-\d{2}$/.test(rawMonth) ? rawMonth : new Date().toISOString().slice(0, 7);
    const today = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.today))
      ? req.body.today
      : new Date().toISOString().slice(0, 10);

    const summary = buildMonthSummary(req.user.id, month);
    const context = buildChatContext(req.user.id, summary, today);
    const result = await chatWithLoopy({ messages, context, user: req.user, today });

    const created = result.records.map((d) => {
      const record = {
        id: crypto.randomUUID(),
        userId: req.user.id,
        ...sanitizeRecord(d),
        createdAt: new Date().toISOString(),
      };
      store.records.push(record);
      return record;
    });
    if (created.length) store.save();

    res.json({ ok: true, reply: result.reply, records: created });
  } catch (e) { next(e); }
});

/* ---------- 备份 ---------- */
app.get('/api/export', auth, (req, res) => {
  const records = store.records.filter((r) => r.userId === req.user.id);
  res.setHeader('Content-Disposition', `attachment; filename="ledger-${req.user.username}.json"`);
  res.json({
    app: 'ledger-app',
    version: 1,
    username: req.user.username,
    exportedAt: new Date().toISOString(),
    records,
  });
});

app.post('/api/import', auth, (req, res, next) => {
  try {
    const incoming = Array.isArray(req.body?.records) ? req.body.records : [];
    if (!incoming.length) throw fail(400, '备份文件里没有记录');
    if (incoming.length > 20000) throw fail(400, '记录太多了');

    const cleaned = [];
    for (const item of incoming) {
      const base = sanitizeRecord(item);
      cleaned.push({
        id: crypto.randomUUID(),
        userId: req.user.id,
        ...base,
        createdAt: item.createdAt || new Date().toISOString(),
      });
    }

    if (req.body?.replace !== false) {
      for (let i = store.records.length - 1; i >= 0; i--) {
        if (store.records[i].userId === req.user.id) store.records.splice(i, 1);
      }
    }
    store.records.push(...cleaned);
    store.save();
    res.json({ imported: cleaned.length });
  } catch (e) { next(e); }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    aiEnabled: aiEnabled(),
    ai: aiEnabled() ? aiInfo() : null,
    users: store.users.length,
    records: store.records.length,
    icp: (process.env.ICP_BEIAN || '').trim(),
  });
});

/* ---------- 静态资源 ---------- */
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[server]', err);
  res.status(status).json({ error: err.message || '服务器出错了' });
});

app.listen(PORT, HOST, () => {
  console.log(`小账本服务已启动： http://${HOST}:${PORT}`);
  console.log(
    aiEnabled()
      ? `AI 功能：已启用（${aiInfo().model}${aiInfo().thinking === false ? '，已关思考' : ''}）`
      : 'AI 功能：未配置（在 .env 里填 AI_API_KEY 或 QWEN_API_KEY 即可启用）'
  );
  if (!REGISTER_CODE) console.log('提示：未设置 REGISTER_CODE，任何人都能注册账号');
});
