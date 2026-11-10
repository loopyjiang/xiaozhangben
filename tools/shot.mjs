/**
 * 用 Edge 的 DevTools 协议做手机视口截图 + 交互脚本执行。
 * 用法: node tools/shot.mjs --url http://127.0.0.1:8899/ --out shots/home.png [--js "..."]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const URL_ = args.url || 'http://127.0.0.1:8899/';
const OUT = args.out || 'shot.png';
const JS = args.js || '';
const WAIT = Number(args.wait || 900);
const WIDTH = Number(args.width || 390);
const HEIGHT = Number(args.height || 844);
const PORT = 9333 + Math.floor(Math.random() * 200);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-shot-'));

const child = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-proxy-server',
  '--no-first-run',
  '--disable-extensions',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('DevTools 没起来');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

try {
  await waitForDevtools();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page') || list[0];

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = cdp(ws);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  await send('Page.navigate', { url: URL_ });
  await sleep(WAIT);

  if (JS) {
    const r = await send('Runtime.evaluate', {
      expression: JS, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) console.error('JS 报错：', JSON.stringify(r.exceptionDetails).slice(0, 500));
    else if (r.result?.value !== undefined) console.log('JS 返回：', JSON.stringify(r.result.value).slice(0, 800));
    await sleep(WAIT);
  }

  const metrics = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth,
      title: document.title
    })`,
    returnByValue: true,
  });
  console.log('布局：', metrics.result.value);

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: args.full === 'true',
  });
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('已保存', OUT);
  ws.close();
} finally {
  child.kill();
  setTimeout(() => {
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  }, 400);
  setTimeout(() => process.exit(0), 900);
}
