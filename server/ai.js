/*
 * AI 能力：一句话记账 + 月度分析
 *
 * 走 OpenAI 兼容协议，配置来源有两个：
 *   1. 用户自己在「我的 → AI 记账」里填的接口（存在 db 里，密钥加密）
 *   2. 服务器环境变量（所有人的兜底）
 *      AI_API_KEY + AI_BASE_URL + AI_MODEL   —— 通用写法（优先级最高）
 *      QWEN_API_KEY                          —— 通义千问/百炼，默认 qwen3.8-max
 *      DEEPSEEK_API_KEY                      —— 旧配置，继续兼容
 *
 * AI_THINKING=off 可关闭推理模型的长思考（通义默认关闭，记账不需要推理）
 */

import { decryptSecret } from './secret.js';

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DASHSCOPE_MODEL = 'qwen3.8-max';

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

function resolveServerConfig() {
  const generic = (process.env.AI_API_KEY || '').trim();
  const qwen = (process.env.QWEN_API_KEY || '').trim();
  const deepseek = (process.env.DEEPSEEK_API_KEY || '').trim();

  if (generic) {
    return {
      key: generic,
      base: trimSlash(process.env.AI_BASE_URL) || DASHSCOPE_BASE,
      model: (process.env.AI_MODEL || '').trim() || DASHSCOPE_MODEL,
      thinking: process.env.AI_THINKING,
      source: 'server',
    };
  }
  if (qwen) {
    return {
      key: qwen,
      base: trimSlash(process.env.AI_BASE_URL) || DASHSCOPE_BASE,
      model: (process.env.AI_MODEL || '').trim() || DASHSCOPE_MODEL,
      thinking: process.env.AI_THINKING,
      source: 'server',
    };
  }
  if (deepseek) {
    return {
      key: deepseek,
      base: trimSlash(process.env.DEEPSEEK_BASE_URL) || 'https://api.deepseek.com',
      model: (process.env.DEEPSEEK_MODEL || '').trim() || 'deepseek-chat',
      thinking: process.env.AI_THINKING,
      source: 'server',
    };
  }
  return { key: '', base: DASHSCOPE_BASE, model: DASHSCOPE_MODEL, thinking: undefined, source: '' };
}

const serverConfig = resolveServerConfig();

/* 是否支持 enable_thinking 参数（目前只有百炼/通义） */
const supportsThinking = (base) => /dashscope|aliyuncs/.test(String(base || ''));

