/**
 * Read-only view models for the Wendy UI. Every number shown in the UI comes from one of these
 * queries over persisted state — nothing is computed for display that the core did not record.
 */
import type pg from 'pg';
import { inSearchScope, outOfScopeInsightIds } from '../src/sensors/searchScope.js';

const HOUR = 3_600_000;

export async function principals(db: pg.Pool) {
  return (await db.query('SELECT id, display_name, primary_email, timezone, locale FROM principals ORDER BY created_at')).rows;
}

async function resolvePrincipal(db: pg.Pool, principalId: string | null): Promise<string | null> {
  if (principalId) return principalId;
  return (await db.query<{ id: string }>('SELECT id FROM principals ORDER BY created_at LIMIT 1')).rows[0]?.id ?? null;
}

/** One insight as a card: headline, narrative, score, tags, top evidence, action counts. */
const INSIGHT_CARD_SQL = `
  SELECT i.id, i.event_id, i.status, i.headline, i.narrative, i.created_at,
         (i.salience->>'score')::float AS score, i.salience->'explanation' AS explanation,
         e.event_type, e.provenance->>'origin' AS origin,
         EXISTS (SELECT 1 FROM model_calls mc WHERE mc.id = ANY(i.model_call_ids) AND mc.model = 'TEST_DOUBLE') AS test_double,
         (SELECT min(mc.model) FROM model_calls mc WHERE mc.id = ANY(i.model_call_ids) AND mc.model <> 'TEST_DOUBLE' AND mc.model NOT LIKE 'claude-%') AS other_model,
         (SELECT json_agg(json_build_object('kind', c.kind, 'label', c.label, 'statement', c.statement, 'confidence', c.confidence) ORDER BY c.ordinal)
            FROM claims c WHERE c.insight_id = i.id AND c.validation_status = 'VALID' AND c.produced_by = 'CLAUDE') AS claims,
         (SELECT json_agg(json_build_object('handle', h.key, 'kind', h.value->>'kind', 'id', h.value->>'id'))
            FROM jsonb_each(i.evidence_map) h
            WHERE EXISTS (SELECT 1 FROM claims c, jsonb_array_elements(c.evidence) ev
                          WHERE c.insight_id = i.id AND c.validation_status = 'VALID' AND ev->>'handle' = h.key)) AS cited,
         (SELECT json_agg(json_build_object('id', a.id, 'type', a.action_type, 'state', a.state)) FROM actions a WHERE a.insight_id = i.id) AS actions,
         (SELECT count(*) FROM claims c WHERE c.insight_id = i.id AND c.validation_status = 'REJECTED')::int AS rejected_claims
  FROM insights i JOIN events e ON e.id = i.event_id`;

const LABEL_SQL: Record<string, string> = {
  search_metric: `SELECT m.id, concat('Search Console · ', wp.label, ' · ', CASE m.dimension WHEN 'total' THEN 'site todo' ELSE m.dimension || ' ' || m.key END, ' · ', to_char(m.window_start,'DD/MM'), '–', to_char(m.window_end,'DD/MM'), ': ', round(m.clicks::numeric), ' cliques') AS label
                  FROM search_metric_windows m JOIN web_properties wp ON wp.id = m.property_id WHERE m.id = ANY($1::uuid[])`,
  person: `SELECT id, full_name AS label FROM people WHERE id = ANY($1::uuid[])`,
  message: `SELECT m.id, concat_ws(' · ', CASE WHEN m.direction = 'OUTBOUND' THEN 'E-mail seu' ELSE 'E-mail de ' || coalesce(p.full_name, m.from_address) END,
                    to_char(m.sent_at, 'DD/MM'), m.subject) AS label
            FROM messages m LEFT JOIN message_participants mp ON mp.message_id = m.id AND mp.role = 'FROM' LEFT JOIN people p ON p.id = mp.person_id
            WHERE m.id = ANY($1::uuid[])`,
  meeting: `SELECT id, concat_ws(' · ', 'Reunião ' || title, to_char(starts_at, 'DD/MM HH24:MI'), CASE WHEN status = 'CANCELLED' THEN 'cancelada' END) AS label FROM meetings WHERE id = ANY($1::uuid[])`,
  commitment: `SELECT id, concat_ws(' · ', 'Compromisso: ' || description, 'vence ' || to_char(due_at, 'DD/MM HH24:MI'), CASE status WHEN 'OPEN' THEN 'aberto' WHEN 'DONE' THEN 'concluído' ELSE 'cancelado' END) AS label FROM commitments WHERE id = ANY($1::uuid[])`,
  memory: `SELECT id, 'Memória: ' || content AS label FROM memories WHERE id = ANY($1::uuid[])`,
  event: `SELECT id, CASE event_type WHEN 'EMAIL_RECEIVED' THEN 'E-mail recebido' WHEN 'COMMITMENT_DUE' THEN 'Compromisso vencendo (detectado)' WHEN 'PERSON_DATE_APPROACHING' THEN 'Data pessoal chegando (detectada)' WHEN 'PRINCIPAL_NOTE' THEN 'Nota sua' ELSE event_type END
              || ' · ' || to_char(occurred_at, 'DD/MM HH24:MI') AS label FROM events WHERE id = ANY($1::uuid[])`,
  insight: `SELECT id, 'Insight anterior: ' || coalesce(headline, '—') AS label FROM insights WHERE id = ANY($1::uuid[])`,
  relationship: `SELECT id, 'Relação: ' || kind AS label FROM relationships WHERE id = ANY($1::uuid[])`,
};

