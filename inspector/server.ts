/**
 * WENDY BRAIN INSPECTOR — read-only.
 * Shows exactly what the Cognitive Core persisted for each event: evidence, claims, salience,
 * actions, model calls, ledger. Every DB session is opened with default_transaction_read_only=on,
 * so this server cannot change Wendy's state. Not the product UI.
 *
 *   npm run inspector            → http://127.0.0.1:3457
 *   INSPECT_DATABASE_URL=postgres:///wendy_test npm run inspector   (e.g. a kept live-test schema)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { verifyLedgerIntegrity } from '../src/audit/ledger.js';
import { loadEnv } from '../src/config.js';
import '../src/db/db.js'; // registers pg type parsers
import { activity, actionsList, insightDetail, modelCalls, ontology, people, principals, today } from './views.js';

loadEnv();
const DB_URL = process.env.INSPECT_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres:///wendy';
const PORT = Number(process.env.INSPECT_PORT ?? 3457);
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
const TECH_PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'technical.html');
const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

const pools = new Map<string, pg.Pool>();
function poolFor(schema: string | null): pg.Pool {
  const key = schema ?? '';
  let p = pools.get(key);
  if (!p) {
    const options = ['-c default_transaction_read_only=on', ...(schema ? [`-c search_path=${schema}`] : [])].join(' ');
    p = new pg.Pool({ connectionString: DB_URL, max: 4, options });
    pools.set(key, p);
  }
  return p;
}

async function listSchemas() {
  const rows = (
    await poolFor(null).query<{ schema: string }>(
      `SELECT table_schema AS schema FROM information_schema.tables WHERE table_name = 'insights' ORDER BY table_schema`,
    )
  ).rows;
  const out = [];
  for (const { schema } of rows) {
    if (!SCHEMA_RE.test(schema)) continue;
    const db = poolFor(schema);
    const c = (
      await db.query(`SELECT
        (SELECT count(*) FROM events)::int AS events,
        (SELECT count(*) FROM insights)::int AS insights,
        (SELECT count(*) FROM model_calls WHERE model = 'TEST_DOUBLE')::int AS test_double_calls,
        (SELECT count(*) FROM model_calls WHERE model <> 'TEST_DOUBLE')::int AS real_calls`)
    ).rows[0];
    out.push({ schema, ...c });
  }
  return out;
}

async function schemaGuard(schema: string | null): Promise<string> {
  if (!schema || !SCHEMA_RE.test(schema)) throw Object.assign(new Error('invalid schema'), { status: 400 });
  const known = (await listSchemas()).map((s) => s.schema);
  if (!known.includes(schema)) throw Object.assign(new Error('unknown schema'), { status: 404 });
  return schema;
}

async function overview(db: pg.Pool) {
  const principals = (await db.query('SELECT id, display_name, primary_email, timezone, locale FROM principals ORDER BY created_at')).rows;
  const events = (
    await db.query(`
      SELECT e.id, e.principal_id, e.event_type, e.source, e.occurred_at, e.received_at, e.processing_status, e.processing_attempts, e.last_error,
             e.provenance, i.id AS insight_id, i.status AS insight_status, i.headline, (i.salience->>'score')::float AS score,
             EXISTS (SELECT 1 FROM model_calls mc WHERE mc.id = ANY(i.model_call_ids) AND mc.model = 'TEST_DOUBLE') AS test_double
      FROM events e LEFT JOIN insights i ON i.event_id = e.id
      ORDER BY e.received_at DESC LIMIT 300`)
  ).rows;
  return { principals, events };
}

const SUMMARY_SQL: Record<string, string> = {
  person: `SELECT id, full_name AS title, concat_ws(' · ', title, CASE WHEN birthdate IS NOT NULL THEN 'nasc. ' || birthdate END, 'fonte: ' || source) AS detail FROM people WHERE id = ANY($1::uuid[])`,
  message: `SELECT id, subject AS title, concat_ws(' · ', direction, from_address, to_char(sent_at, 'YYYY-MM-DD HH24:MI')) AS detail, left(body, 600) AS body FROM messages WHERE id = ANY($1::uuid[])`,
  meeting: `SELECT id, title, concat_ws(' · ', status, to_char(starts_at, 'YYYY-MM-DD HH24:MI')) AS detail FROM meetings WHERE id = ANY($1::uuid[])`,
  commitment: `SELECT id, description AS title, concat_ws(' · ', owner, status, 'vence ' || to_char(due_at, 'YYYY-MM-DD HH24:MI')) AS detail FROM commitments WHERE id = ANY($1::uuid[])`,
  memory: `SELECT id, content AS title, concat_ws(' · ', kind, 'por ' || written_by, status, 'conf ' || confidence) AS detail FROM memories WHERE id = ANY($1::uuid[])`,
  event: `SELECT id, event_type AS title, to_char(occurred_at, 'YYYY-MM-DD HH24:MI') AS detail FROM events WHERE id = ANY($1::uuid[])`,
  insight: `SELECT id, coalesce(headline, '(sem headline)') AS title, status AS detail FROM insights WHERE id = ANY($1::uuid[])`,
  relationship: `SELECT id, kind AS title, 'importância ' || coalesce(explicit_importance::text, 'não definida') AS detail FROM relationships WHERE id = ANY($1::uuid[])`,
};

async function resolveRefs(db: pg.Pool, refs: { kind: string; id: string }[]) {
  const byKind = new Map<string, string[]>();
  for (const r of refs) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.id]);
  const out: Record<string, unknown> = {};
  for (const [kind, ids] of byKind) {
    const sql = SUMMARY_SQL[kind];
    if (!sql) continue;
    for (const row of (await db.query(sql, [ids])).rows) out[`${kind}:${row.id}`] = { kind, ...row };
  }
  return out;
}

async function eventDetail(db: pg.Pool, id: string) {
  const event = (await db.query('SELECT * FROM events WHERE id = $1', [id])).rows[0];
  if (!event) throw Object.assign(new Error('event not found'), { status: 404 });
  const insight = (await db.query('SELECT * FROM insights WHERE event_id = $1', [id])).rows[0] ?? null;
  let claims: unknown[] = [];
  let actions: unknown[] = [];
  let calls: unknown[] = [];
  let records: Record<string, unknown> = {};
  let memoriesWritten: unknown[] = [];
  if (insight) {
    claims = (await db.query('SELECT ordinal, label, kind, statement, confidence, evidence, derived_from, produced_by, validation_status, validation_errors FROM claims WHERE insight_id = $1 ORDER BY ordinal', [insight.id])).rows;
    actions = (
      await db.query(
        `SELECT a.id, a.action_type, a.state, a.authorization_level, a.policy_decision, a.expires_at, a.rejection_reason, a.failure, a.created_at,
                (SELECT json_agg(json_build_object('version', v.version, 'author', v.author, 'content', v.content, 'created_at', v.created_at) ORDER BY v.version) FROM action_versions v WHERE v.action_id = a.id) AS versions,
                (SELECT json_agg(json_build_object('from', t.from_state, 'to', t.to_state, 'actor', t.actor, 'reason', t.reason, 'at', t.at) ORDER BY t.id) FROM action_transitions t WHERE t.action_id = a.id) AS transitions,
                (SELECT row_to_json(x) FROM (SELECT provider, status, attempts, idempotency_key, provider_ref, verification, last_error FROM action_executions WHERE action_id = a.id) x) AS execution
         FROM actions a WHERE a.insight_id = $1 ORDER BY a.created_at`,
        [insight.id],
      )
    ).rows;
    calls = (
      await db.query(
        `SELECT id, purpose, model, served_by_model, api_message_id, stop_reason, usage, error, started_at, finished_at, jsonb_array_length(input_evidence_refs) AS evidence_sent
         FROM model_calls WHERE id = ANY($1::uuid[]) ORDER BY started_at`,
        [insight.model_call_ids],
      )
    ).rows;
    records = await resolveRefs(db, Object.values(insight.evidence_map as Record<string, { kind: string; id: string }>));
    memoriesWritten = (
      await db.query(`SELECT id, kind, content, confidence, evidence FROM memories WHERE evidence @> $1::jsonb AND written_by = 'WENDY'`, [JSON.stringify([{ kind: 'event', id }])])
    ).rows;
  }
  return { event, insight, claims, actions, calls, records, memoriesWritten };
}

async function modelCall(db: pg.Pool, id: string) {
  const row = (await db.query('SELECT id, purpose, model, served_by_model, api_message_id, input, output, input_evidence_refs, usage, error FROM model_calls WHERE id = $1', [id])).rows[0];
  if (!row) throw Object.assign(new Error('model call not found'), { status: 404 });
  return row;
}

async function ledger(db: pg.Pool) {
  const integrity = await verifyLedgerIntegrity(db);
  const blocks = (await db.query('SELECT seq, at, event_type, actor, subject_type, subject_id, hash FROM audit_blocks ORDER BY seq DESC LIMIT 200')).rows;
  return { integrity, blocks };
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const UUID_RE = /^[0-9a-f-]{36}$/;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method !== 'GET') return send(res, 405, { error: 'read-only' });
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(PAGE));
      }
      if (url.pathname === '/tecnico') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(TECH_PAGE));
      }
      if (url.pathname === '/api/schemas') return send(res, 200, { database: DB_URL.replace(/\/\/[^@]*@/, '//'), schemas: await listSchemas() });
      const schema = await schemaGuard(url.searchParams.get('schema'));
      const db = poolFor(schema);
      const id = url.searchParams.get('id') ?? '';
      const principal = url.searchParams.get('principal');
      if (principal && !UUID_RE.test(principal)) return send(res, 400, { error: 'invalid principal' });
      if (url.pathname === '/api/overview') return send(res, 200, await overview(db));
      if (url.pathname === '/api/principals') return send(res, 200, await principals(db));
      if (url.pathname === '/api/today') return send(res, 200, await today(db, principal));
      if (url.pathname === '/api/actions') return send(res, 200, await actionsList(db, principal));
      if (url.pathname === '/api/activity') return send(res, 200, await activity(db, principal));
      if (url.pathname === '/api/people') return send(res, 200, await people(db, principal));
      if (url.pathname === '/api/model-calls') return send(res, 200, await modelCalls(db, principal));
      if (url.pathname === '/api/ontology') return send(res, 200, await ontology(db, principal));
      if (url.pathname === '/api/ledger') return send(res, 200, await ledger(db));
      if (!UUID_RE.test(id)) return send(res, 400, { error: 'invalid id' });
      if (url.pathname === '/api/event') return send(res, 200, await eventDetail(db, id));
      if (url.pathname === '/api/model-call') return send(res, 200, await modelCall(db, id));
      if (url.pathname === '/api/insight') return send(res, 200, await insightDetail(db, id));
      send(res, 404, { error: 'not found' });
    } catch (err) {
      const e = err as Error & { status?: number };
      send(res, e.status ?? 500, { error: e.message });
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Wendy brain inspector (read-only) on http://127.0.0.1:${PORT} — database ${DB_URL}`));
