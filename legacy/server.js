import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FileEntityRepository,
  FileRelationshipRepository,
  FileEventRepository,
  FileActionRepository,
  FileIdempotencyRepository,
  FileAuditRepository,
  FileMemoryRepository,
  ActionState
} from './src/repositories/fileStorage.js';
import { initializeDatabaseWithFixtures } from './src/sensory/fixtures.js';
import { globalEventBus } from './src/sensory/eventBus.js';
import { CognitivePipeline } from './src/cognition/cognitivePipeline.js';
import { ReasoningEngine } from './src/cognition/reasoningEngine.js';
import { ActionAdapters } from './src/governance/actionAdapters.js';
import { AguiProtocol } from './src/agui/aguiProtocol.js';

const PORT = process.env.PORT || 3456;
const PRINCIPAL_ID = process.env.WENDY_PRINCIPAL_ID || 'person-exec-joao';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

// 1. REPOSITORIES INITIALIZATION
const entityRepo = new FileEntityRepository();
const relationshipRepo = new FileRelationshipRepository();
const eventRepo = new FileEventRepository();
const actionRepo = new FileActionRepository();
const idempotencyRepo = new FileIdempotencyRepository();
const auditRepo = new FileAuditRepository();
const memoryRepo = new FileMemoryRepository();

// 2. AUDIT INTEGRITY CHECK ON BOOT
const ledgerCheck = await auditRepo.verifyLedgerIntegrity();
if (!ledgerCheck.valid) {
  console.error('\nFATAL: audit ledger integrity check failed on startup.');
  console.error(`Error: ${ledgerCheck.error}`);
  console.error('Halting boot to prevent operating on compromised state.\n');
  process.exit(1);
} else {
  console.log(`🔒 Audit ledger integrity verified: ${ledgerCheck.blockCount} blocks valid.`);
}

// 3. IDEMPOTENT FIXTURE INITIALIZATION (Only seeds if database is empty)
await initializeDatabaseWithFixtures({
  entityRepo,
  relationshipRepo,
  memoryRepo,
  actionRepo
});

// 4. COGNITIVE PIPELINE & REASONING INITIALIZATION
const cognitivePipeline = new CognitivePipeline({
  eventRepo,
  entityRepo,
  relationshipRepo,
  memoryRepo,
  actionRepo,
  eventBus: globalEventBus,
  principalId: PRINCIPAL_ID
});

const reasoningEngine = new ReasoningEngine({
  principalId: PRINCIPAL_ID,
  entityRepo,
  relationshipRepo,
  eventRepo,
  actionRepo,
  memoryRepo,
  cognitivePipeline
});

const actionAdapters = new ActionAdapters({
  idempotencyRepo,
  auditRepo,
  memoryRepo,
  actionRepo
});

// Active SSE client connections
const sseClients = new Set();