/** Human labels (pt-BR) for a set of evidence references, keyed "kind:id". */
export async function evidenceLabels(db: pg.Pool, refs: { kind: string; id: string }[]): Promise<Record<string, string>> {
  const byKind = new Map<string, Set<string>>();
  for (const r of refs) byKind.set(r.kind, (byKind.get(r.kind) ?? new Set()).add(r.id));
  const out: Record<string, string> = {};
  for (const [kind, ids] of byKind) {
    const sql = LABEL_SQL[kind];
    if (!sql) continue;
    for (const row of (await db.query<{ id: string; label: string }>(sql, [[...ids]])).rows) out[`${kind}:${row.id}`] = row.label;
  }
  return out;
}

/** Attaches a human label to each cited evidence reference. */
async function labelEvidence(db: pg.Pool, rows: { cited: { handle: string; kind: string; id: string }[] | null }[]) {
  const labels = await evidenceLabels(db, rows.flatMap((r) => r.cited ?? []));
  for (const r of rows) for (const c of r.cited ?? []) (c as Record<string, unknown>).label = labels[`${c.kind}:${c.id}`] ?? null;
}

export async function today(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  if (!pid) return { principal: null };
  const principal = (await db.query('SELECT id, display_name, timezone, locale FROM principals WHERE id = $1', [pid])).rows[0];
  const since = new Date(Date.now() - 24 * HOUR);
  const in48h = new Date(Date.now() + 48 * HOUR);
  const kpis = (
    await db.query(
      `SELECT
        (SELECT count(*) FROM insights WHERE principal_id = $1 AND status = 'SURFACED' AND created_at >= $2)::int AS surfaced_24h,
        (SELECT count(*) FROM actions WHERE principal_id = $1 AND state = 'AWAITING_APPROVAL')::int AS awaiting,
        (SELECT count(*) FROM commitments WHERE principal_id = $1 AND status = 'OPEN' AND due_at <= $3)::int AS commitments_48h,
        (SELECT count(*) FROM events WHERE principal_id = $1 AND processing_status IN ('PROCESSED','SKIPPED') AND received_at >= $2)::int AS events_24h,
        (SELECT count(*) FROM events WHERE principal_id = $1 AND processing_status = 'FAILED')::int AS events_failed,
        (SELECT count(*) FROM insights WHERE principal_id = $1)::int AS insights_total,
        (SELECT count(*) FROM actions WHERE principal_id = $1 AND policy_decision->>'mode' = 'AUTO' AND state IN ('EXECUTED','VERIFIED'))::int AS auto_actioned`,
      [pid, since, in48h],
    )
  ).rows[0];
  const outOfScope = await outOfScopeInsightIds(db, pid); // insights about Search Console properties the principal chose not to consider
  const insights = (await db.query(`${INSIGHT_CARD_SQL} WHERE i.principal_id = $1 ORDER BY (i.salience->>'score')::float DESC, i.created_at DESC LIMIT 100`, [pid])).rows.filter((i: { id: string }) => !outOfScope.has(i.id));
  await labelEvidence(db, insights);
  const prepared = (
    await db.query(
      `SELECT a.id, a.action_type, a.state, a.insight_id, v.content->>'title' AS title, v.content->>'subject' AS subject
       FROM actions a JOIN action_versions v ON v.action_id = a.id AND v.version = a.current_version
       WHERE a.principal_id = $1 AND a.state IN ('VERIFIED','EXECUTED') ORDER BY a.updated_at DESC LIMIT 6`,
      [pid],
    )
  ).rows;
  const needsYou = (
    await db.query(
      `SELECT a.id, a.action_type, a.state, a.insight_id, a.expires_at, v.content->>'subject' AS subject, v.content->'to' AS recipients
       FROM actions a JOIN action_versions v ON v.action_id = a.id AND v.version = a.current_version
       WHERE a.principal_id = $1 AND a.state = 'AWAITING_APPROVAL' ORDER BY a.expires_at NULLS LAST LIMIT 6`,
      [pid],
    )
  ).rows;
  const pendingMemories = (
    await db.query(
      `SELECT m.id, m.content, m.subject_person_id, p.full_name FROM memories m LEFT JOIN people p ON p.id = m.subject_person_id
       WHERE m.principal_id = $1 AND m.status = 'PROPOSED' ORDER BY m.created_at DESC LIMIT 6`,
      [pid],
    )
  ).rows;
  const { memoryFreshness } = await import('../src/memory/freshness.js');
  const toReview = (
    await db.query(
      `SELECT m.id, m.kind, m.status, m.content, m.created_at, m.last_confirmed_at, m.subject_person_id, p.full_name FROM memories m LEFT JOIN people p ON p.id = m.subject_person_id
       WHERE m.principal_id = $1 AND m.status = 'ACTIVE' AND m.kind IN ('PREFERENCE','FACT') ORDER BY coalesce(m.last_confirmed_at, m.created_at) LIMIT 50`,
      [pid],
    )
  ).rows
    .map((m) => ({ ...m, freshness: memoryFreshness(m, new Date()) }))
    .filter((m) => m.freshness.needsReview)
    .slice(0, 4);
  const openConflicts = Number((await db.query(`SELECT count(*) n FROM memory_conflicts WHERE principal_id = $1 AND status = 'OPEN'`, [pid])).rows[0].n);
  const pendingCommitments = (
    await db.query(
      `SELECT c.id, c.description, c.due_at, c.counterparty_person_id, p.full_name FROM commitments c JOIN people p ON p.id = c.counterparty_person_id
       WHERE c.principal_id = $1 AND c.status = 'PROPOSED' ORDER BY c.due_at LIMIT 6`,
      [pid],
    )
  ).rows;
  const pendingMemoryCount = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM memories WHERE principal_id = $1 AND status = 'PROPOSED'`, [pid])).rows[0]!.n;
  return { principal, kpis, insights, prepared, needsYou, pendingMemories, pendingMemoryCount, openConflicts, pendingCommitments, memoriesToReview: toReview };
}

export async function insightDetail(db: pg.Pool, id: string) {
  const insight = (await db.query('SELECT * FROM insights WHERE id = $1', [id])).rows[0];
  if (!insight) throw Object.assign(new Error('insight not found'), { status: 404 });
  const event = (await db.query('SELECT id, event_type, source, occurred_at, received_at, payload, provenance FROM events WHERE id = $1', [insight.event_id])).rows[0];
  const claims = (
    await db.query('SELECT ordinal, label, kind, statement, confidence, evidence, derived_from, produced_by, validation_status, validation_errors FROM claims WHERE insight_id = $1 ORDER BY ordinal', [id])
  ).rows;
  const actions = (
    await db.query(
      `SELECT a.id, a.action_type, a.state, a.authorization_level, a.policy_decision, a.expires_at, a.rejection_reason, a.failure, a.created_at, a.current_version,
              v.content, v.author,
              (SELECT row_to_json(x) FROM (SELECT provider, status, attempts, verification FROM action_executions WHERE action_id = a.id) x) AS execution,
              (SELECT json_agg(json_build_object('to', t.to_state, 'actor', t.actor, 'reason', t.reason, 'at', t.at) ORDER BY t.id) FROM action_transitions t WHERE t.action_id = a.id) AS transitions
       FROM actions a JOIN action_versions v ON v.action_id = a.id AND v.version = a.current_version
       WHERE a.insight_id = $1 ORDER BY a.created_at`,
      [id],
    )
  ).rows;
  const calls = (
    await db.query(`SELECT id, purpose, model, served_by_model, api_message_id, usage, error FROM model_calls WHERE id = ANY($1::uuid[]) ORDER BY started_at`, [insight.model_call_ids])
  ).rows;
  const memoriesWritten = (
    await db.query(`SELECT id, kind, content, confidence FROM memories WHERE evidence @> $1::jsonb AND written_by = 'WENDY'`, [JSON.stringify([{ kind: 'event', id: insight.event_id }])])
  ).rows;
  const labels = await evidenceLabels(db, claims.flatMap((c: { evidence: { kind: string; id: string }[] }) => c.evidence));
  return { insight, event, claims, actions, calls, memoriesWritten, labels };
}

export async function actionsList(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  return (
    await db.query(
      `SELECT a.id, a.action_type, a.state, a.insight_id, a.authorization_level, a.created_at, a.updated_at, a.expires_at,
              v.content->>'title' AS title, v.content->>'subject' AS subject, v.content->'to' AS recipients, v.author,
              p.full_name AS target, i.headline AS insight_headline,
              (SELECT verification FROM action_executions WHERE action_id = a.id) AS verification
       FROM actions a JOIN action_versions v ON v.action_id = a.id AND v.version = a.current_version
       LEFT JOIN people p ON p.id = a.target_person_id LEFT JOIN insights i ON i.id = a.insight_id
       WHERE a.principal_id = $1 ORDER BY a.created_at DESC LIMIT 300`,
      [pid],
    )
  ).rows;
}

export async function activity(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  return (
    await db.query(
      `SELECT e.id, e.event_type, e.source, e.occurred_at, e.received_at, e.processing_status, e.processing_attempts, e.last_error,
              e.provenance->>'origin' AS origin, i.id AS insight_id, i.status AS insight_status, i.headline, (i.salience->>'score')::float AS score
       FROM events e LEFT JOIN insights i ON i.event_id = e.id
       WHERE e.principal_id = $1 ORDER BY e.received_at DESC LIMIT 300`,
      [pid],
    )
  ).rows;
}

export async function people(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  const rows = (
    await db.query(
      `SELECT p.id, p.full_name, p.title, p.birthdate, p.source, o.name AS organization,
              r.kind AS relationship, r.explicit_importance,
              (SELECT string_agg(value, ', ') FROM person_identifiers WHERE person_id = p.id AND kind = 'email') AS emails,
              (SELECT count(DISTINCT mp.message_id) FROM message_participants mp JOIN messages m ON m.id = mp.message_id
                 WHERE mp.person_id = p.id AND m.sent_at >= now() - interval '90 days')::int AS interactions_90d,
              (SELECT max(m.sent_at) FROM message_participants mp JOIN messages m ON m.id = mp.message_id WHERE mp.person_id = p.id) AS last_interaction,
              (SELECT count(*) FROM commitments c WHERE c.counterparty_person_id = p.id AND c.status = 'OPEN')::int AS open_commitments
       FROM people p LEFT JOIN organizations o ON o.id = p.organization_id LEFT JOIN relationships r ON r.person_id = p.id AND r.principal_id = p.principal_id
       WHERE p.principal_id = $1 ORDER BY r.explicit_importance DESC NULLS LAST, p.full_name`,
      [pid],
    )
  ).rows;
  const memories = (
    await db.query(
      `SELECT m.id, m.kind, m.subject_person_id, m.content, m.confidence, m.status, m.written_by, m.created_at, m.last_confirmed_at, m.evidence
       FROM memories m WHERE m.principal_id = $1 ORDER BY m.created_at DESC LIMIT 500`,
      [pid],
    )
  ).rows;
  const { memoryFreshness } = await import('../src/memory/freshness.js');
  for (const m of memories) m.freshness = memoryFreshness(m, new Date());
  const { relationshipMetrics } = await import('../src/people/relationshipMetrics.js');
  const now = new Date();
  for (const r of rows) r.metrics = await relationshipMetrics(db, pid!, r.id, now);
  const conflicts = (
    await db.query(
      `SELECT c.id, c.description, c.detected_at, c.source,
              (SELECT json_agg(json_build_object('id', m.id, 'content', m.content, 'status', m.status, 'kind', m.kind, 'written_by', m.written_by, 'subject_person_id', m.subject_person_id) ORDER BY m.created_at)
                 FROM memories m WHERE m.id = ANY(c.memory_ids)) AS memories
       FROM memory_conflicts c WHERE c.principal_id = $1 AND c.status = 'OPEN' ORDER BY c.detected_at DESC`,
      [pid],
    )
  ).rows;
  const commitments = (
    await db.query(
      `SELECT c.id, c.owner, c.counterparty_person_id, c.description, c.due_at, c.status, c.source, c.source_quote, c.created_at, c.completed_at,
              m.subject AS source_subject, m.sent_at AS source_sent_at
       FROM commitments c LEFT JOIN messages m ON m.id = c.source_message_id
       WHERE c.principal_id = $1 AND (c.status IN ('PROPOSED','OPEN') OR coalesce(c.status_changed_at, c.completed_at, c.created_at) >= now() - interval '30 days')
       ORDER BY CASE c.status WHEN 'PROPOSED' THEN 0 WHEN 'OPEN' THEN 1 ELSE 2 END, c.due_at`,
      [pid],
    )
  ).rows;
  return { people: rows, memories, conflicts, commitments };
}

export async function modelCalls(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  return (
    await db.query(
      `SELECT id, purpose, model, served_by_model, api_message_id, stop_reason, usage, error, started_at, finished_at, jsonb_array_length(input_evidence_refs) AS evidence_sent
       FROM model_calls WHERE principal_id = $1 ORDER BY started_at DESC LIMIT 200`,
      [pid],
    )
  ).rows;
}

/**
 * The executive's world as a graph, straight from persisted records: objects (people, organizations,
 * meetings, commitments, memories, insights) and typed links between them. Messages are aggregated
 * into weighted links instead of being drawn one by one.
 */
const REL_PT: Record<string, string> = { INVESTOR: 'investidor', CLIENT: 'cliente', KEY_CLIENT: 'cliente-chave', COLLEAGUE: 'colega', PARTNER: 'parceiro', FRIEND: 'amigo', FAMILY: 'família' };

export async function ontology(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  if (!pid) return { nodes: [], edges: [] };
  type Node = { id: string; type: string; label: string; props: Record<string, unknown> };
  type Edge = { source: string; target: string; label: string; weight?: number };
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const principal = (await db.query('SELECT id, display_name, primary_email, timezone, locale FROM principals WHERE id = $1', [pid])).rows[0];
  nodes.push({ id: `principal:${pid}`, type: 'principal', label: principal.display_name, props: { 'e-mail': principal.primary_email, fuso: principal.timezone, idioma: principal.locale } });

  const orgs = (await db.query('SELECT id, name, domain, source FROM organizations WHERE principal_id = $1', [pid])).rows;
  for (const o of orgs) nodes.push({ id: `organization:${o.id}`, type: 'organization', label: o.name, props: { domínio: o.domain, fonte: o.source } });

  const ppl = await people(db, pid);
  for (const p of ppl.people) {
    nodes.push({
      id: `person:${p.id}`,
      type: 'person',
      label: p.full_name,
      props: {
        cargo: p.title,
        relação: p.relationship ? (REL_PT[p.relationship] ?? p.relationship) : null,
        importância: p.explicit_importance,
        'interações 90d': p.interactions_90d,
        'última interação': p.last_interaction,
        aniversário: p.birthdate,
        'compromissos abertos': p.open_commitments,
        fonte: p.source,
      },
    });
    if (p.relationship) edges.push({ source: `principal:${pid}`, target: `person:${p.id}`, label: REL_PT[p.relationship] ?? String(p.relationship).toLowerCase().replace(/_/g, ' ') });
    const org = orgs.find((o) => o.name === p.organization);
    if (org) edges.push({ source: `person:${p.id}`, target: `organization:${org.id}`, label: 'trabalha em' });
    if (p.interactions_90d > 0) edges.push({ source: `person:${p.id}`, target: `principal:${pid}`, label: `${p.interactions_90d} ${p.interactions_90d === 1 ? 'e-mail' : 'e-mails'}`, weight: p.interactions_90d });
  }

  const meetings = (
    await db.query(
      `SELECT m.id, m.title, m.starts_at, m.status,
              (SELECT json_agg(a.person_id) FROM meeting_attendees a WHERE a.meeting_id = m.id AND a.person_id IS NOT NULL) AS people
       FROM meetings m WHERE m.principal_id = $1 AND m.starts_at >= now() - interval '30 days' ORDER BY m.starts_at LIMIT 60`,
      [pid],
    )
  ).rows;
  for (const m of meetings) {
    nodes.push({ id: `meeting:${m.id}`, type: 'meeting', label: m.title, props: { início: m.starts_at, status: m.status } });
    edges.push({ source: `principal:${pid}`, target: `meeting:${m.id}`, label: 'participa de' });
    for (const person of m.people ?? []) edges.push({ source: `person:${person}`, target: `meeting:${m.id}`, label: 'participa de' });
  }

  const commitments = (
    await db.query(`SELECT id, owner, counterparty_person_id, description, due_at, status FROM commitments WHERE principal_id = $1 AND (status = 'OPEN' OR due_at >= now() - interval '14 days')`, [pid])
  ).rows;
  for (const c of commitments) {
    nodes.push({ id: `commitment:${c.id}`, type: 'commitment', label: c.description, props: { vence: c.due_at, status: c.status, devedor: c.owner === 'PRINCIPAL' ? principal.display_name : 'contraparte' } });
    edges.push({ source: c.owner === 'PRINCIPAL' ? `principal:${pid}` : `person:${c.counterparty_person_id}`, target: `commitment:${c.id}`, label: 'deve' });
    edges.push({ source: `commitment:${c.id}`, target: c.owner === 'PRINCIPAL' ? `person:${c.counterparty_person_id}` : `principal:${pid}`, label: 'a' });
  }

  for (const m of ppl.memories.filter((x: { status: string; kind: string }) => x.status === 'ACTIVE' && x.kind !== 'OUTCOME').slice(0, 60)) {
    nodes.push({ id: `memory:${m.id}`, type: 'memory', label: m.content, props: { tipo: m.kind, 'escrita por': m.written_by, confiança: m.confidence, criada: m.created_at } });
    edges.push({ source: `memory:${m.id}`, target: m.subject_person_id ? `person:${m.subject_person_id}` : `principal:${pid}`, label: 'lembra' });
  }

  const insights = (
    await db.query(
      `SELECT i.id, i.headline, i.status, (i.salience->>'score')::float AS score, i.created_at,
              (SELECT json_agg(DISTINCT ev->>'id') FROM claims c, jsonb_array_elements(c.evidence) ev
                WHERE c.insight_id = i.id AND c.validation_status = 'VALID' AND ev->>'kind' = 'person') AS people
       FROM insights i WHERE i.principal_id = $1 AND i.status = 'SURFACED' ORDER BY i.created_at DESC LIMIT 20`,
      [pid],
    )
  ).rows;
  for (const i of insights) {
    nodes.push({ id: `insight:${i.id}`, type: 'insight', label: i.headline ?? 'insight', props: { prioridade: i.score, criado: i.created_at } });
    for (const person of i.people ?? []) edges.push({ source: `insight:${i.id}`, target: `person:${person}`, label: 'sobre' });
  }

  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
}

/** Current configuration as the core actually applies it (read from code constants and the database). */
export async function configuration(db: pg.Pool, principalIdParam: string | null) {
  const { ACTION_CATALOG, actionSpec, decidePolicy } = await import('../src/actions/actions.js');
  const { TOOL_SPECS } = await import('../src/tools/specs.js');
  const { DETECTOR_CONFIG } = await import('../src/cognition/detectors.js');
  const { SALIENCE_WEIGHTS, SURFACE_THRESHOLD, MODELS } = await import('../src/config.js');
  const pid = await resolvePrincipal(db, principalIdParam);
  const principal = pid ? (await db.query('SELECT id, display_name, primary_email, timezone, locale FROM principals WHERE id = $1', [pid])).rows[0] : null;
  const important = pid
    ? (
        await db.query(
          `SELECT p.full_name, r.kind, r.explicit_importance FROM relationships r JOIN people p ON p.id = r.person_id
           WHERE r.principal_id = $1 ORDER BY r.explicit_importance DESC NULLS LAST, p.full_name`,
          [pid],
        )
      ).rows
    : [];
  const { policyOverride } = await import('../src/actions/actions.js');
  const policy = [];
  // Built-in actions plus every tool with an effect (read-only tools never need a policy).
  const types = [...Object.keys(ACTION_CATALOG), ...Object.keys(TOOL_SPECS).filter((t) => actionSpec(t))] as Parameters<typeof decidePolicy>[0][];
  for (const type of types) {
    const override = pid ? await policyOverride(db, pid, type) : null;
    policy.push({ type, ...actionSpec(type)!, override, default: decidePolicy(type), decision: decidePolicy(type, override) });
  }
  return { principal, important, policy, detectors: DETECTOR_CONFIG, salience: { threshold: SURFACE_THRESHOLD, weights: SALIENCE_WEIGHTS }, model: MODELS.reasoning };
}

/** Where the data came from: counts per provider and the latest import summary (no content). */
export async function sources(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  if (!pid) return { messages: [], meetings: [], lastImport: null, webProperties: [] };
  const messages = (await db.query(`SELECT provider, count(*)::int AS n, max(sent_at) AS latest FROM messages WHERE principal_id = $1 GROUP BY provider ORDER BY n DESC`, [pid])).rows;
  const meetings = (await db.query(`SELECT provider, count(*)::int AS n FROM meetings WHERE principal_id = $1 GROUP BY provider ORDER BY n DESC`, [pid])).rows;
  const lastImport = (await db.query(`SELECT at, payload FROM audit_blocks WHERE principal_id = $1 AND event_type = 'IMPORT_COMPLETED' ORDER BY seq DESC LIMIT 1`, [pid])).rows[0] ?? null;
  const webProperties = (
    await db.query(
      `SELECT wp.label, wp.site_url, wp.explicit_importance, wp.last_synced_at,
              (SELECT count(*) FROM events e WHERE e.principal_id = wp.principal_id AND e.event_type = 'SEARCH_PERFORMANCE_CHANGE' AND e.payload->>'property_id' = wp.id::text)::int AS changes
       FROM web_properties wp WHERE wp.principal_id = $1 ORDER BY wp.label`,
      [pid],
    )
  ).rows.filter((p: { label: string; site_url: string }) => inSearchScope(p));
  return { messages, meetings, lastImport, webProperties };
}

/**
 * Radar: the next N days as facts only (meetings with who will be there and the state of each
 * relationship, commitments due or overdue, birthdays, approvals expiring). No interpretation —
 * anticipating what matters is the reasoning layer's job (Phase 3), not this view's.
 */
export async function radar(db: pg.Pool, principalIdParam: string | null, days = 7) {
  const { relationshipMetrics } = await import('../src/people/relationshipMetrics.js');
  const pid = await resolvePrincipal(db, principalIdParam);
  if (!pid) return { principal: null, items: [], overdue: [] };
  const principal = (await db.query('SELECT id, display_name, timezone, primary_email FROM principals WHERE id = $1', [pid])).rows[0];
  const tz: string = principal.timezone;
  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * HOUR);
  const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

  const personCtx = new Map<string, unknown>();
  async function person(personId: string) {
    if (!personCtx.has(personId)) {
      const p = (
        await db.query(
          `SELECT p.id, p.full_name, r.explicit_importance,
                  (SELECT count(*) FROM commitments c WHERE c.principal_id = $1 AND c.counterparty_person_id = p.id AND c.status = 'OPEN')::int AS open_commitments,
                  (SELECT count(*) FROM actions a WHERE a.principal_id = $1 AND a.target_person_id = p.id AND a.state = 'AWAITING_APPROVAL')::int AS awaiting_actions
           FROM people p LEFT JOIN relationships r ON r.person_id = p.id AND r.principal_id = p.principal_id WHERE p.principal_id = $1 AND p.id = $2`,
          [pid, personId],
        )
      ).rows[0];
      const m = await relationshipMetrics(db, pid!, personId, now);
      personCtx.set(personId, { ...p, daysSinceContact: m.daysSinceContact, messages90d: m.messages90d, trend: m.trend, principalReplyHoursMedian: m.principalReplyHoursMedian });
    }
    return personCtx.get(personId);
  }

  const items: { day: string; at: string; kind: string; [k: string]: unknown }[] = [];
  const meetings = (
    await db.query(
      `SELECT mt.id, mt.title, mt.starts_at, mt.ends_at, mt.status, mt.provider,
              (SELECT json_agg(json_build_object('address', a.address, 'person_id', a.person_id)) FROM meeting_attendees a WHERE a.meeting_id = mt.id) AS attendees
       FROM meetings mt WHERE mt.principal_id = $1 AND mt.status <> 'CANCELLED' AND mt.starts_at >= $2 AND mt.starts_at < $3 ORDER BY mt.starts_at`,
      [pid, now, end],
    )
  ).rows;
  for (const m of meetings) {
    const attendees = (m.attendees ?? []).filter((a: { address: string }) => a.address !== principal.primary_email);
    const people = [];
    for (const a of attendees) people.push(a.person_id ? await person(a.person_id) : { full_name: null, address: a.address });
    items.push({ day: dayKey(m.starts_at), at: m.starts_at.toISOString(), kind: 'meeting', id: m.id, title: m.title, ends_at: m.ends_at, status: m.status, people });
  }
  const commitments = (
    await db.query(
      `SELECT c.id, c.description, c.due_at, c.owner, c.counterparty_person_id, p.full_name FROM commitments c JOIN people p ON p.id = c.counterparty_person_id
       WHERE c.principal_id = $1 AND c.status = 'OPEN' AND c.due_at < $2 ORDER BY c.due_at`,
      [pid, end],
    )
  ).rows;
  const overdue = commitments.filter((c) => c.due_at < now);
  for (const c of commitments.filter((x) => x.due_at >= now)) items.push({ day: dayKey(c.due_at), at: c.due_at.toISOString(), kind: 'commitment', ...c });
  const actions = (
    await db.query(
      `SELECT a.id, a.action_type, a.expires_at, a.insight_id, p.full_name FROM actions a LEFT JOIN people p ON p.id = a.target_person_id
       WHERE a.principal_id = $1 AND a.state = 'AWAITING_APPROVAL' AND a.expires_at >= $2 AND a.expires_at < $3 ORDER BY a.expires_at`,
      [pid, now, end],
    )
  ).rows;
  for (const a of actions) items.push({ day: dayKey(a.expires_at), at: a.expires_at.toISOString(), kind: 'approval_expiring', ...a });

  // birthdays: next occurrence of month/day, in the principal's time zone (29 Feb → 28 Feb in common years)
  const today = dayKey(now);
  const [y] = today.split('-').map(Number) as [number];
  const isLeap = (yr: number) => (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0;
  const people = (await db.query(`SELECT id, full_name, birthdate FROM people WHERE principal_id = $1 AND birthdate IS NOT NULL`, [pid])).rows;
  const endKey = dayKey(end);
  for (const p of people) {
    const [, mo, d] = String(p.birthdate).split('-').map(Number) as [number, number, number];
    for (const yr of [y, y + 1]) {
      const dd = mo === 2 && d === 29 && !isLeap(yr) ? 28 : d;
      const key = `${yr}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      if (key >= today && key < endKey) {
        items.push({ day: key, at: `${key}T00:00:00`, kind: 'birthday', person: await person(p.id), turning: Number(String(p.birthdate).slice(0, 4)) ? yr - Number(String(p.birthdate).slice(0, 4)) : null });
        break;
      }
    }
  }
  items.sort((a, b) => (a.day === b.day ? a.at.localeCompare(b.at) : a.day.localeCompare(b.day)));
  return { principal, from: now.toISOString(), to: end.toISOString(), today, items, overdue };
}

