/**
 * node scripts/browser/shot.mjs <route> <width> <height> <out.png> [light|dark] [clickText] [js]
 *
 * One screenshot of a route in real headless Chrome, for looking at the interface. Optional: switch
 * theme, click a button by its exact text, run a snippet. The agent "run" request and every non-local
 * request are blocked, so nothing reaches Wendy's agent or any model, and nothing is written.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CH = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.WENDY_WEB_URL ?? 'http://localhost:3010';
const [, , route = '/', w = '1440', h = '900', out = 'shot.png', theme = 'light', click = '', js = ''] = process.argv;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9900 + Math.floor(Math.random() * 90);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'wendy-shot-'));
const c = spawn(CH, ['--headless=new', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
try {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await wait(400); } }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const p = new Map();
  const send = (m, a = {}) => new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: a })); });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); }
    if (d.method === 'Fetch.requestPaused') {
      const u = d.params.request.url;
      if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u) || /\/agent\/wendy\/run/.test(u)) { send('Fetch.failRequest', { requestId: d.params.requestId, errorReason: 'BlockedByClient' }); return; }
      send('Fetch.continueRequest', { requestId: d.params.requestId });
    }
  };
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }); await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: +w < 768 });
  await send('Page.navigate', { url: BASE + route }); await wait(7000);
  if (theme === 'dark') await ev(`document.documentElement.dataset.theme='dark'`);
  if (click) await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(click)});b?.click();return !!b})()`);
  if (js) { const r = await ev(js); if (r !== undefined) console.log(typeof r === 'string' ? r : JSON.stringify(r)); }
  await wait(1800);
  if (process.env.DUMP) console.log(await ev(`(()=>{const e=document.querySelector(${JSON.stringify(process.env.DUMP)});return e?e.innerHTML.slice(0,${Number(process.env.DUMP_N || 3000)}):'(nada)'})()`));
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(s.result.data, 'base64'));
  ws.close();
} finally {
  const e = new Promise((r) => c.once('exit', r)); c.kill(); await e;
  fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
