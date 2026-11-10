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
import { parseRecords, aiEnabled, aiInfo, EXPENSE_CATS, INCOME_CATS } from './ai.js';

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
  res.json({ user: publicUser(req.user), aiEnabled: aiEnabled() });
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

    const drafts = await parseRecords(text, `用户时区偏移 ${-new Date().getTimezoneOffset()} 分钟。`);
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
