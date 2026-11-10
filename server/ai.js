/*
 * AI 记账解析
 *
 * 走 OpenAI 兼容协议，可通过环境变量切供应商：
 *   AI_API_KEY + AI_BASE_URL + AI_MODEL   —— 通用写法（优先级最高）
 *   QWEN_API_KEY                          —— 通义千问/百炼，默认 qwen3.8-max
 *   DEEPSEEK_API_KEY                      —— 旧配置，继续兼容
 *
 * AI_THINKING=off 可关闭推理模型的长思考（通义默认关闭，记账不需要推理）
 */

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DASHSCOPE_MODEL = 'qwen3.8-max';

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

function resolveConfig() {
  const generic = (process.env.AI_API_KEY || '').trim();
  const qwen = (process.env.QWEN_API_KEY || '').trim();
  const deepseek = (process.env.DEEPSEEK_API_KEY || '').trim();

  if (generic) {
    return {
      key: generic,
      base: trimSlash(process.env.AI_BASE_URL) || DASHSCOPE_BASE,
      model: (process.env.AI_MODEL || '').trim() || DASHSCOPE_MODEL,
      thinking: process.env.AI_THINKING,
    };
  }
  if (qwen) {
    return {
      key: qwen,
      base: trimSlash(process.env.AI_BASE_URL) || DASHSCOPE_BASE,
      model: (process.env.AI_MODEL || '').trim() || DASHSCOPE_MODEL,
      thinking: process.env.AI_THINKING,
    };
  }
  if (deepseek) {
    return {
      key: deepseek,
      base: trimSlash(process.env.DEEPSEEK_BASE_URL) || 'https://api.deepseek.com',
      model: (process.env.DEEPSEEK_MODEL || '').trim() || 'deepseek-chat',
      thinking: process.env.AI_THINKING,
    };
  }
  return { key: '', base: DASHSCOPE_BASE, model: DASHSCOPE_MODEL, thinking: undefined };
}

const config = resolveConfig();

/* 是否支持 enable_thinking 参数（目前只有百炼/通义） */
const SUPPORTS_THINKING = /dashscope|aliyuncs/.test(config.base);

/* 推理模型默认关思考：记账是结构化抽取，不需要长推理，关掉后延迟约降 4 倍 */
function thinkingEnabled() {
  const raw = String(config.thinking || '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  return !SUPPORTS_THINKING;
}

export const EXPENSE_CATS = ['餐饮', '交通', '购物', '家居', '娱乐', '医疗', '学习', '人情', '其他'];
export const INCOME_CATS = ['工资', '奖金', '理财', '兼职', '红包', '其他'];

export function aiEnabled() {
  return Boolean(config.key);
}

export function aiInfo() {
  return { model: config.model, thinking: SUPPORTS_THINKING ? thinkingEnabled() : null };
}

const SYSTEM_PROMPT = `你是一个记账解析器。把用户的一句话拆成一条或多条账目。
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

async function callModel(body, signal) {
  const res = await fetch(`${config.base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const error = new Error(`AI 接口返回 ${res.status}：${text.slice(0, 200)}`);
    error.status = 502;
    error.httpStatus = res.status;
    error.body = text;
    throw error;
  }
  return res.json();
}

export async function parseRecords(text, tzOffsetNote) {
  if (!aiEnabled()) {
    const err = new Error('服务器还没有配置 AI Key，暂时用不了语音/一句话记账');
    err.status = 503;
    throw err;
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `今天是 ${todayStr()}。${tzOffsetNote || ''}\n用户说：${text}` },
  ];

  const body = {
    model: config.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages,
  };
  if (SUPPORTS_THINKING) body.enable_thinking = thinkingEnabled();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  let data;
  try {
    try {
      data = await callModel(body, controller.signal);
    } catch (e) {
      /* 部分兼容实现不支持 response_format / enable_thinking，去掉后重试一次 */
      const unsupported = e.status === 502 && /response_format|enable_thinking|json_object|Unsupported|InvalidParameter/i.test(e.body || '');
      if (!unsupported) throw e;
      const relaxed = { model: body.model, temperature: 0, messages };
      data = await callModel(relaxed, controller.signal);
    }
  } catch (e) {
    if (e.status === 502) throw e;
    const err = new Error(e.name === 'AbortError' ? 'AI 响应超时，请重试' : `AI 请求失败：${e.message}`);
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const content = data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(content);

  if (!parsed) {
    const err = new Error('AI 返回的内容不是合法 JSON，请换个说法再试');
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
