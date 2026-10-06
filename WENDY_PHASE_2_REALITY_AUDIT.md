# WENDY — PHASE 2 STRICT REALITY AUDIT

> **SUPERSEDED** by `WENDY_INITIAL_ARCHITECTURE_AUDIT.md` (2026-10-05). This document describes the code at commit `1716bb1` and is kept for history only.
**Document Classification:** Internal Technical & Architectural Audit  
**Standard:** Zero-Delusion Reality Check  
**Date of Audit:** October 5, 2026  
**Auditor:** Antigravity System Architecture Specialist  

---

## EXECUTIVE SUMMARY & AUDIT METHODOLOGY

This reality audit investigates the actual codebase, persistence layers, and execution flows built during Phase 2 in `/Users/joaormendes/.gemini/antigravity/scratch/wendy`. 

The objective is to establish an uncompromising boundary between:
1. **Genuinely Working Logic:** Code that executes deterministic algorithms and persists state.
2. **Partially Implemented Logic:** Structures that function under narrow happy paths but fail edge cases or restarts.
3. **Simulated & Mocked Stubs:** Logic that emulates external systems (e.g., SMTP delivery) without real network or OS side-effects.
4. **Hardcoded Demonstrations:** Static datasets or regex matchers masquerading as cognitive reasoning.

---

## 1. AUDIT OF EVERY CLAIMED CAPABILITY

Every claimed feature was inspected down to its AST, execution path, and disk representation:

