/**
 * npm run check:resume  (needs `next dev` on :3010 with the read API, and Google Chrome)
 *
 * Browser check of "Retomar" and "Registrados sem interromper" on Hoje. "Retomar": the list shows the principal's real recent questions; picking one
 * opens the conversation and brings THAT message on screen with focus on it; "Mostrar mais" expands
 * and collapses. "Registrados sem interromper": collapsed by default; opened, it lists exactly the insights
 * Wendy recorded without interrupting (count taken from her read API), each linking to its insight. Run in desktop and phone widths. The agent "run" request is blocked and every
 * non-local request is blocked, so nothing reaches Wendy's agent or any model, and nothing is written.
 * Exits 1 on any problem.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.WENDY_WEB_URL ?? 'http://localhost:3010';
const API = process.env.WENDY_API_URL ?? 'http://127.0.0.1:3457';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** How many quiet insights Hoje should list, from Wendy's own read API (already scope-filtered): at most 10. */
async function quietExpected() {
  const p = (await (await fetch(`${API}/api/principals?schema=public`)).json())[0];
  const t = await (await fetch(`${API}/api/today?schema=public&principal=${p.id}`)).json();
  return { shown: Math.min(10, (t.insights ?? []).filter((i) => i.status === 'SUPPRESSED').length), total: (t.insights ?? []).filter((i) => i.status === 'SUPPRESSED').length };
}

async function session(width) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wendy-resume-check-'));
  const chrome = spawn(CHROME, ['--headless=new', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const problems = [];
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await wait(500); } }
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0; const pending = new Map(); const external = []; const runs = [];
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
      if (d.method !== 'Fetch.requestPaused') return;
      const u = d.params.request.url;
      if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) { external.push(u); send('Fetch.failRequest', { requestId: d.params.requestId, errorReason: 'BlockedByClient' }); return; }
      if (/\/agent\/wendy\/run/.test(u)) { runs.push(u); send('Fetch.failRequest', { requestId: d.params.requestId, errorReason: 'BlockedByClient' }); return; }
      send('Fetch.continueRequest', { requestId: d.params.requestId });
    };
    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
    const expect = (ok, msg) => ok || problems.push(`${width}px: ${msg}`);
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height: width < 768 ? 812 : 900, deviceScaleFactor: 1, mobile: width < 768 });
    await send('Page.navigate', { url: BASE + '/' });
    await wait(9000);

    const rows = await ev(`[...document.querySelectorAll('[data-question-id]')].map((b) => ({ id: b.dataset.questionId, text: b.textContent.trim() }))`);
    if (!rows.length) return { width, problems: ['no "Retomar" rows (is there conversation history?)'] };
    expect(rows.length <= 5, `expected at most 5 rows collapsed, got ${rows.length}`);

    // Show more / less.
    const more = await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('Mostrar mais')); b?.click(); return !!b; })()`);
    if (more) {
      await wait(400);
      const open = await ev(`document.querySelectorAll('[data-question-id]').length`);
      expect(open > rows.length, '"Mostrar mais" did not show more questions');
      await ev(`(() => { [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Mostrar menos')?.click(); return true; })()`);
      await wait(300);
      expect((await ev(`document.querySelectorAll('[data-question-id]').length`)) === rows.length, '"Mostrar menos" did not collapse');
    }

    // "Registrados sem interromper": collapsed, then exactly what Wendy recorded.
    const q = await quietExpected();
    const hasDetails = await ev(`!!document.querySelector('details')`);
    if (q.total === 0) expect(!hasDetails, 'a quiet list is shown although nothing was recorded without interrupting');
    else {
      expect(hasDetails, 'the quiet list is missing');
      expect((await ev(`document.querySelector('details').open`)) === false, 'the quiet list should start collapsed');
      expect((await ev(`document.querySelector('details summary').textContent`)).includes(String(q.total)), 'the quiet list summary does not show the real total');
      await ev(`(() => { document.querySelector('details summary').click(); return true; })()`);
      await wait(300);
      const links = await ev(`[...document.querySelectorAll('details a[href^="/insight/"]')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent.trim() }))`);
      expect(links.length === q.shown, `the quiet list shows ${links.length} entries, Wendy recorded ${q.shown}`);
      expect(links.every((l) => /^\/insight\/[0-9a-f-]{36}$/.test(l.href) && l.text.length > 20), 'a quiet entry is empty or does not link to its insight');
      await ev(`(() => { document.querySelector('details summary').click(); return true; })()`);
    }

    // Pick the OLDEST visible question (the one furthest up the conversation).
    const pick = rows.at(-1);
    await ev(`(() => { document.querySelector('[data-question-id="${pick.id}"]').click(); return true; })()`);
    let landed = null;
    for (let i = 0; i < 40 && !landed?.focused; i++) {
      await wait(250);
      landed = await ev(`(() => { const a = document.activeElement; const r = a?.getBoundingClientRect(); return { focused: a?.dataset?.messageId === ${JSON.stringify(pick.id)}, inView: !!r && r.top >= 0 && r.bottom <= innerHeight && r.width > 0, text: a?.textContent?.trim().slice(0, 60) ?? '' }; })()`);
    }
    expect(landed?.focused, `picking "${pick.text.slice(0, 30)}" did not put focus on that message`);
    expect(landed?.inView, 'the picked message is not on screen');
    const pressed = await ev(`[...document.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent.trim()).join(',')`);
    if (width >= 768) expect(pressed.includes('Conversa'), `conversation mode not active (pressed: ${pressed})`);
    expect(runs.length === 0, `${runs.length} agent run request(s) were attempted`);
    expect(external.length === 0, `external requests attempted: ${external.join(', ')}`);
    ws.close();
  } catch (e) {
    problems.push(`${width}px: ${e.message}`);
  } finally {
    const exited = new Promise((r) => chrome.once('exit', r)); chrome.kill(); await exited;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return { width, problems };
}

const results = [];
for (const width of [1440, 390]) results.push(await session(width));
console.log(JSON.stringify(results, null, 1));
process.exit(results.some((r) => r.problems.length) ? 1 : 0);