/** Websites: daily clicks/impressions series, latest windows and detected changes (stored data only). */
export async function sites(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  if (!pid) return { sites: [] };
  const props = (await db.query(`SELECT id, label, site_url, explicit_importance, last_synced_at FROM web_properties WHERE principal_id = $1 ORDER BY label`, [pid])).rows.filter((p: { label: string; site_url: string }) => inSearchScope(p));
  const out = [];
  for (const p of props) {
    const daily = (await db.query(`SELECT to_char(date,'YYYY-MM-DD') AS date, clicks, impressions, ctr, position FROM search_daily_totals WHERE property_id = $1 ORDER BY date`, [p.id])).rows;
    const windows = (
      await db.query(
        `SELECT to_char(window_start,'YYYY-MM-DD') AS start, to_char(window_end,'YYYY-MM-DD') AS "end", clicks, impressions, ctr, position
         FROM search_metric_windows WHERE property_id = $1 AND dimension = 'total' ORDER BY window_end DESC LIMIT 2`,
        [p.id],
      )
    ).rows;
    const changes = (
      await db.query(
        `SELECT e.id AS event_id, e.payload->'change' AS change, i.id AS insight_id, i.status, i.headline, (i.salience->>'score')::float AS score
         FROM events e LEFT JOIN insights i ON i.event_id = e.id
         WHERE e.principal_id = $1 AND e.event_type = 'SEARCH_PERFORMANCE_CHANGE' AND e.payload->>'property_id' = $2
         ORDER BY e.received_at DESC LIMIT 20`,
        [pid, p.id],
      )
    ).rows;
    const cur = windows[0];
    const base = windows[1];
    const direction = cur && base ? (cur.clicks < base.clicks / 4 ? 'DROP' : 'RISE') : null;
    const { siteChangeContributors } = await import('../src/sensors/searchDetector.js');
    const movers = cur && base && direction ? (await siteChangeContributors(db, p.id, cur.end, base.end, direction, 5)).map(({ dimension, key, deltaClicks, deltaImpressions }) => ({ dimension, key, deltaClicks, deltaImpressions })) : [];
    const { topPages } = await import('../src/agent/siteCard.js');
    const pages = cur ? await topPages(db, p.id, cur.end, cur.clicks) : [];
    out.push({ ...p, daily, current: cur ?? null, baseline: base ?? null, direction, movers, changes, topPages: pages });
  }
  return { sites: out };
}

