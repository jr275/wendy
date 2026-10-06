import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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
const PUBLIC_DIR = path.resolve('public');

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
  console.error('\n🚨 FATAL: Cryptographic audit ledger integrity failure detected on startup!');
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
  eventBus: globalEventBus
});

const reasoningEngine = new ReasoningEngine({
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

  // 3. Chat / Executive Dialogue (Real Memory Retrieval)
  if (pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { query } = JSON.parse(body || '{}');
        const response = await reasoningEngine.processExecutiveQuery(query);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 4. Two-Way Shared State Sync (Draft updates - PERSISTED TO DISK)
  if (pathname === '/api/action/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { actionId, modifiedBody } = JSON.parse(body || '{}');
        const action = await actionRepo.getAction(actionId);
        if (action) {
          action.preview.body = modifiedBody;
          await actionRepo.saveAction(action);
          console.log(`[SHARED STATE SYNC] Action ${actionId} draft persisted to disk.`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 5. Human Authorization & Action Execution (Level 3/4 Gate)
  if (pathname === '/api/action/authorize' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { actionId, modifiedBody, actorId = 'person-exec-joao' } = JSON.parse(body || '{}');
        const action = await actionRepo.getAction(actionId);
        
        if (!action) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Action not found in staging repository' }));
          return;
        }

        // 1. Record cryptographic approval entry
        const approvalEntry = await auditRepo.appendBlock({
          eventType: 'ACTION_APPROVED_BY_EXECUTIVE',
          actionId,
          actorId,
          authorizationLevel: action.authorizationLevel,
          payload: {
            approvedAt: new Date().toISOString(),
            recipient: action.preview.recipient,
            bodyDispatched: modifiedBody || action.preview.body
          },
          verificationStatus: 'APPROVED'
        });

        // 2. Execute via durable idempotent Action Adapter
        const dispatchResult = await actionAdapters.dispatchEmail({
          actionId,
          recipient: action.preview.recipient,
          subject: action.preview.subject,
          bodyText: modifiedBody || action.preview.body,
          actorId
        });

        // 3. Broadcast verification to all connected AG-UI surfaces
        broadcastSse('ACTION_VERIFIED_BROADCAST', {
          actionId,
          auditHash: approvalEntry.entryHash,
          verification: dispatchResult.verificationReceipt
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          auditEntry: approvalEntry,
          verification: dispatchResult.verificationReceipt
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 6. Cryptographic Audit Ledger Query & Integrity Status
  if (pathname === '/api/audit' && req.method === 'GET') {
    const blocks = await auditRepo.getBlocks(50);
    const integrity = await auditRepo.verifyLedgerIntegrity();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      integrity,
      blocks
    }));
    return;
  }

  // 7. Event Ingestion Pipeline (Processes Real Event via CognitivePipeline)
  if (pathname === '/api/events/simulate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { scenario } = JSON.parse(body || '{}');
        let rawEvent = null;

        if (scenario === 'carlos_reply') {
          rawEvent = {
            eventType: 'EMAIL_RECEIVED',
            source: 'GMAIL_MOCK',
            actor: { id: 'person-carlos', type: 'EXTERNAL_CONTACT', identifier: 'carlos@horizoncap.com' },
            payload: {
              from: 'carlos@horizoncap.com',
              subject: 'Urgent: Pricing review before Thursday meeting',
              body: 'João, we need to revisit Clause 4 pricing immediately before tomorrow. The committee will not approve without revision.'
            }
          };
        } else if (scenario === 'flight_delay') {
          rawEvent = {
            eventType: 'TRAVEL_CHANGED',
            source: 'TRAVEL_API_MOCK',
            payload: {
              flight: 'Flight 428 to London',
              status: 'DELAYED_3H',
              text: 'Flight 428 delayed by 3 hours. Transit window impacted.'
            }
          };
        } else {
          rawEvent = {
            eventType: 'PERSON_EVENT_APPROACHING',
            source: 'CONTACTS_MOCK',
            payload: {
              person: 'Mariana Vance',
              event: 'birthday',
              date: 'tomorrow',
              text: 'Mariana Vance birthday approaching tomorrow.'
            }
          };
        }

        // Process through real cognitive loop!
        const pipelineOutput = await cognitivePipeline.processEvent(rawEvent);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          pipelineOutput
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
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
  console.log(`🌟 WENDY EXECUTIVE INTELLIGENCE RUNNING (PHASE 2.5 HARDENED)`);
  console.log(`📡 URL: http://127.0.0.1:${PORT}`);
  console.log(`🔒 Audit Ledger: Cryptographically Verified`);
  console.log(`💾 Persistence: Atomic Repositories Active`);
  console.log(`🧠 Cognitive Loop: Autonomous Pipeline Connected`);
  console.log(`======================================================\n`);
});