/* 推理模型默认关思考：记账是结构化抽取，不需要长推理，关掉后延迟约降 4 倍 */
function thinkingEnabled(cfg) {
  const raw = String(cfg.thinking || '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  return !supportsThinking(cfg.base);
}

export const EXPENSE_CATS = ['餐饮', '交通', '购物', '家居', '娱乐', '医疗', '学习', '人情', '其他'];
export const INCOME_CATS = ['工资', '奖金', '理财', '兼职', '红包', '其他'];

/* 用户自己的接口优先，没配就用服务器的 */
export function configFor(user) {
  const custom = user?.aiConfig;
  if (custom?.key) {
    const key = decryptSecret(custom.key);
    if (key) {
      return {
        key,
        base: trimSlash(custom.base) || DASHSCOPE_BASE,
        model: String(custom.model || '').trim() || DASHSCOPE_MODEL,
        thinking: custom.thinking,
        source: 'user',
      };
    }
  }
  return serverConfig;
}

export function aiEnabled() {
  return Boolean(serverConfig.key);
}

export function aiInfo() {
  return {
    model: serverConfig.model,
    thinking: supportsThinking(serverConfig.base) ? thinkingEnabled(serverConfig) : null,
  };
}

/* 给前端看的状态：不提 Key、不提环境变量，只说能不能用、用的哪个模型 */
export function aiStatusFor(user) {
  const cfg = configFor(user);
  return {
    enabled: Boolean(cfg.key),
    source: cfg.key ? cfg.source : '',
    model: cfg.key ? cfg.model : '',
  };
}

const NOT_CONFIGURED = '还没开启 AI。在「我的 → AI 记账」里填一个自己的接口就能用。';

const PARSE_PROMPT = `你是一个记账解析器。把用户的一句话拆成一条或多条账目。
只输出 JSON，格式：{"records":[{"type":"expense","amount":28,"category":"餐饮","note":"午饭","date":"2026-11-10"}]}
规则：
1. type 只能是 "expense"（支出）或 "income"（收入）。
2. 支出 category 只能是：${EXPENSE_CATS.join('、')}。
3. 收入 category 只能是：${INCOME_CATS.join('、')}。
4. amount 是正数，单位元，不带符号和千分位。
5. note 是简短说明，不超过 12 个字；用户没提供有用信息就用分类名。
6. date 用 YYYY-MM-DD。用户说"昨天""上周五"等相对时间，请结合今天的日期换算。
7. 一句话含多笔账目时拆成多条。
8. 无法识别出金额时输出 {"records":[]}。
9. 输出必须是合法的单个 JSON 对象，不要用 markdown 代码块包裹，不要加任何解释文字。`;

const ANALYZE_PROMPT = `你是 Loopy，一只住在用户手机里的粉色小熊，帮主人看账本。
说话像朋友，简短、口语化、有点可爱但不肉麻，不要像理财顾问，不要说教。
只输出 JSON，格式：{"headline":"一句话总结","points":["观察1","观察2"],"tip":"一条建议"}
规则：
1. headline 不超过 18 个字，可以带一点情绪。
2. points 1-3 条，每条不超过 26 个字，说具体数字或对比，不要空话。
3. tip 不超过 34 个字，给一条能立刻做到的小建议。
4. 花的钱少就夸，花得多就直说，别一味鼓励也别吓唬人。
5. 不要编造数据里没有的东西，不要提"作为 AI"。
6. 输出必须是合法的单个 JSON 对象，不要用 markdown 代码块包裹。`;

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function normalizeDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return todayStr();
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return todayStr();
  return value;
}

/* 模型有时会用 ```json 包裹，或被要求多轮时带上解释文字，这里尽量抓出 JSON */
function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const attempts = [raw];

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) attempts.push(fence[1].trim());

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(raw.slice(first, last + 1));

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* 继续尝试下一种 */
    }
  }
  return null;
}

async function callModel(cfg, body, signal) {
  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.key}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const error = new Error(describeHttpError(res.status, text));
    error.status = 502;
    error.httpStatus = res.status;
    error.body = text;
    throw error;
  }
  return res.json();
}

/* 把供应商的英文报错翻成人能看懂的一句 */
function describeHttpError(status, body) {
  const raw = String(body || '');
  if (status === 401 || status === 403) return '接口不认这个 Key，检查一下是不是填错了';
  if (status === 404) return '接口地址不对，检查一下末尾是不是少了一段';
  if (status === 429) return '接口额度用完了，等一会儿再试';
  if (status === 400 && /model|not found|does not exist/i.test(raw)) return '这个模型名不对，换成接口支持的名字';
  return `接口返回 ${status}：${raw.slice(0, 160)}`;
}

