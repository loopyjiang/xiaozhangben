const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

export const EXPENSE_CATS = ['餐饮', '交通', '购物', '家居', '娱乐', '医疗', '学习', '人情', '其他'];
export const INCOME_CATS = ['工资', '奖金', '理财', '兼职', '红包', '其他'];

export function aiEnabled() {
  return Boolean(API_KEY);
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
8. 无法识别出金额时输出 {"records":[]}。`;

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

export async function parseRecords(text, tzOffsetNote) {
  if (!aiEnabled()) {
    const err = new Error('服务器还没有配置 DEEPSEEK_API_KEY');
    err.status = 503;
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `今天是 ${todayStr()}。${tzOffsetNote || ''}\n用户说：${text}` },
        ],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'AI 响应超时，请重试' : `AI 请求失败：${e.message}`);
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`AI 接口返回 ${res.status}：${body.slice(0, 160)}`);
    err.status = 502;
    throw err;
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '{}';

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const err = new Error('AI 返回的内容不是合法 JSON');
    err.status = 502;
    throw err;
  }

  const list = Array.isArray(parsed.records) ? parsed.records : [];
  return list
    .map((r) => {
      const type = r.type === 'income' ? 'income' : 'expense';
      const allowed = type === 'income' ? INCOME_CATS : EXPENSE_CATS;
      const amount = Math.round(Number(r.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount <= 0) return null;
      return {
        type,
        amount,
        category: allowed.includes(r.category) ? r.category : allowed[allowed.length - 1],
        note: String(r.note || '').slice(0, 20) || '未备注',
        date: normalizeDate(r.date),
      };
    })
    .filter(Boolean);
}
