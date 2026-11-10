import crypto from 'node:crypto';
import { store } from './store.js';

const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  let expected;
  try { expected = Buffer.from(hash, 'hex'); } catch { return false; }
  const actual = crypto.scryptSync(String(password), salt, 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 86400000;
  store.sessions.push({ token, userId, expires });
  pruneSessions();
  store.save();
  return token;
}

export function pruneSessions() {
  const now = Date.now();
  const alive = store.sessions.filter((s) => s.expires > now);
  if (alive.length !== store.sessions.length) {
    store.sessions.length = 0;
    store.sessions.push(...alive);
  }
}

export function destroySession(token) {
  const i = store.sessions.findIndex((s) => s.token === token);
  if (i >= 0) {
    store.sessions.splice(i, 1);
    store.save();
  }
}

export function userFromToken(token) {
  if (!token) return null;
  pruneSessions();
  const s = store.sessions.find((x) => x.token === token);
  if (!s) return null;
  return store.users.find((u) => u.id === s.userId) || null;
}

export function publicUser(user) {
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}
