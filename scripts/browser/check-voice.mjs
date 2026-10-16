/**
 * node scripts/browser/check-voice.mjs  (needs `next dev` on :3010 with the read API, and Google Chrome)
 *
 * Browser check of the voice controls in the REAL conversation on Hoje, in a headless Chrome with the microphone permission DENIED (set through
 * the DevTools protocol, so it is deterministic). It proves what can be proven without a person at a microphone:
 *   - the button exists, is enabled once the page has hydrated, has an accessible name and (on a phone) a 44px target;
 *   - without the person's consent the microphone is never touched: pressing shows the disclosure, declining closes it, nothing starts;
 *   - after consent, the REAL browser recognizer is started and the blocked microphone is reported as an ERROR in words — never "Ouvindo…",
 *     never a transcript, and pressing again does not retry;
 *   - nothing is sent to the conversation by voice, and typing a message still goes through the normal send (the one blocked `run` request).
 * It does NOT prove speech recognition: that needs a real microphone (docs/VOICE_VALIDATION.md).
 * Every non-local request is blocked and the agent "run" request is blocked, so nothing reaches Wendy's agent, a model or Google. Exits 1 on any problem.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.WENDY_WEB_URL ?? 'http://localhost:3010';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(width) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wendy-voice-check-'));
  const chrome = spawn(CHROME, ['--headless=new', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const problems = [];
  const notes = {};
  try {
    for (let i = 0; i < 40; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`);
        break;
      } catch {
        await wait(500);
      }
    }
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    const external = [];
    const runs = [];
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
    await send('Page.enable');
    await send('Runtime.enable');
    // Deterministic: the microphone is DENIED for this origin.
    await send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'denied', origin: new URL(BASE).origin });
    await send('Emulation.setDeviceMetricsOverride', { width, height: width < 768 ? 812 : 900, deviceScaleFactor: 1, mobile: width < 768 });
    await send('Page.navigate', { url: BASE + '/' });
    await wait(9000);

    // On a phone the conversation is behind "Abrir conversa".
    if (width < 1024) {
      await ev(`(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Abrir conversa')?.click(); return true; })()`);
      await wait(1500);
    }
    const mic = `[...document.querySelectorAll('button[data-voice-state]')].find((b) => b.getClientRects().length > 0)`;
    const panel = `[...document.querySelectorAll('[data-voice-panel]')].find((p) => p.getClientRects().length > 0)`;

    const btn = await ev(`(() => { const b = ${mic}; if (!b) return null; const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label'), state: b.dataset.voiceState, disabled: b.disabled, w: Math.round(r.width), h: Math.round(r.height), pressed: b.getAttribute('aria-pressed') }; })()`);
    notes.button = btn;
    if (!btn) return { width, problems: [`${width}px: the microphone button is not on screen`], notes };
    expect(!btn.disabled, 'the button is disabled after hydration (feature detection did not finish)');
    expect(btn.state === 'IDLE', `initial state is ${btn.state}, expected IDLE`);
    expect(!!btn.label && btn.label.length > 3, 'the button has no accessible name');
    if (width < 768) expect(btn.h >= 44 && btn.w >= 44, `touch target is ${btn.w}x${btn.h}, expected at least 44x44`);

    const baseline = await ev(`(() => { const t = [...document.querySelectorAll('textarea')].find((x) => x.getClientRects().length > 0); return { messages: document.querySelectorAll('[data-message-id]').length, text: t?.value ?? null }; })()`);

    // 1) Without consent: the disclosure appears, nothing starts.
    await ev(`(() => { ${mic}.click(); return true; })()`);
    await wait(500);
    const dlg = await ev(`(() => { const d = ${panel}?.querySelector('[role=alertdialog]'); return d ? { title: d.querySelector('p')?.textContent, state: ${mic}.dataset.voiceState, mentionsGoogle: /Google/.test(d.textContent) } : null; })()`);
    notes.disclosure = dlg;
    expect(!!dlg, 'pressing the microphone without consent did not show the disclosure');
    expect(dlg?.state === 'IDLE', 'the microphone state changed before the person agreed');
    expect(dlg?.mentionsGoogle, 'the disclosure does not say where the audio may go');
    expect((await ev(`localStorage.getItem('wendy.voice.v1')`)) === null, 'a preference was saved before the person chose anything');

    // 2) Declining closes it and starts nothing.
    await ev(`(() => { [...${panel}.querySelectorAll('button')].find((b) => /Agora não/.test(b.textContent))?.click(); return true; })()`);
    await wait(300);
    expect(!(await ev(`!!${panel}?.querySelector('[role=alertdialog]')`)), 'declining did not close the disclosure');
    expect((await ev(`${mic}.dataset.voiceState`)) === 'IDLE', 'declining left the microphone in a non-idle state');

    // 3) After consent the REAL recognizer is started; the denied microphone is an ERROR in words.
    await ev(`(() => { ${mic}.click(); return true; })()`);
    await wait(400);
    await ev(`(() => { [...${panel}.querySelectorAll('button')].find((b) => /Entendi/.test(b.textContent))?.click(); return true; })()`);
    const seen = new Set();
    let last = null;
    for (let i = 0; i < 40; i++) {
      await wait(150);
      last = await ev(`(() => { const p = ${panel}; return { state: ${mic}.dataset.voiceState, text: p?.querySelector('[role=status]')?.textContent.trim(), pressed: ${mic}.getAttribute('aria-pressed') }; })()`);
      seen.add(`${last.state}|${/Ouvindo/.test(last.text ?? '')}`);
      if (last.state === 'ERROR') break;
    }
    notes.afterConsent = last;
    expect(last?.state === 'ERROR', `with the microphone blocked the state is ${last?.state}, expected ERROR`);
    expect(/bloqueado/.test(last?.text ?? ''), `the error does not say the microphone is blocked: "${last?.text}"`);
    expect(![...seen].some((s) => s.endsWith('|true')), '"Ouvindo…" was shown although the microphone was never live');
    expect(last?.pressed === 'false', 'the button reports pressed while there is no listening');
    const saved = await ev(`(() => { try { return JSON.parse(localStorage.getItem('wendy.voice.v1') ?? '{}'); } catch { return {}; } })()`);
    expect(saved.consented === true && saved.autoSend !== true, 'after consent the saved preferences are wrong (consent true, auto-send must stay off)');

    // 4) Pressing again does not retry a blocked microphone.
    await ev(`(() => { ${mic}.click(); return true; })()`);
    await wait(700);
    expect((await ev(`${mic}.dataset.voiceState`)) === 'ERROR', 'pressing again changed a permission error');

    // 5) Nothing was sent by voice; the composer is untouched.
    const after = await ev(`(() => { const t = [...document.querySelectorAll('textarea')].find((x) => x.getClientRects().length > 0); return { messages: document.querySelectorAll('[data-message-id]').length, text: t?.value ?? null }; })()`);
    expect(after.messages === baseline.messages, `messages changed from ${baseline.messages} to ${after.messages} without any send`);
    expect(after.text === baseline.text, 'the composer text was changed by a failed voice attempt');
    expect(runs.length === 0, `${runs.length} agent run request(s) were attempted by voice`);

    // 6) Closing the notice returns to idle.
    await ev(`(() => { [...${panel}.querySelectorAll('button')].find((b) => /Fechar aviso/.test(b.textContent))?.click(); return true; })()`);
    await wait(300);
    expect((await ev(`${mic}.dataset.voiceState`)) === 'IDLE', '"Fechar aviso" did not return to idle');

    // 7) Typing still works exactly as before: it goes through the normal send (one run request, blocked here), and voice is not involved.
    await ev(`(() => { const t = [...document.querySelectorAll('textarea')].find((x) => x.getClientRects().length > 0); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'mensagem digitada de teste'); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await wait(200);
    await ev(`(() => { const t = [...document.querySelectorAll('textarea')].find((x) => x.getClientRects().length > 0); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    await wait(1500);
    expect(runs.length === 1, `a typed message should make exactly one run request, got ${runs.length}`);
    expect((await ev(`${mic}.dataset.voiceState`)) === 'IDLE', 'a typed message moved the voice state');

    // 8) The settings exist and say reviewing is the default.
    const settings = await ev(`(() => { const d = ${panel}?.querySelector('details'); return d ? d.textContent : null; })()`);
    expect(!!settings && /Enviar sozinha depois de falar/.test(settings) && /revisa o texto/.test(settings), 'the voice settings (auto-send explanation) are missing');
    expect(external.length === 0, `external requests attempted: ${external.join(', ')}`);
    ws.close();
  } catch (e) {
    problems.push(`${width}px: ${e.message}`);
  } finally {
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await exited;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return { width, problems, notes };
}

const results = [];
for (const width of [1440, 390]) results.push(await session(width));
console.log(JSON.stringify(results, null, 1));
process.exit(results.some((r) => r.problems.length) ? 1 : 0);
