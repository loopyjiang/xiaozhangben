import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const empty = () => ({ users: [], records: [], sessions: [] });

let db = empty();
let timer = null;
let dirty = false;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db = {
      users: Array.isArray(raw.users) ? raw.users : [],
      records: Array.isArray(raw.records) ? raw.records : [],
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    };
  } catch (err) {
    console.error('[store] 读取 db.json 失败，已启用空数据：', err.message);
    const broken = `${DB_FILE}.broken-${Date.now()}`;
    try { fs.copyFileSync(DB_FILE, broken); } catch {}
    db = empty();
  }
}

export function flushNow() {
  if (!dirty) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
  fs.renameSync(tmp, DB_FILE);
  dirty = false;
}

function schedule() {
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { flushNow(); } catch (err) { console.error('[store] 写入失败：', err.message); }
  }, 60);
}

export const store = {
  get users() { return db.users; },
  get records() { return db.records; },
  get sessions() { return db.sessions; },
  save: schedule,
};

load();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { flushNow(); } catch {}
    process.exit(0);
  });
}
process.on('exit', () => { try { flushNow(); } catch {} });