| Capability Claim | Classification | Concrete Evidence in Codebase |
| :--- | :--- | :--- |
| **Proactive Dossier** | **HARDCODED** | `src/cognition/reasoningEngine.js` (`generateExecutiveDossier()`, lines 94–165). The 4 quadrants (Urgent, Relationship, Commitment, Can Wait) are statically constructed return objects; they are not dynamically derived from raw event ingestion. |
| **Four Categorized Items** | **HARDCODED** | Hardcoded titles, narratives, and salience numbers in `reasoningEngine.js`. |
| **Carlos Meeting (14:00)** | **HARDCODED** | Statically defined in `seedData.js` and `reasoningEngine.js`. No live Google Calendar or CalDAV event parser exists. |
| **Mariana Birthday** | **HARDCODED** | Statically calculated from `tomorrowMonth/Day` in `seedData.js` (lines 40–58). Not dynamically extracted from external contacts. |
| **Q4 Tool Vendor Suppression** | **HARDCODED** | Static quadrant item in `reasoningEngine.js` line 152. No real calendar search or filtering algorithm produced this entry. |
| **Provenance Chain** | **HARDCODED** | `public/app.js` (lines 188–226). The `provenanceDatabase` is a client-side dictionary containing hardcoded fake SHA-256 strings (`8f4c2e...`, `b194f2...`). It does not compute hashes from raw RFC822 messages. |
| **Source Emails** | **MOCKED** | Synthetic strings in `seedData.js` and `app.js`. No IMAP or MIME parser. |
| **Timestamps** | **PARTIAL** | System timestamps use real `new Date().toISOString()`, but historical event timestamps in seed data are fixed relative offsets (`Date.now() - 14 * 86400000`). |
| **Confidence Scores** | **HARDCODED** | Literal float numbers hardcoded in source files (`0.92`, `0.88`, `0.94`). No Bayesian or LLM confidence calibration model. |
| **Level 3 Authorization Gate** | **REAL** | `server.js` (lines 104–157) and `ActionAdapters.js`. Level 3 actions cannot dispatch without an HTTP `POST /api/action/authorize` containing a valid executive sign-off payload. |
| **Editable Action Draft** | **REAL** | `public/index.html` (lines 173–192). The textarea allows freeform executive edits before authorization. |
| **Bidirectional Sync** | **PARTIAL** | `public/app.js` (`syncDraftState()`) pushes keystrokes via `POST /api/action/sync` to `server.js`. It updates in-memory `stagedActions[actionId]`, but is **not persisted to disk**; restarts reset edits. |
| **Authorize & Queue Dispatch** | **REAL** | Triggers server-side state transition from `AWAITING_APPROVAL` to `EXECUTED`, appends an audit block, and records to episodic memory. |
| **Idempotent Adapter** | **PARTIAL** | `ActionAdapters.js` (line 15) uses MD5 hashing to check `this.executedKeys.has(idempotencyKey)`. However, `this.executedKeys` is an **in-memory Set**. On server restart, idempotency memory is lost, allowing duplicate dispatch. |
| **SMTP Gateway** | **MOCKED** | `ActionAdapters.js` line 42 does `console.log` and returns a hardcoded mock receipt (`250 2.0.0 OK`). Zero SMTP/TLS network sockets are opened. |
| **Delivery Verification** | **SIMULATED** | Returns a synthetic receipt timestamp and message ID synchronously. No asynchronous bounce detection, DSN parsing, or webhook callbacks. |
| **Cryptographic Audit Ledger** | **PARTIAL** | `src/governance/auditLedger.js`. Real SHA-256 chaining (`prevHash + timestamp + payload`). However, the storage is a plain, mutable JSON file (`data/wendy_audit_ledger.json`) with **zero tamper detection or signature verification**. |
| **Episodic Memory Update** | **REAL** | `ActionAdapters.js` line 52 appends a real record to `data/wendy_memory.json` with timestamp, verbatim text, and SHA-256 content hash. |
| **Epistemic Dialogue** | **HARDCODED** | `reasoningEngine.js` (`processExecutiveQuery()`, lines 170–225) uses hardcoded string matching (`q.includes('carlos')`, `q.includes('mariana')`) returning canned responses. No dynamic LLM or memory search. |
| **FACT / INFERENCE / RECOM** | **HARDCODED** | Pre-scripted epistemic tags inside canned string replies in `reasoningEngine.js`. |
| **Audit Ledger UI** | **REAL** | `public/app.js` (`fetchAuditData()`) fetches real records from `/api/audit` and renders sequence numbers, timestamps, and hashes. |
| **SHA-256 Chained Blocks** | **REAL** | Verified in tests: Each block embeds the `prevHash` of the previous block and hashes the payload. |
| **Memory Graph** | **PARTIAL** | `src/memory/memoryStore.js`. Entities and edges are stored in JSON, but relationship metrics (`velocity: 'ACCELERATING'`, `reciprocityBalance: -1`) are **static strings seeded on startup**, not computed from interaction history. |
| **Six-Strata Persistence** | **ARCHITECTURAL ONLY**| The 6 strata exist conceptually in documentation. The runtime is a single, flat JSON file with 6 property keys. |
| **Relationship Velocity** | **HARDCODED** | Hardcoded string in `seedData.js`. No temporal rolling-window frequency calculation. |
| **Reciprocity Balances** | **HARDCODED** | Hardcoded integer `-1` in `seedData.js`. No automated credit/debt extraction from commitment fulfillment. |
| **Executive Heuristics** | **REAL** | `data/wendy_memory.json` stores 3 persistent rules (drafting voice, Friday protection, Tier 1 birthday rules) that survive across restarts. |
| **Inject Signal** | **SIMULATED** | `server.js` (`POST /api/events/simulate`) publishes to an event bus, but the reasoning engine does not react dynamically. It returns canned static summaries for 3 pre-selected dropdown items. |
| **Real-time Reaction** | **PARTIAL** | Real SSE connection broadcasts events to the browser, but the event payload is static rather than an autonomous cognitive re-evaluation. |

---

## 2. THE MOST IMPORTANT TEST: APPLICATION RESTART & RECONSTRUCTION

We conducted a clean restart test using a fresh node invocation against the persistent files in `data/`:

### Diagnostic Test Execution:
```bash
/opt/homebrew/bin/node -e "
const freshMemory = new MemoryStore();
const raw = JSON.parse(fs.readFileSync('data/wendy_memory.json', 'utf-8'));
console.log('People count:', Object.keys(raw.people || {}).length);
console.log('Episodic count:', raw.episodicMemory?.length);
"
```
**Output:**
- People count: 3
- Episodic count: 5

