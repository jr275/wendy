/**
 * npm run check:mood  (needs `next dev` on :3010 with the read API, and Google Chrome)
 *
 * Browser check of the home conversation's emotional presence, with the agent REPLACED by a fixture:
 * the `run` request is intercepted inside the browser and answered with a fixed AG-UI stream (a
 * STATE_SNAPSHOT carrying a mood, or a RUN_ERROR). Nothing reaches Wendy's agent or any model, every
 * non-local request is blocked, and nothing is written to the database.
 *
 * Checks (exit 1 on any problem): neutral halo first; an explicit reading shows its character; a weak
 * different reading does not flicker the character; a strong one with a compatible second reading
 * shows two; "Não é isso" returns to neutral; the user's own pick wins; "Mostrar personagens" off
 * returns to the halo; the presence is hidden from assistive tech; no overflow; the agent's own
 * error sentence is shown when a run fails.
 * Screenshots go to $SHOTS (default: os temp dir) when SHOTS is set.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.WENDY_WEB_URL ?? 'http://localhost:3010';
const SHOTS = process.env.SHOTS;
const ERROR_TEXT = 'A autenticação do Google (usada pelo Gemini) expirou. No terminal, rode `gcloud auth application-default login` e tente de novo.';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(width, scenario) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wendy-mood-check-'));
  const chrome = spawn(CHROME, ['--headless=new', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const problems = [];
  const log = [];
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await wait(500); } }
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    let mood = null;
    let failWith = null;
    const external = [];
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
      if (d.method !== 'Fetch.requestPaused') return;
      const u = d.params.request.url;
      if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) { external.push(u); send('Fetch.failRequest', { requestId: d.params.requestId, errorReason: 'BlockedByClient' }); return; }
      if (/\/agent\/wendy\/run/.test(u)) {
        const mid = `fx-${Math.random().toString(36).slice(2)}`;
        const evs = failWith
          ? [{ type: 'RUN_STARTED', threadId: 'main', runId: 'fx' }, { type: 'RUN_ERROR', message: failWith }]
          : [{ type: 'RUN_STARTED', threadId: 'main', runId: 'fx' }, ...(mood ? [{ type: 'STATE_SNAPSHOT', snapshot: { mood } }] : []), { type: 'TEXT_MESSAGE_START', messageId: mid, role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: mid, delta: 'Resposta de teste.' }, { type: 'TEXT_MESSAGE_END', messageId: mid }, { type: 'RUN_FINISHED', threadId: 'main', runId: 'fx' }];
        send('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }], body: Buffer.from(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')).toString('base64') });
        return;
      }
      send('Fetch.continueRequest', { requestId: d.params.requestId });
    };
    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
    const shot = async (name) => { if (!SHOTS) return; const r = await send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
    const mk = (o) => { const now = new Date(); return { category: 'concerned', confidence: 0.9, evidenceSource: 'explicit_user_statement', responseTone: 'calm', updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600000).toISOString(), ...o }; };
    const say = async (text) => {
      await ev(`(() => { const ta = document.querySelector('form textarea[placeholder^="Pergunte"]'); ta.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await wait(300);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await wait(2500);
    };
    const state = () => ev(`(() => { const s = document.querySelector('.char-slot'); return { imgs: [...(s?.querySelectorAll('img') ?? [])].map((i) => i.getAttribute('src')), halo: !!s?.querySelector('.presence'), hidden: s?.getAttribute('aria-hidden'), overflow: document.documentElement.scrollWidth - innerWidth }; })()`);
    const click = (text) => ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); b?.click(); return !!b; })()`);
    const expect = (ok, msg) => ok || problems.push(`${width}px ${scenario}: ${msg}`);

    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height: width < 768 ? 812 : 900, deviceScaleFactor: 2, mobile: width < 768 });
    await send('Page.navigate', { url: BASE + '/' });
    await wait(9000);
    if (width < 768) { await click('Perguntar à Wendy'); await wait(1200); }

    if (scenario === 'mood') {
      const s0 = await state(); await shot(`${width}-0-neutro`);
      expect(s0.halo && s0.imgs.length === 0, `expected the neutral halo first, got ${JSON.stringify(s0)}`);
      mood = mk({ category: 'concerned' }); await say('Estou muito ansioso com essa viagem');
      const s1 = await state(); await shot(`${width}-1-ansiedade`);
      expect(s1.imgs.join() === '/characters/anxiety.webp', `explicit concern should show anxiety, got ${s1.imgs}`);
      mood = mk({ category: 'frustrated', confidence: 0.65, evidenceSource: 'current_conversation' }); await say('segunda mensagem');
      expect((await state()).imgs.join() === '/characters/anxiety.webp', 'a weak different reading flickered the character');
      mood = mk({ category: 'positive_energy', confidence: 0.95, secondary: { category: 'curious', confidence: 0.65 } }); await say('Deu certo!');
      const s3 = await state(); await shot(`${width}-2-duas`);
      expect(s3.imgs.join() === '/characters/joy.webp,/characters/envy.webp', `strong positive + compatible second should show two, got ${s3.imgs}`);
      expect(s3.hidden === 'true', 'the presence is not hidden from assistive technology');
      await click('Personagens'); await wait(500); await shot(`${width}-3-controle`);
      const panel = await ev(`document.querySelector('[role="group"][aria-label^="Personagens"]')?.innerText.replace(/\\s+/g, ' ') ?? ''`);
      expect(/não muda nada do que a Wendy faz/.test(panel) && /Não é isso/.test(panel), `the control does not explain itself honestly: ${panel.slice(0, 120)}`);
      await click('Não é isso');
      await wait(600);
      expect((await state()).halo, 'correction did not return to neutral');
      await click('Personagens'); await wait(400);
      await ev(`(() => { [...document.querySelectorAll('[aria-pressed]')].find((b) => b.textContent.startsWith('Tristeza'))?.click(); return true; })()`); await wait(500);
      expect((await state()).imgs.join() === '/characters/sadness.webp', "the user's own pick did not win");
      await ev(`(() => { [...document.querySelectorAll('input[type=checkbox]')].find((i) => i.parentElement.textContent.includes('Mostrar personagens'))?.click(); return true; })()`); await wait(500);
      const off = await state(); await shot(`${width}-4-desligado`);
      expect(off.halo && off.imgs.length === 0, 'characters off should leave only the halo');
      expect(off.overflow <= 0, `${off.overflow}px horizontal overflow`);
    } else {
      failWith = ERROR_TEXT;
      await say('Teste de erro');
      const t = await ev(`document.querySelector('[role="log"] [role="alert"]')?.textContent ?? null`);
      await shot(`${width}-erro`);
      expect(t && t.includes('gcloud auth application-default login') && t.includes('Sua mensagem ficou na conversa'), `the agent's error sentence was not shown: ${t}`);
    }
    expect(external.length === 0, `external requests attempted: ${external.join(', ')}`);
    ws.close();
  } catch (e) {
    problems.push(`${width}px ${scenario}: ${e.message}`);
  } finally {
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await exited;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return { width, scenario, problems, log };
}

const results = [];
for (const width of [1440, 375]) for (const scenario of ['mood', 'error']) results.push(await session(width, scenario));
console.log(JSON.stringify(results.map(({ width, scenario, problems }) => ({ width, scenario, problems })), null, 1));
process.exit(results.some((r) => r.problems.length) ? 1 : 0);
