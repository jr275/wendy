/**
 * Wendy as an AG-UI agent for the CopilotKit frontend: HTTP transport + auth only.
 * The run itself lives in ./run.ts. Server-to-server: the Next.js runtime calls it with a shared
 * bearer token (WENDY_AGENT_TOKEN); the browser never reaches it and never talks to a model.
 *
 *   npm run agent   → http://127.0.0.1:3458/agui
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import { EventEncoder } from '@ag-ui/encoder';
import { createReasoner } from '../cognition/reasoner.js';
import { databaseUrl, loadEnv } from '../config.js';
import { createPool } from '../db/db.js';
import { DevMailboxProvider } from '../providers/devMailbox.js';
import { createContext } from '../runtime/context.js';
import { systemClock } from '../util/clock.js';
import { runWendyAgent } from './run.js';

loadEnv();
const PORT = Number(process.env.WENDY_AGENT_PORT ?? 3458);
const TOKEN = process.env.WENDY_AGENT_TOKEN ?? '';
const PRINCIPAL_EMAIL = (process.env.WENDY_PRINCIPAL_EMAIL ?? '').toLowerCase();
if (TOKEN.length < 24) {
  console.error('WENDY_AGENT_TOKEN missing or too short (.env)');
  process.exit(1);
}

const db = createPool(databaseUrl());
const ctx = createContext({ db, reasoner: createReasoner(db), clock: systemClock, emailProvider: new DevMailboxProvider(db) });

async function principalId(): Promise<string> {
  const r = (await db.query<{ id: string }>('SELECT id FROM principals WHERE primary_email = $1', [PRINCIPAL_EMAIL])).rows[0];
  if (!r) throw new Error(`principal ${PRINCIPAL_EMAIL || '(WENDY_PRINCIPAL_EMAIL unset)'} not found`);
  return r.id;
}

const authorized = (h: string | undefined) => {
  const got = Buffer.from(h ?? '');
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};

http
  .createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/agui')) {
      res.writeHead(404).end();
      return;
    }
    if (!authorized(req.headers.authorization)) {
      res.writeHead(401).end();
      return;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2_000_000) {
        res.writeHead(413).end();
        return;
      }
    }
    const parsed = RunAgentInputSchema.safeParse(JSON.parse(body || '{}'));
    if (!parsed.success) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid RunAgentInput' }));
      return;
    }
    const enc = new EventEncoder({ accept: req.headers.accept });
    res.writeHead(200, { 'Content-Type': enc.getContentType(), 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (e: BaseEvent) => res.write(enc.encode(e));
    try {
      await runWendyAgent({ ctx, db, principalId: await principalId() }, parsed.data as RunAgentInput, send);
    } catch (e) {
      console.error('[agent run error]', e);
      send({ type: EventType.RUN_ERROR, message: (e as Error).message } as BaseEvent);
    }
    res.end();
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Wendy AG-UI agent on http://127.0.0.1:${PORT}/agui (reasoner: ${process.env.WENDY_REASONER ?? 'claude'})`));