### The Findings:
1. **Entities & Episodic Logs Survive:** `people`, `relationships`, `commitments`, and `episodicMemory` do persist to `data/wendy_memory.json`.
2. **The Critical Seed Bug:** In `server.js`, line 15 unconditionally calls `seedExecutiveEnvironment(globalMemory)` on **every single boot**. This re-writes and overwrites `people` and appends duplicate episodic records on every restart.
3. **Staged Actions Do NOT Survive:** `ReasoningEngine.stagedActions` is an in-memory dictionary. If João modifies Mariana's birthday draft or authorizes Carlos's briefing, a server restart completely wipes out the staged state and resets it back to the unapproved hardcoded default.
4. **Dossier Does NOT Reconstruct from Memory:** The Morning Dossier is hardcoded in code rather than generated from queries against `data/wendy_memory.json`.

---

## 3. PROACTIVE INTELLIGENCE TEST

### Test Case:
Inject a new signal: *"Carlos sends an email indicating that the pricing proposal is now urgent."*

### Empirical Chain Analysis:
```text
SIGNAL (POST /api/events/simulate)
   ↓ [REAL] Received by server.js
EVENT (globalEventBus.publishEvent)
   ↓ [REAL] Standardized envelope created with UUID and SHA-256
INGESTION (Event ledger append)
   ↓ [REAL] Appended to EventBus.ledger
CONTEXT RETRIEVAL
   ↓ [MISSING] EventBus has no subscriber that queries ContextRetriever
RELATIONSHIP CONTEXT
   ↓ [MISSING] No dynamic lookup of Carlos's graph node triggered
REASONING
   ↓ [MISSING] ReasoningEngine is NOT triggered by the event
PRIORITIZATION
   ↓ [HARDCODED] Server returns static salience: 0.92
PROACTIVE INSIGHT
   ↓ [HARDCODED] Server returns canned summary string
USER NOTIFICATION / INTERRUPT
   ↓ [PARTIAL] Appended to chat stream via client callback; no AG-UI interrupt triggered
OPTIONAL ACTION PREPARATION
   ↓ [MISSING] No new action card is staged in Zone C
```

**Verdict:** **SIMULATED**. The event bus receives the payload, but the awareness engine is not hooked to an autonomous reasoning loop. It is a scripted endpoint returning pre-baked strings.

---

## 4. MEMORY PERSISTENCE & RETRIEVAL TEST

### Test Case:
1. Append new episodic memory: `"Carlos prefers concise communication and dislikes long emails."`
2. Save to disk.
3. Re-instantiate engine (simulating restart).
4. Query: `"How should I communicate with Carlos?"`

### Empirical Test Result:
```text
Engine Response:
"I have processed your query against your current active relationships, commitments, and calendar. The two highest-salience priorities right now remain the 14:00 pricing session with Carlos and Mariana's birthday dispatch staged for tomorrow morning. Would you like me to adjust either action?"
```

### Why it Failed:
`processExecutiveQuery()` in `src/cognition/reasoningEngine.js` does not perform semantic retrieval or full-text search across `episodicMemory`. It relies exclusively on static keyword matching:
```javascript
if (q.includes('carlos') && (q.includes('why') || q.includes('important'))) { ... }
```
Because the query asked *"How should I communicate"*, it failed the hardcoded condition and fell through to the static default fallback, completely oblivious to the newly saved memory record.

---

## 5. AUTHORIZATION LIFECYCLE & IDEMPOTENCY TEST

### 1. Preparation & Waiting Gate:
- **Verified:** When `act-mariana-birthday` is loaded, its status is `AWAITING_APPROVAL`. The action adapter is never invoked automatically on boot. The Level 3 barrier is real.

### 2. Approval & Execution:
- **Verified:** Calling `POST /api/action/authorize` changes status to `EXECUTED`, logs block #1 to `data/wendy_audit_ledger.json`, logs block #2 (verification), and commits an episodic record.

