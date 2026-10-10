/**
 * npm run check:markdown  (needs `next dev` on :3010 and Google Chrome installed)
 *
 * Security regression check of the conversation's Markdown renderer (web/components/concierge/
 * markdown.tsx) on the dev fixture /dev/markdown, in a real headless Chrome. EVERY non-localhost
 * request is intercepted and failed inside the browser (recorded, never sent), so nothing leaves the
 * machine. Exits 1 if any case renders an image, a script, an iframe, an event handler or a
 * javascript: link, or if the page tried to contact any external host.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] ?? 'http://localhost:3010/dev/markdown';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wendy-md-check-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = async () => {
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await exited;
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
};
await new Promise((r) => setTimeout(r, 2500));
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const blocked = []; const dialogs = [];
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === 'Fetch.requestPaused') { const u = d.params.request.url; const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u) || u.startsWith('data:') || u.startsWith('blob:');
    if (local) send('Fetch.continueRequest', { requestId: d.params.requestId }); else { blocked.push(u); send('Fetch.failRequest', { requestId: d.params.requestId, errorReason: 'BlockedByClient' }); } }
  if (d.method === 'Page.javascriptDialogOpening') { dialogs.push(d.params.message); send('Page.handleJavaScriptDialog', { accept: false }); } };
await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }); await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url }); await new Promise((r) => setTimeout(r, 9000));
const res = (await send('Runtime.evaluate', { returnByValue: true, expression: `(() => Object.fromEntries([...document.querySelectorAll('section[data-case]')].map((s) => [s.dataset.case, {
  img: s.querySelectorAll('img').length, blockedImage: !!s.querySelector('[data-blocked-image]'), script: s.querySelectorAll('script').length, iframe: s.querySelectorAll('iframe').length,
  handlers: [...s.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length,
  jsHref: [...s.querySelectorAll('a')].filter((a) => /^\\s*javascript:/i.test(a.getAttribute('href') || '')).length,
  links: [...s.querySelectorAll('a')].map((a) => a.getAttribute('href')), tags: [...new Set([...s.querySelectorAll('strong,em,code,li,h2')].map((e) => e.tagName.toLowerCase()))],
  text: s.textContent.replace(/\\s+/g, ' ').trim().slice(0, 70) }])))()` })).result.result.value;
ws.close();
await cleanup();
const problems = [];
const need = (ok, msg) => ok || problems.push(msg);
for (const [k, v] of Object.entries(res)) {
  need(v.img === 0, `${k}: ${v.img} <img> rendered`);
  need(v.script === 0 && v.iframe === 0, `${k}: script/iframe rendered`);
  need(v.handlers === 0, `${k}: event-handler attribute rendered`);
  need(v.jsHref === 0, `${k}: javascript: link rendered`);
}
need(res.text?.tags.includes('em') && res.text?.tags.includes('li') && res.text?.tags.includes('h2'), 'text: normal markdown no longer rendered');
need(JSON.stringify(res.link?.links) === JSON.stringify(['https://example.com/docs']), 'link: safe https link not kept');
need(res['md-image']?.blockedImage && res['html-image']?.blockedImage, 'images: not replaced by the blocked-image label');
need(blocked.length === 0, `external requests attempted: ${blocked.join(', ')}`);
need(dialogs.length === 0, `script ran (dialog): ${dialogs.join(', ')}`);
console.log(JSON.stringify({ url, cases: Object.keys(res).length, externalRequests: blocked, problems }, null, 1));
process.exit(problems.length ? 1 : 0);
