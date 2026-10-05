import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { globalMemory } from './src/memory/memoryStore.js';
import { seedExecutiveEnvironment } from './src/sensory/seedData.js';
import { globalEventBus } from './src/sensory/eventBus.js';
import { ReasoningEngine } from './src/cognition/reasoningEngine.js';
import { ActionAdapters } from './src/governance/actionAdapters.js';
import { globalAuditLedger } from './src/governance/auditLedger.js';
import { AguiProtocol } from './src/agui/aguiProtocol.js';

const PORT = process.env.PORT || 3456;
const PUBLIC_DIR = path.resolve('public');

// Initialize Memory & Seed realistic executive data
seedExecutiveEnvironment(globalMemory);

const reasoningEngine = new ReasoningEngine(globalMemory, globalEventBus);
const actionAdapters = new ActionAdapters(globalMemory);

// Active SSE client connections
const sseClients = new Set();

function broadcastSse(eventType, data) {
  const payload = AguiProtocol.formatSse(eventType, data);
  for (const client of sseClients) {
    client.write(payload);
  }
}

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
    const dossier = reasoningEngine.generateExecutiveDossier();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      dossier,
      memory: globalMemory.getSnapshot(),
      recentEvents: globalEventBus.getRecentEvents(10)
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

  // 3. Chat / Executive Dialogue
  if (pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { query } = JSON.parse(body || '{}');
        const response = reasoningEngine.processExecutiveQuery(query);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 4. Two-Way Shared State Sync (Draft updates)
  if (pathname === '/api/action/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { actionId, modifiedBody } = JSON.parse(body || '{}');
        if (reasoningEngine.stagedActions[actionId]) {
          reasoningEngine.stagedActions[actionId].preview.body = modifiedBody;
          console.log(`[SHARED STATE SYNC] Action ${actionId} draft updated in Wendy memory.`);
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
        const stagedAction = reasoningEngine.stagedActions[actionId];
        
        if (!stagedAction) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Action not found in staging drawer' }));
          return;
        }

        // 1. Record cryptographic approval entry
        const approvalEntry = globalAuditLedger.appendAuditEntry({
          eventType: 'ACTION_APPROVED_BY_EXECUTIVE',
          actionId,
          actorId,
          authorizationLevel: stagedAction.authorizationLevel,
          payload: {
            approvedAt: new Date().toISOString(),
            recipient: stagedAction.preview.recipient,
            bodyDispatched: modifiedBody || stagedAction.preview.body
          },
          verificationStatus: 'APPROVED'
        });

        // 2. Execute via idempotent Action Adapter
        const dispatchResult = await actionAdapters.dispatchEmail({
          actionId,
          recipient: stagedAction.preview.recipient,
          subject: stagedAction.preview.subject,
          bodyText: modifiedBody || stagedAction.preview.body,
          actorId
        });

        stagedAction.status = 'EXECUTED';

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

  // 6. Cryptographic Audit Ledger Query
  if (pathname === '/api/audit' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(globalAuditLedger.getEntries(50)));
    return;
  }

  // 7. Event Bus Simulator
  if (pathname === '/api/events/simulate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { scenario } = JSON.parse(body || '{}');
        let summary = '';
        let salience = 0.8;

        if (scenario === 'carlos_reply') {
          summary = 'Carlos Drummond emailed: "Agreement terms look solid. Presenting to the investment committee now." Updated relationship trajectory to POSITIVE.';
          salience = 0.92;
          globalEventBus.publishEvent({
            eventType: 'EMAIL_RECEIVED',
            actor: { id: 'person-carlos', type: 'EXTERNAL_CONTACT', identifier: 'carlos@horizoncap.com' },
            primaryEntity: { entityType: 'Person', entityId: 'person-carlos' },
            importanceScore: 0.95,
            payload: { subject: 'Re: Partnership terms', text: 'Agreement terms look solid.' }
          });
        } else if (scenario === 'flight_delay') {
          summary = 'Travel Telemetry: Flight 428 to London has been rescheduled. Updated calendar buffer; no conflicts detected.';
          salience = 0.74;
        } else {
          summary = 'Market Signal: European competitor announced Series B expansion. Monitored for implications on Apex Bio.';
          salience = 0.65;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, summary, salience }));
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
  console.log(`🌟 WENDY EXECUTIVE INTELLIGENCE IS RUNNING`);
  console.log(`📡 URL: http://127.0.0.1:${PORT}`);
  console.log(`⚡ Category: Persistent Anticipatory Executive Intelligence`);
  console.log(`🔒 Governance: Level 0-4 Gateway Active`);
  console.log(`======================================================\n`);
});