/** One skill run (with children) for the chat card; principal-scoped. */
export async function execution(db: pg.Pool, principalIdParam: string | null, id: string) {
  const pid = await resolvePrincipal(db, principalIdParam);
  if (!pid) return null;
  const { builtinRegistry } = await import('../src/skills/index.js');
  const { executionView } = await import('../src/skills/view.js');
  return executionView(db, builtinRegistry(), pid, id);
}

/** Latest skill runs of the principal (the concierge desk's active / recent tasks). */
export async function executions(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  if (!pid) return { executions: [] };
  const { builtinRegistry } = await import('../src/skills/index.js');
  const { recentExecutions } = await import('../src/skills/view.js');
  return { executions: await recentExecutions(db, builtinRegistry(), pid) };
}

/** Open tasks of the principal. */
export async function tasks(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  if (!pid) return { tasks: [] };
  const { listTasks } = await import('../src/tasks/taskService.js');
  return { tasks: await listTasks(db, pid) };
}

/** The continuous conversation with Wendy (restored by the chat on load). */
export async function chat(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  if (!pid) return { messages: [] };
  const { chatHistory } = await import('../src/agent/chatLog.js');
  return { messages: await chatHistory(db, pid) };
}

/** The principal's recent questions in the conversation (to resume from), newest first. Read-only. */
export async function history(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  if (!pid) return { questions: [] };
  const { recentQuestions } = await import('../src/agent/chatLog.js');
  return { questions: await recentQuestions(db, pid) };
}

