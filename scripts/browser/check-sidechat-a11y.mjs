/**
 * npm run check:a11y  (needs `next dev` on :3010 with the read API and Google Chrome installed)
 *
 * Accessibility regression check of the conversation drawer (components/concierge/conversation-drawer.tsx,
 * the same conversation as Hoje) on the pages that carry it, in a real headless Chrome, desktop and phone.
 * It asserts on the BROWSER-COMPUTED accessibility tree (not on source attributes): the message input,
 * the send button and the close button must have their names and roles; once the conversation has loaded
 * its history, the input must be reachable with Tab and show focus; Space on "Enviar" and Enter in the
 * input must each submit once; Escape closes the drawer and returns focus to the "Perguntar à Wendy"
 * button. The agent "run" request is intercepted and failed inside the browser and every non-local
 * request is blocked, so nothing reaches Wendy's agent or any model. Exits 1 on any problem.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.WENDY_WEB_URL ?? 'http://localhost:3010';
const API = process.env.WENDY_API_URL ?? 'http://127.0.0.1:3457';
const EXPECTED = { input: ['textbox', 'Mensagem para a Wendy'], send: ['button', 'Enviar'], close: ['button', 'Fechar conversa'] };
const DRAWER = '#wendy-drawer';

async function insightPath() {
  try {
    const p = (await (await fetch(`${API}/api/principals?schema=public`)).json())[0];
    const t = await (await fetch(`${API}/api/today?schema=public&principal=${p.id}`)).json();
    const id = (t.insights ?? [])[0]?.id;
    return id ? `/insight/${id}` : null;
  } catch {
    return null;
  }
}

async function check(route, width) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wendy-a11y-check-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 2500));
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    const runs = [];
    const external = [];
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
      if (d.method === 'Fetch.requestPaused') {
        const u = d.params.request.url;
        if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) { external.push(u); send('Fetch.failRequest', { requestId: d.params.requestId, errorReason: 'BlockedByClient' }); return; }
        if (/\/agent\/wendy\/run/.test(u)) { runs.push(u); send('Fetch.failRequest', { requestId: d.params.requestId, errorReason: 'BlockedByClient' }); return; }
        send('Fetch.continueRequest', { requestId: d.params.requestId });
      }
    };
    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
    const key = async (k, code, vk) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable'); await send('Accessibility.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height: width < 768 ? 812 : 900, deviceScaleFactor: 1, mobile: width < 768 });
    await send('Page.navigate', { url: BASE + route });
    await new Promise((r) => setTimeout(r, 8000));
    // Open the drawer if it is closed (on wide screens it opens by itself), then wait until it has
    // finished opening: the input fully inside the viewport and at the same place on 3 reads.
    await ev(`(() => { [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Perguntar à Wendy')?.click(); return true; })()`);
    const where = `(() => { const t = document.querySelector('${DRAWER} textarea'); if (!t) return null; const b = t.getBoundingClientRect(); return b.width > 0 && b.left >= 0 && b.right <= innerWidth ? Math.round(b.left) + ',' + Math.round(b.top) : null; })()`;
    let last = null, same = 0;
    for (let i = 0; i < 40 && same < 3; i++) { await new Promise((r) => setTimeout(r, 250)); const w = await ev(where); same = w && w === last ? same + 1 : 0; last = w; }
    if (same < 3) return { route, width, problems: ['drawer did not finish opening'] };
    // As a person would: only interact once the conversation has loaded its history (connect done).
    let loaded = false;
    for (let i = 0; i < 40 && !loaded; i++) { loaded = await ev(`document.querySelectorAll('${DRAWER} [role="log"] li').length > 0`); if (!loaded) await new Promise((r) => setTimeout(r, 250)); }
    if (!loaded) return { route, width, problems: ['conversation history did not load'] };
    // Tag the three controls (script-only, nothing is changed in the app) so the computed tree can be matched back to them.
    await ev(`(() => { const d = document.querySelector('${DRAWER}'); d.querySelector('textarea').dataset.a11y = 'input'; d.querySelector('button[type="submit"]').dataset.a11y = 'send'; d.querySelector('button[aria-label="Fechar conversa"]').dataset.a11y = 'close'; return true; })()`);

    // Browser-computed names and roles, matched back to the controls by their CopilotKit test ids.
    const { result } = await send('Accessibility.getFullAXTree');
    const computed = {};
    for (const node of result.nodes) {
      if (!node.backendDOMNodeId || node.ignored) continue;
      const r = (await send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId })).result;
      if (!r?.object?.objectId) continue;
      const testid = (await send('Runtime.callFunctionOn', { objectId: r.object.objectId, returnByValue: true, functionDeclaration: 'function () { return this.getAttribute ? this.getAttribute("data-a11y") : null; }' })).result?.result?.value;
      if (testid && testid in EXPECTED) (computed[testid] ??= []).push([node.role?.value, node.name?.value ?? '']);
    }
    const problems = [];
    const warnings = [];
    for (const [testid, [role, name]] of Object.entries(EXPECTED)) {
      const got = computed[testid] ?? [];
      if (got.length !== 1) problems.push(`${testid}: expected exactly one control, found ${got.length}`);
      else if (got[0][0] !== role || got[0][1] !== name) problems.push(`${testid}: computed ${got[0][0]} "${got[0][1]}", expected ${role} "${name}"`);
    }

    // Keyboard: Tab to the input (focus visible), type, Tab to send, Space submits.
    const active = `(() => { const a = document.activeElement; return a ? { which: a.dataset?.a11y ?? null, focusVisible: a.matches(':focus-visible') } : null; })()`;
    await ev('document.activeElement?.blur(), true');
    let reached = null;
    for (let i = 0; i < 120 && !reached; i++) { await key('Tab', 'Tab', 9); const a = await ev(active); if (a?.which === 'input') reached = a; }
    if (!reached) problems.push('message input not reachable with Tab');
    else if (!reached.focusVisible) problems.push('message input focus not visible');
    await send('Input.insertText', { text: 'verificação de teclado' });
    await new Promise((r) => setTimeout(r, 400));
    const typed = await ev(`document.querySelector('${DRAWER} textarea')?.value ?? null`);
    if (reached && typed !== 'verificação de teclado') problems.push(`typing into the focused input did not reach it (value: ${JSON.stringify(typed)})`);
    // Send becomes enabled once there is text (a disabled button is correctly skipped by Tab).
    for (let i = 0; i < 20; i++) { if ((await ev(`document.querySelector('${DRAWER} button[type="submit"]')?.disabled`)) === false) break; await new Promise((r) => setTimeout(r, 250)); }
    await key('Tab', 'Tab', 9);
    const next = await ev(active);
    if (next?.which !== 'send' || !next.focusVisible) problems.push(`after the input, focus is on ${JSON.stringify(next)} (expected the send button, visible)`);
    else await key(' ', 'Space', 32);
    await new Promise((r) => setTimeout(r, 2000));
    if (runs.length !== 1) problems.push(`Space on "Enviar" produced ${runs.length} run request(s), expected 1`);
    // Second path: Enter in the input submits too.
    await ev(`(() => { document.querySelector('${DRAWER} textarea').focus(); return true; })()`);
    await send('Input.insertText', { text: 'segunda verificação' });
    await new Promise((r) => setTimeout(r, 400));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await new Promise((r) => setTimeout(r, 2000));
    if (runs.length !== 2) problems.push(`Enter in the input produced ${runs.length - 1} run request(s), expected 1`);
    // Escape closes the drawer, hides it from Tab and the accessibility tree, and puts focus on the opener.
    await ev(`(() => { document.querySelector('${DRAWER} textarea').focus(); return true; })()`);
    await key('Escape', 'Escape', 27);
    await new Promise((r) => setTimeout(r, 500));
    const closed = await ev(`(() => { const d = document.querySelector('${DRAWER}'); const a = document.activeElement; return { hidden: getComputedStyle(d).display === 'none', onOpener: !!a && a.textContent.trim() === 'Perguntar à Wendy' }; })()`);
    if (!closed.hidden) problems.push('Escape did not close the drawer');
    if (!closed.onOpener) problems.push('after Escape, focus did not return to "Perguntar à Wendy"');
    const overflow = await ev(`(() => { const W = innerWidth; return [...document.querySelectorAll('body *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > W + 1 && getComputedStyle(e).position !== 'fixed'; }).length; })()`);
    if (overflow) problems.push(`${overflow} element(s) overflow the ${width}px viewport`);
    if (external.length) problems.push(`external requests attempted: ${external.join(', ')}`);
    ws.close();
    return { route, width, problems, warnings };
  } finally {
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await exited;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const routes = ['/sites', '/memoria', await insightPath()].filter(Boolean);
const results = [];
for (const width of [1440, 375]) for (const route of routes) results.push(await check(route, width));
console.log(JSON.stringify(results, null, 1));
process.exit(results.some((r) => r.problems.length) || routes.length < 3 ? 1 : 0);