### 3. Rejection Test:
- **Verified in UI:** Dismissing the card removes it from the UI.
- **Deficiency:** Rejection does **not** persist a rejection record to `data/wendy_memory.json` or update the executive preference heuristics.

### 4. Idempotency Across Restarts:
```javascript
// Run 1:
const res1 = await adapter1.dispatchEmail({ actionId: 'test-act-1', ... });
// Output: VERIFIED_SUCCESS

const res2 = await adapter1.dispatchEmail({ actionId: 'test-act-1', ... });
// Output: ALREADY_EXECUTED (Idempotent within session)

// SIMULATE SERVER RESTART:
const adapterAfterRestart = new ActionAdapters(freshMemory);
const res3 = await adapterAfterRestart.dispatchEmail({ actionId: 'test-act-1', ... });
// Output: VERIFIED_SUCCESS (DUPLICATE DISPATCHED!)
```
**Critical Vulnerability:** Idempotency keys are stored in an ephemeral in-memory `Set`. When Wendy restarts, all idempotency memory vanishes. A re-submitted webhook or user click will execute a duplicate external mutation.

---

## 6. PROVENANCE TEST: "CARLOS IS IMPORTANT"

Tracing the claim down to its root:

```text
RECOMMENDATION: "Arrive at 14:00 with the 3% volume rebate concession pre-cleared."
   ↓
INFERENCE: "Carlos is concerned about pricing before Thursday board."
   ↓
SUPPORTING FACTS:
   1. Calendar event: 14:00 today.
   2. Email from Carlos: yesterday 23:42.
   3. Commitment: 14 days ago.
   ↓
SOURCE RECORDS:
   Where are these records stored?
   - In 'seedData.js' as static object properties!
   - In 'public/app.js' as a hardcoded 'provenanceDatabase' dictionary!
   ↓
ORIGINAL SOURCE TELEMETRY:
   - Google Calendar Event ID? NON-EXISTENT (Hardcoded mock string).
   - Gmail Message RFC822 raw headers? NON-EXISTENT.
   - SHA-256 Hash '8f4c2e61a90d8173429bc01837e41982b67d5e182390a427181c098234ea7193'?
     LITERAL HARDCODED STRING in client JavaScript.
```

**Verdict:** **HARDCODED MOCK**. Wendy does not compute provenance; she quotes pre-written provenance scripts written by the developer.

---

## 7. AUDIT LEDGER INTEGRITY TEST

We tested the claim of a *"Cryptographic, Immutable Audit Ledger"*:

1. **Hash Chaining Exists:** Each entry computes:
   $$\text{Hash}_n = \text{SHA256}(\text{Hash}_{n-1} + \text{Timestamp} + \text{Type} + \text{ActionId} + \text{Payload})$$
2. **Mutability Test:** We opened `data/wendy_audit_ledger.json` and modified Entry #1's recipient to `hacker@malicious.com`.
3. **Integrity Verification:**
   - There is **no method** in `AuditLedger` to verify chain integrity (`verifyChainIntegrity()` is undefined).
   - On server restart, `AuditLedger.loadFromDisk()` reads the tampered JSON file without warning or error.
   - New entries will simply hash against the tampered entry's existing hash!

**Verdict:** **PARTIAL**. The math is real, but the persistence is a plain, unprotected text file with no cryptographic signature, no tamper detection, and no append-only file locks.

---

## 8. MEMORY GRAPH TEST

The `Memory Graph` view displays:
- Entity Nodes (João, Carlos, Mariana)
- Relationship Edges (Closeness, Velocity, Cadence)
- Executive Preferences (3 items)

**Reality Inspection:**
- Is it a Graph Database? **No.** It is three JavaScript object maps inside a JSON file.
- Are relationships dynamic? **No.** `velocity: 'ACCELERATING'` and `reciprocityBalance: -1` are static initial values from `seedData.js`. There are no graph traversal algorithms (`Breadth-First Search`, `Dijkstra`, or GQL queries) implemented.

---

## 9. INJECT SIGNAL TEST