/** The weekly review: a deterministic reading of the principal's own records (src/review). Read-only. */
export async function review(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  if (!pid) return { review: null };
  const timeZone = ((await db.query('SELECT timezone FROM principals WHERE id = $1', [pid])).rows[0] as { timezone?: string } | undefined)?.timezone ?? 'UTC';
  const { weeklyReview } = await import('../src/review/loader.js');
  return { review: await weeklyReview(db, pid, timeZone) };
}

/** The reading digest: today's items and the routine's schedule. Read-only. */
export async function digest(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  if (!pid) return { digest: null };
  const { digestFor } = await import('../src/routines/digestService.js');
  return { digest: await digestFor(db, pid) };
}

/** Market monitoring observations (never advice) and the routine's schedule. Read-only. */
export async function market(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  if (!pid) return { market: null };
  const { marketAlertsFor } = await import('../src/routines/digestService.js');
  return { market: await marketAlertsFor(db, pid) };
}

/** What Wendy knows: proposals to confirm and active memories, with freshness. */
export async function memoryOverview(db: pg.Pool, principalIdParam: string | null) {
  const pid = await resolvePrincipal(db, principalIdParam);
  if (!pid) return { memories: [] };
  const { memoryFreshness } = await import('../src/memory/freshness.js');
  const rows = (
    await db.query(
      `SELECT m.id, m.kind, m.content, m.status, m.written_by, m.created_at, m.last_confirmed_at, m.subject_person_id, p.full_name,
              (SELECT array_agg(DISTINCT e->>'kind') FROM jsonb_array_elements(m.evidence) e) AS evidence_kinds
         FROM memories m LEFT JOIN people p ON p.id = m.subject_person_id
        WHERE m.principal_id = $1 AND m.status IN ('PROPOSED', 'ACTIVE') AND m.kind IN ('PREFERENCE', 'FACT')
        ORDER BY m.status DESC, m.created_at DESC LIMIT 300`,
      [pid],
    )
  ).rows;
  return { memories: rows.map((m) => ({ ...m, freshness: memoryFreshness(m, new Date()) })) };
}
