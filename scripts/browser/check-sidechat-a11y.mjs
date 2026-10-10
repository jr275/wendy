/**
 * npm run check:a11y  (needs `next dev` on :3010 with the read API and Google Chrome installed)
 *
 * Accessibility regression check of the side chat (WendySidebar → CopilotSidebar) on the pages that
 * carry it, in a real headless Chrome, desktop and phone. It asserts on the BROWSER-COMPUTED
 * accessibility tree (not on source attributes): the message input and the two icon buttons must
 * have their names and roles; once the side chat has loaded, the input must be reachable with Tab
 * and show focus; Space on "Enviar mensagem" and Enter in the input must each submit once. The agent "run" request is intercepted and failed inside the
 * browser and every non-local request is blocked, so nothing reaches Wendy's agent or any model.
 * Exits 1 on any problem.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.WENDY_WEB_URL ?? 'http://localhost:3010';
const API = process.env.WENDY_API_URL ?? 'http://127.0.0.1:3457';
const EXPECTED = { 'copilot-chat-textarea': ['textbox', 'Mensagem para a Wendy'], 'copilot-send-button': ['button', 'Enviar mensagem'], 'copilot-add-menu-button': ['button', 'Adicionar anexos'] };

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
    // Open the side chat if it is closed (on wide screens it opens by itself), then wait until it has
    // finished sliding in: the input fully inside the viewport and at the same place on 3 reads.
    await ev(`(() => { [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '') === 'Abrir conversa com a Wendy')?.click(); return true; })()`);
    const where = `(() => { const t = document.querySelector('[data-testid="copilot-chat-textarea"]'); if (!t) return null; const b = t.getBoundingClientRect(); return b.width > 0 && b.left >= 0 && b.right <= innerWidth ? Math.round(b.left) + ',' + Math.round(b.top) : null; })()`;
    let last = null, same = 0;
    for (let i = 0; i < 40 && same < 3; i++) { await new Promise((r) => setTimeout(r, 250)); const w = await ev(where); same = w && w === last ? same + 1 : 0; last = w; }
    if (same < 3) return { route, width, problems: ['side chat did not finish opening'] };
    // As a person would: only interact once the side chat has loaded its history (connect done).
    let loaded = false;
    for (let i = 0; i < 40 && !loaded; i++) { loaded = await ev(`document.querySelectorAll('[data-testid="copilot-sidebar"] [data-testid="copilot-user-message"]').length > 0`); if (!loaded) await new Promise((r) => setTimeout(r, 250)); }
    if (!loaded) return { route, width, problems: ['side chat history did not load'] };

    // Browser-computed names and roles, matched back to the controls by their CopilotKit test ids.
    const { result } = await send('Accessibility.getFullAXTree');
    const computed = {};
    for (const node of result.nodes) {
      if (!node.backendDOMNodeId || node.ignored) continue;
      const r = (await send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId })).result;
      if (!r?.object?.objectId) continue;
      const testid = (await send('Runtime.callFunctionOn', { objectId: r.object.objectId, returnByValue: true, functionDeclaration: 'function () { return this.getAttribute ? this.getAttribute("data-testid") : null; }' })).result?.result?.value;
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
    const active = `(() => { const a = document.activeElement; return a ? { name: a.getAttribute('aria-label'), focusVisible: a.matches(':focus-visible') } : null; })()`;
    await ev('document.activeElement?.blur(), true');
    let reached = null;
    for (let i = 0; i < 100 && !reached; i++) { await key('Tab', 'Tab', 9); const a = await ev(active); if (a?.name === 'Mensagem para a Wendy') reached = a; }
    if (!reached) problems.push('message input not reachable with Tab');
    else if (!reached.focusVisible) problems.push('message input focus not visible');
    await send('Input.insertText', { text: 'verificação de teclado' });
    await new Promise((r) => setTimeout(r, 400));
    const typed = await ev(`document.querySelector('[data-testid="copilot-chat-textarea"]')?.value ?? null`);
    if (reached && typed !== 'verificação de teclado') problems.push(`typing into the focused input did not reach it (value: ${JSON.stringify(typed)})`);
    // Send becomes enabled once there is text (a disabled button is correctly skipped by Tab).
    for (let i = 0; i < 20; i++) { if ((await ev(`document.querySelector('[data-testid="copilot-send-button"]')?.disabled`)) === false) break; await new Promise((r) => setTimeout(r, 250)); }
    // Known, pre-existing CopilotKit behavior (same rate with or without Wendy's names; the input is
    // not remounted): Tab from the input occasionally skips "Enviar mensagem". One retry is allowed and
    // REPORTED as a warning; a second miss is a failure. Space is pressed only on the send button.
    let next = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      await ev(`(() => { document.querySelector('[data-testid="copilot-chat-textarea"]').focus(); return true; })()`);
      for (let i = 0; i < 20; i++) { if ((await ev(`document.querySelector('[data-testid="copilot-send-button"]')?.disabled`)) === false) break; await new Promise((r) => setTimeout(r, 250)); }
      await key('Tab', 'Tab', 9);
      next = await ev(active);
      if (next?.name === 'Enviar mensagem') break;
      warnings.push(`Tab from the input went to ${JSON.stringify(next?.name)} on attempt ${attempt}`);
    }
    if (next?.name !== 'Enviar mensagem' || !next.focusVisible) problems.push(`after the input, focus is on ${JSON.stringify(next)} (expected "Enviar mensagem", visible)`);
    else await key(' ', 'Space', 32);
    await new Promise((r) => setTimeout(r, 2000));
    if (runs.length !== 1) problems.push(`Space on "Enviar mensagem" produced ${runs.length} run request(s), expected 1`);
    // Second path: Enter in the input submits too.
    await ev(`(() => { const t = document.querySelector('[data-testid="copilot-chat-textarea"]'); t.focus(); return true; })()`);
    await send('Input.insertText', { text: 'segunda verificação' });
    await new Promise((r) => setTimeout(r, 400));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await new Promise((r) => setTimeout(r, 2000));
    if (runs.length !== 2) problems.push(`Enter in the input produced ${runs.length - 1} run request(s), expected 1`);
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
