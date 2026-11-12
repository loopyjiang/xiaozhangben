/*
 * 用户自己的 API Key 加密存储
 *
 * 密钥文件放在数据目录下（.aisecret，0600），和 db.json 分开。
 * 这样即使 db.json 被导出、备份泄露，里面的 Key 也解不开。
 * 密钥文件丢了就只能让用户重新填一次，不影响账目。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const KEY_FILE = path.join(DATA_DIR, '.aisecret');

let cached = null;

function masterKey() {
  if (cached) return cached;

  try {
    const raw = fs.readFileSync(KEY_FILE);
    if (raw.length === 32) {
      cached = raw;
      return cached;
    }
  } catch {
    /* 没有就新建 */
  }

  cached = crypto.randomBytes(32);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, cached, { mode: 0o600 });
  return cached;
}

export function encryptSecret(plain) {
  const text = String(plain || '');
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${body.toString('base64')}`;
}

export function decryptSecret(payload) {
  try {
    const [version, ivB64, tagB64, bodyB64] = String(payload || '').split(':');
    if (version !== 'v1' || !ivB64 || !tagB64 || !bodyB64) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(bodyB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    /* 密钥文件换了、数据被改过，都按"没配"处理 */
    return '';
  }
}

/* 只显示尾号，前端永远拿不到完整 Key */
export function maskSecret(plain) {
  const text = String(plain || '');
  if (!text) return '';
  if (text.length <= 8) return '••••';
  return `${'•'.repeat(6)}${text.slice(-4)}`;
}