/* 统一跑一次请求：不支持 response_format / enable_thinking 的兼容实现自动降级重试 */
async function runChat(cfg, messages, { json = true, timeout = 25000 } = {}) {
  const body = { model: cfg.model, temperature: 0, messages };
  if (json) body.response_format = { type: 'json_object' };
  if (supportsThinking(cfg.base)) body.enable_thinking = thinkingEnabled(cfg);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    try {
      return await callModel(cfg, body, controller.signal);
    } catch (e) {
      const unsupported = e.status === 502
        && /response_format|enable_thinking|json_object|Unsupported|InvalidParameter/i.test(e.body || '');
      if (!unsupported) throw e;
      return await callModel(cfg, { model: body.model, temperature: 0, messages }, controller.signal);
    }
  } catch (e) {
    if (e.status === 502) throw e;
    const err = new Error(e.name === 'AbortError' ? 'AI 响应超时，请重试' : `AI 请求失败：${e.message}`);
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const contentOf = (data) => data?.choices?.[0]?.message?.content || '';

export async function parseRecords(text, tzOffsetNote, user) {
  const cfg = configFor(user);
  if (!cfg.key) {
    const err = new Error(NOT_CONFIGURED);
    err.status = 503;
    throw err;
  }

  const data = await runChat(cfg, [
    { role: 'system', content: PARSE_PROMPT },
    { role: 'user', content: `今天是 ${todayStr()}。${tzOffsetNote || ''}\n用户说：${text}` },
  ]);

  const parsed = extractJson(contentOf(data));
  if (!parsed) {
    const err = new Error('没听懂，换个说法再试一次');
    err.status = 502;
    throw err;
  }

  const list = Array.isArray(parsed.records) ? parsed.records : [];
  return list
    .map((r) => {
      const type = r?.type === 'income' ? 'income' : 'expense';
      const allowed = type === 'income' ? INCOME_CATS : EXPENSE_CATS;
      const amount = Math.round(Number(r?.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount <= 0) return null;
      return {
        type,
        amount,
        category: allowed.includes(r?.category) ? r.category : allowed[allowed.length - 1],
        note: String(r?.note || '').slice(0, 20) || '未备注',
        date: normalizeDate(r?.date),
      };
    })
    .filter(Boolean);
}

/* 月度分析：只把统计结果发给模型，不传原始流水 */
function summaryPrompt(summary) {
  const lines = [
    `月份：${summary.month}`,
    `支出合计：${summary.expense.toFixed(2)} 元，收入：${summary.income.toFixed(2)} 元，共 ${summary.count} 笔`,
    `有支出的天数：${summary.activeDays} 天，日均支出：${summary.avg.toFixed(2)} 元`,
  ];

  if (summary.cats.length) {
    lines.push(`支出分类：${summary.cats.map((c) => `${c.name} ${c.amount.toFixed(0)}元(${c.share.toFixed(0)}%)`).join('、')}`);
  }
  if (summary.top.length) {
    lines.push(`最大的几笔：${summary.top.map((r) => `${r.category} ${r.amount.toFixed(0)}元${r.note ? `(${r.note})` : ''}`).join('、')}`);
  }
  if (summary.prevExpense > 0) {
    const diff = ((summary.expense - summary.prevExpense) / summary.prevExpense) * 100;
    lines.push(`上月支出：${summary.prevExpense.toFixed(2)} 元，本月${diff >= 0 ? '多了' : '少了'} ${Math.abs(diff).toFixed(0)}%`);
  } else {
    lines.push('上月没有支出记录，无法比较。');
  }

  return lines.join('\n');
}

export async function analyzeMonth(summary, user) {
  const cfg = configFor(user);
  if (!cfg.key) {
    const err = new Error(NOT_CONFIGURED);
    err.status = 503;
    throw err;
  }

  const data = await runChat(cfg, [
    { role: 'system', content: ANALYZE_PROMPT },
    { role: 'user', content: `这是主人这个月的账：\n${summaryPrompt(summary)}` },
  ], { timeout: 30000 });

  const parsed = extractJson(contentOf(data));
  if (!parsed) {
    const err = new Error('Loopy 走神了，再点一次试试');
    err.status = 502;
    throw err;
  }

  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const points = Array.isArray(parsed.points)
    ? parsed.points.map((p) => clip(p, 40)).filter(Boolean).slice(0, 3)
    : [];

  return {
    headline: clip(parsed.headline, 30) || '这个月就这些了',
    points,
    tip: clip(parsed.tip, 60),
  };
}

/* 测试一组接口配置，保存前先验证，免得填错了自己不知道 */
export async function testAiConfig({ base, key, model }) {
  const cfg = {
    key: String(key || '').trim(),
    base: trimSlash(base),
    model: String(model || '').trim() || DASHSCOPE_MODEL,
    thinking: process.env.AI_THINKING,
  };
  if (!cfg.key) throw Object.assign(new Error('先填 Key'), { status: 400 });
  if (!/^https?:\/\//i.test(cfg.base)) throw Object.assign(new Error('接口地址要以 http:// 或 https:// 开头'), { status: 400 });

  const started = Date.now();
  const data = await runChat(cfg, [
    { role: 'user', content: '只回复两个字：正常' },
  ], { json: false, timeout: 15000 });

  return {
    ok: true,
    ms: Date.now() - started,
    model: cfg.model,
    reply: String(contentOf(data)).trim().slice(0, 40),
  };
}