function broadcastSse(eventType, data) {
  const payload = AguiProtocol.formatSse(eventType, data);
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Forward proactive pipeline insights to connected SSE clients
globalEventBus.on('PROACTIVE_INSIGHT_GENERATED', (insight) => {
  broadcastSse('PROACTIVE_INSIGHT_GENERATED', insight);
});

// MIME types dictionary
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Rejects non-JSON bodies so a cross-site "simple" (text/plain) POST cannot drive actions.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      reject(Object.assign(new Error('Content-Type must be application/json'), { status: 415 }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(Object.assign(e, { status: 400 })); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // --- API ROUTES ---

  // 1. Full State Snapshot
  if (pathname === '/api/state' && req.method === 'GET') {
    const dossier = await reasoningEngine.generateExecutiveDossier();
    const people = await entityRepo.getAllPeople();
    const preferences = await memoryRepo.getAllPreferences();
    const recentEpisodic = await memoryRepo.queryEpisodic({ limit: 10 });
    const recentEvents = await eventRepo.listEvents({ limit: 10 });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      dossier,
      memory: {
        people: people.reduce((acc, p) => { acc[p.id] = p; return acc; }, {}),
        preferences,
        recentEpisodic
      },
      recentEvents
    }));
    return;
  }

  // 2. AG-UI SSE Stream
  if (pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('\n');
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 3. Chat (legacy: lists persisted records, no reasoning)
  if (pathname === '/api/chat' && req.method === 'POST') {
    try {
      const { query } = await readJsonBody(req);
      sendJson(res, 200, await reasoningEngine.processExecutiveQuery(String(query || '')));
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message });
    }
    return;
  }

  // 4. Draft edits (persisted; only while awaiting approval)
  if (pathname === '/api/action/sync' && req.method === 'POST') {
    try {
      const { actionId, modifiedBody } = await readJsonBody(req);
      const action = await actionRepo.getAction(actionId);
      if (!action) return sendJson(res, 404, { error: 'Action not found' });
      if (action.state !== ActionState.AWAITING_APPROVAL) {
        return sendJson(res, 409, { error: `Action is ${action.state}; drafts can only be edited while AWAITING_APPROVAL` });
      }
      action.preview = { ...action.preview, body: modifiedBody };
      await actionRepo.saveAction(action);
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message });
    }
    return;
  }

  // 5. Approval. Records the decision; dispatch reports honestly that nothing was sent.
  if (pathname === '/api/action/authorize' && req.method === 'POST') {
    try {
      const { actionId, modifiedBody } = await readJsonBody(req);
      const action = await actionRepo.getAction(actionId);
      if (!action) return sendJson(res, 404, { error: 'Action not found' });
      if (action.state !== ActionState.AWAITING_APPROVAL) {
        return sendJson(res, 409, { error: `Action is ${action.state}; only AWAITING_APPROVAL actions can be approved` });
      }

      const body = modifiedBody || action.preview.body;
      const approvalEntry = await auditRepo.appendBlock({
        eventType: 'ACTION_APPROVED_BY_EXECUTIVE',
        actionId,
        actorId: PRINCIPAL_ID,
        authorizationLevel: action.authorizationLevel,
        payload: { recipient: action.preview.recipient, subject: action.preview.subject, body },
        verificationStatus: 'APPROVED'
      });
      await actionRepo.updateActionState(actionId, ActionState.APPROVED, { preview: { ...action.preview, body } });

      const dispatch = await actionAdapters.dispatchEmail({
        actionId,
        recipient: action.preview.recipient,
        subject: action.preview.subject,
        bodyText: body,
        actorId: PRINCIPAL_ID
      });

      broadcastSse('ACTION_APPROVAL_RECORDED', { actionId, auditHash: approvalEntry.entryHash, dispatch });
      sendJson(res, 200, { success: true, auditEntry: approvalEntry, dispatch });
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message });
    }
    return;
  }

  // 5b. Rejection (persisted server-side + audited)
  if (pathname === '/api/action/reject' && req.method === 'POST') {
    try {
      const { actionId, reason = null } = await readJsonBody(req);
      const action = await actionRepo.getAction(actionId);
      if (!action) return sendJson(res, 404, { error: 'Action not found' });
      if (action.state !== ActionState.AWAITING_APPROVAL && action.state !== ActionState.PROPOSED) {
        return sendJson(res, 409, { error: `Action is ${action.state}; cannot reject` });
      }
      const entry = await auditRepo.appendBlock({
        eventType: 'ACTION_REJECTED_BY_EXECUTIVE',
        actionId,
        actorId: PRINCIPAL_ID,
        authorizationLevel: action.authorizationLevel,
        payload: { reason },
        verificationStatus: 'REJECTED'
      });
      await actionRepo.updateActionState(actionId, ActionState.REJECTED, { rejectionReason: reason });
      await memoryRepo.recordOutcome({ actionId, actionType: action.actionType, decision: 'REJECTED', wasSuccessful: false, executiveFeedback: reason });
      sendJson(res, 200, { success: true, auditEntry: entry });
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message });
    }
    return;
  }

  // 6. Audit ledger + integrity
  if (pathname === '/api/audit' && req.method === 'GET') {
    sendJson(res, 200, { integrity: await auditRepo.verifyLedgerIntegrity(), blocks: await auditRepo.getBlocks(50) });
    return;
  }

  // 7. Inject a DEV FIXTURE event (clearly labeled) into the legacy pipeline
  if (pathname === '/api/events/simulate' && req.method === 'POST') {
    try {
      const { scenario } = await readJsonBody(req);
      const fixtures = {
        fixture_email: {
          eventType: 'EMAIL_RECEIVED',
          source: 'DEV_FIXTURE',
          provenance: { sourceType: 'DEVELOPMENT_FIXTURE' },
          payload: {
            from: 'carlos@horizoncap.com',
            subject: 'Pricing review before Thursday meeting',
            body: 'João, we need to revisit Clause 4 pricing before tomorrow.'
          }
        },
        fixture_travel: {
          eventType: 'TRAVEL_CHANGED',
          source: 'DEV_FIXTURE',
          provenance: { sourceType: 'DEVELOPMENT_FIXTURE' },
          payload: { flight: 'Flight 428 to London', status: 'DELAYED_3H' }
        }
      };
      const rawEvent = fixtures[scenario];
      if (!rawEvent) return sendJson(res, 400, { error: `Unknown fixture scenario: ${scenario}` });
      sendJson(res, 200, { success: true, pipelineOutput: await cognitivePipeline.processEvent(rawEvent) });
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message });
    }
    return;
  }

  // --- STATIC FILE SERVING ---
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'text/plain';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n======================================================`);
  console.log(`WENDY LEGACY PROTOTYPE UI (frozen; no reasoning, no email provider)`);
  console.log(`📡 URL: http://127.0.0.1:${PORT}`);
  console.log(`======================================================\n`);
});