Testing the three requested signals:

### Signal A: Urgent Email from Carlos
- **Observed:** Endpoint returns `{ success: true, summary: "Carlos Drummond emailed...", salience: 0.92 }`.
- **Reality:** Canned text. No email parser, no LLM intent classification, no dynamic update to Zone A.

### Signal B: Travel Delay
- **Observed:** Endpoint returns `{ summary: "Travel Telemetry: Flight 428...", salience: 0.74 }`.
- **Reality:** Static mock. No flight tracking API, no calendar buffer recomputation.

### Signal C: Upcoming Birthday
- **Observed:** Endpoint returns `{ summary: "Market Signal...", salience: 0.65 }`.
- **Reality:** Not even implemented in `server.js` (it defaulted to a competitor news string).

---

## 10. DATA ARCHITECTURE DECISION

### Evaluation: SQLite + sqlite-vec vs. PostgreSQL + pgvector

| Dimension | SQLite + sqlite-vec | PostgreSQL + pgvector |
| :--- | :--- | :--- |
| **Concurrency** | Single-writer lock (file lock contention during high-frequency telemetry ingestion). | Multi-version concurrency control (MVCC); simultaneous sensor ingestion and executive queries. |
| **Row-Level Security** | None. All-or-nothing file access. | Native Row-Level Security (RLS) enforcing multi-tenant, executive-private boundaries. |
| **Audit Ledger Immutability**| Easily tampered by any process with file write access. | Write-Once-Read-Many (WORM) tables, append-only rules, and cryptographic extension support. |
| **Vector Search & Hybrid Search**| Basic vector search; lacks rich hybrid BM25 + vector ranking. | State-of-the-art hybrid search (Full-text `tsvector` + `pgvector` HNSW index). |
| **Operational Overhead** | Embedded zero-config file. Excellent for quick single-user demos. | Requires managed container or Cloud SQL instance. |
| **Multi-Agent Scaling** | Prone to `SQLITE_BUSY` when multiple subagents write concurrently. | Native connection pooling; seamless horizontal agent scaling. |

### Final Recommendation:
**Adopt PostgreSQL + pgvector as the single production persistence architecture.**
Do not build on SQLite only to throw it away when multi-agent concurrency, row-level access control, and high-frequency webhook ingestion arrive in Phase 3. 

---

## 11. BACKGROUND AWARENESS RUNTIME ARCHITECTURE

### The Flaw in "Antigravity Schedule as Production Heartbeat":
The Antigravity `schedule` tool is a developer-agent timer. It lives inside an active Antigravity session. If the agent conversation is paused, closed, or restarted, the timer does not execute. 

### Correct Production Architecture:
Wendy must own her own persistent production heartbeat independent of any IDE or development agent:

```
┌──────────────────────────────────────────────────────────────┐
│                  DURABLE PRODUCTION RUNTIME                   │
│                                                              │
│   ┌──────────────────────────────────────────────────────┐   │
│   │  Persistent Job Orchestrator (Temporal / BullMQ /   │   │
│   │  Node-Cron Daemon with PG Advisory Locks)            │   │
│   └──────────────────────────┬───────────────────────────┘   │
│                              │                               │
│         ┌────────────────────┼───────────────────┐           │
│         ▼                    ▼                   ▼           │
│  [Ingestion Tick]    [Salience Heartbeat]  [T-30 Prep Worker]│
│   (Every 60 sec)      (07:00 & 18:30)       (Continuous)     │
│         │                    │                   │           │
│         └────────────────────┼───────────────────┘           │
│                              ▼                               │
│   ┌──────────────────────────────────────────────────────┐   │
│   │  Idempotent Action Ledger (PostgreSQL Unique Keys)   │   │
│   └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

1. **Durable Task Queue:** Backed by Redis or PostgreSQL (`pg-boss` or `BullMQ`) with exponential backoff and dead-letter queues.
2. **Stateful Cron Locks:** Database-level advisory locks prevent duplicate execution across multiple server instances.
3. **Independent Daemon:** Runs as a standard containerized service (Docker/systemd/Cloud Run), ensuring Wendy stays aware 24/7.

---

## 12. PROVIDER ADAPTER BOUNDARIES (DECOUPLING COMPLETED)

To prevent Wendy Core from being tightly coupled to Google-specific SDKs, we have formalized and written the abstract provider interfaces in [`src/integrations/providers.js`](file:///Users/joaormendes/.gemini/antigravity/scratch/wendy/src/integrations/providers.js):

- **`CalendarProvider`**: `listEvents()`, `getEvent()`, `stageEventMutation()`, `executeEventMutation()`, `registerWebhook()`
- **`EmailProvider`**: `searchMessages()`, `getMessage()`, `stageDraft()`, `dispatchAuthorizedEmail()`, `verifyDelivery()`
- **`ContactsProvider`**: `searchContacts()`, `getContact()`, `syncDirectoryChanges()`
- **`DriveProvider`**: `searchFiles()`, `extractDocumentContent()`

Wendy's cognitive core will communicate exclusively through these abstract contracts.

---

## 13. FINAL VERDICT BREAKDOWN

### REAL
- Three-Zone editorial layout and responsive styling.
- Level 3 Human-in-the-Loop authorization gate (cannot dispatch without user action).
- Editable action draft with real DOM inputs.
- Basic SHA-256 block hashing algorithm on audit records.
- JSON-backed entity and episodic memory serialization.

### PARTIAL
- Shared state synchronization (in-memory only; does not survive restart).
- Audit ledger (cryptographically chained, but stored in a mutable plain-text file without tamper detection).
- Idempotency enforcement (works within process memory; completely wiped on restart).
- Event bus (pub/sub works in Node.js, but does not trigger downstream reasoning).

### SIMULATED
- SMTP delivery & receipt verification (100% synthetic mock).
- External signal ingestion & real-time re-evaluation (canned strings).
- Multi-agent coordination and subgraphs.

### HARDCODED
- The entire Morning Dossier (Urgent, Relationship, Commitment, Can Wait).
- All 4 items and their salience scores.
- The provenance evidence chains and raw cryptographic hashes.
- Epistemic dialogue (`processExecutiveQuery` regex branches).
- Relationship metrics (velocity, reciprocity, cadence).

### MISSING
- Dynamic reasoning loop that synthesizes an unknown calendar/email state.
- Semantic search / Vector index for memory retrieval.
- Durable idempotency storage.
- Real tamper-detection logic for the audit ledger.
- Independent background daemon for 24/7 awareness.

### ARCHITECTURAL RISKS
1. **Duplicate Mutation on Restart:** In-memory idempotency sets guarantee duplicate emails/invites if the process cycles during retries.
2. **Session Reset Wipeout:** Unpersisted staged actions mean the executive's pending approvals are lost whenever the server restarts.
3. **Seed Overwrite:** Calling `seedExecutiveEnvironment` on boot corrupts user modifications and produces duplicate episodic entries.

---

## 14. PHASE 3 GATE: VERDICT

# 🛑 NOT READY FOR PHASE 3

### Minimum Blockers to Clear Before Connecting External APIs:
1. **Remove Boot Seeding Overwrite:** The server must load existing state from disk and only seed if the database is genuinely empty.
2. **Persist Staged Actions & Draft Edits:** Move `stagedActions` into the persistent store so approvals and edits survive restarts.
3. **Persist Idempotency Keys:** Store execution tokens in persistent storage to eliminate duplicate dispatch vulnerabilities.
4. **Implement Chain Integrity Verification:** Add `verifyLedgerIntegrity()` to `AuditLedger` so tampering is actively detected and blocked on startup.
5. **Connect Dynamic Context Retrieval to Queries:** Replace hardcoded `if (q.includes(...))` in `reasoningEngine.js` with dynamic queries against the memory store so new memories (like Carlos's communication preference) are actually recalled.

Once these 5 architectural blockers are resolved, Wendy will be a **real, durable executive foundation** ready for live provider connections.
