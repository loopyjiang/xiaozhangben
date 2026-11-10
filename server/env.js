import fs from 'node:fs';
import path from 'node:path';

/**
 * 读取项目根目录的 .env，把缺失的键补进 process.env。
 * 这样不依赖 Node 20.6+ 的 --env-file 参数，Ubuntu 自带的 Node 18 也能用。
 */
const file = path.join(process.cwd(), '.env');

if (fs.existsSync(file)) {
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
