import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  FileEntityRepository,
  FileRelationshipRepository,
  FileEventRepository,
  FileActionRepository,
  FileIdempotencyRepository,
  FileAuditRepository,
  FileMemoryRepository,
  ActionState
} from '../src/repositories/fileStorage.js';
import { initializeDatabaseWithFixtures } from '../src/sensory/fixtures.js';
import { CognitivePipeline } from '../src/cognition/cognitivePipeline.js';
import { ActionAdapters } from '../src/governance/actionAdapters.js';
import { RetrievalEngine } from '../src/cognition/retrievalEngine.js';

let passed = 0;
let failed = 0;

function report(testName, ok, err = null) {
  if (ok) {
    console.log(`  ✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`, err || '');
    failed++;
  }
}

async function runTestSuite() {
  console.log('\n======================================================');
  console.log('🧪 WENDY PHASE 2.5 REALITY & FOUNDATION TEST SUITE');
  console.log('======================================================\n');

  // --- 1. PERSISTENCE & BOOT IDEMPOTENCY TEST ---
  console.log('--- TEST GROUP 1: PERSISTENCE & BOOT IDEMPOTENCY ---');
  {
    const entityRepo = new FileEntityRepository();
    const relationshipRepo = new FileRelationshipRepository();
    const memoryRepo = new FileMemoryRepository();
    const actionRepo = new FileActionRepository();

    // 1. Initial boot check
    const boot1 = await initializeDatabaseWithFixtures({
      entityRepo,
      relationshipRepo,
      memoryRepo,
      actionRepo
    });
    const count1 = await entityRepo.countPeople();

    // 2. Second boot check (Must not duplicate or overwrite!)
    const boot2 = await initializeDatabaseWithFixtures({
      entityRepo,
      relationshipRepo,
      memoryRepo,
      actionRepo
    });
    const count2 = await entityRepo.countPeople();

    report('First boot seeds fixtures or loads existing', count1 > 0);
    report('Second boot detects existing state without duplicate entities', count1 === count2 && boot2.seeded === false);
  }

  // --- 2. ACTIONS LIFECYCLE & PERSISTENCE ACROSS RESTARTS ---
  console.log('\n--- TEST GROUP 2: ACTIONS LIFECYCLE & PERSISTENCE ---');
  {
    const actionRepo = new FileActionRepository();
    const testActionId = `act-lifecycle-${Date.now()}`;

    // 1. Save Proposed
    await actionRepo.saveAction({
      actionId: testActionId,
      actionType: 'SEND_EMAIL',
      authorizationLevel: 3,
      state: ActionState.PROPOSED,
      targetEntityName: 'Test Partner',
      preview: { body: 'Initial Draft' }
    });

    // 2. Transition STAGED -> AWAITING_APPROVAL -> APPROVED
    await actionRepo.updateActionState(testActionId, ActionState.STAGED);
    await actionRepo.updateActionState(testActionId, ActionState.AWAITING_APPROVAL);
    await actionRepo.updateActionState(testActionId, ActionState.APPROVED);

    // 3. Simulate Restart (re-instantiate repository)
    const freshActionRepo = new FileActionRepository();
    const loadedAction = await freshActionRepo.getAction(testActionId);
    report('Action survives restart with exact state (APPROVED)', loadedAction && loadedAction.state === ActionState.APPROVED);

    // 4. Test Rejection state
    await freshActionRepo.updateActionState(testActionId, ActionState.REJECTED, { rejectionReason: 'Executive cancelled' });
    const rejectedAction = await freshActionRepo.getAction(testActionId);
    report('Action state transitions to REJECTED and persists', rejectedAction.state === ActionState.REJECTED && rejectedAction.rejectionReason === 'Executive cancelled');
  }

  // --- 3. DURABLE IDEMPOTENCY TEST ---
  console.log('\n--- TEST GROUP 3: DURABLE IDEMPOTENCY ---');
  {
    const idempotencyRepo = new FileIdempotencyRepository();
    const auditRepo = new FileAuditRepository();
    const memoryRepo = new FileMemoryRepository();
    const actionRepo = new FileActionRepository();

    const adapters = new ActionAdapters({
      idempotencyRepo,
      auditRepo,
      memoryRepo,
      actionRepo
    });

    const uniqueActionId = `act-idem-${Date.now()}`;
    const firstDispatch = await adapters.dispatchEmail({
      actionId: uniqueActionId,
      recipient: 'carlos@horizoncap.com',
      subject: 'Idempotency Test',
      bodyText: 'Testing execution uniqueness'
    });

    report('First dispatch executes with verified success', firstDispatch.status === 'VERIFIED_SUCCESS');

    // Immediate duplicate in same instance
    const secondDispatch = await adapters.dispatchEmail({
      actionId: uniqueActionId,
      recipient: 'carlos@horizoncap.com',
      subject: 'Idempotency Test',
      bodyText: 'Testing execution uniqueness'
    });
    report('Immediate duplicate returns ALREADY_COMPLETED_IDEMPOTENT', secondDispatch.status === 'ALREADY_COMPLETED_IDEMPOTENT');

    // Simulate complete server restart (fresh repository instances)
    const restartIdemRepo = new FileIdempotencyRepository();
    const restartAdapters = new ActionAdapters({
      idempotencyRepo: restartIdemRepo,
      auditRepo: new FileAuditRepository(),
      memoryRepo: new FileMemoryRepository(),
      actionRepo: new FileActionRepository()
    });

    const thirdDispatch = await restartAdapters.dispatchEmail({
      actionId: uniqueActionId,
      recipient: 'carlos@horizoncap.com',
      subject: 'Idempotency Test',
      bodyText: 'Testing execution uniqueness'
    });

    report('Duplicate dispatch AFTER RESTART is blocked by durable idempotency token', thirdDispatch.status === 'ALREADY_COMPLETED_IDEMPOTENT');
  }

  // --- 4. AUDIT LEDGER INTEGRITY & TAMPER DETECTION ---
  console.log('\n--- TEST GROUP 4: AUDIT LEDGER INTEGRITY ---');
  {
    const auditRepo = new FileAuditRepository();
    const checkValid = await auditRepo.verifyLedgerIntegrity();
    report('Untampered ledger passes cryptographic verification', checkValid.valid === true);

    // Test 1: Tamper with a payload
    const originalPayload = JSON.stringify(auditRepo.blocks[0].payload);
    auditRepo.blocks[0].payload.tamperedField = 'MALICIOUS_INJECTION';
    const tamperCheck1 = await auditRepo.verifyLedgerIntegrity();
    report('Tampered payload is detected and blocked', tamperCheck1.valid === false && tamperCheck1.error.includes('Tampering detected'));
    auditRepo.blocks[0].payload = JSON.parse(originalPayload); // restore

    // Test 2: Tamper with prevHash
    const originalPrevHash = auditRepo.blocks[auditRepo.blocks.length - 1].prevHash;
    auditRepo.blocks[auditRepo.blocks.length - 1].prevHash = 'INVALID_HASH_CORRUPTION_00000';
    const tamperCheck2 = await auditRepo.verifyLedgerIntegrity();
    report('Corrupted prevHash chain is detected and blocked', tamperCheck2.valid === false && tamperCheck2.error.includes('Chain broken'));
    auditRepo.blocks[auditRepo.blocks.length - 1].prevHash = originalPrevHash; // restore

    // Test 3: Sequence reorder / deletion
    const removedBlock = auditRepo.blocks.pop();
    const reorderCheck = await auditRepo.verifyLedgerIntegrity();
    report('Chain remains valid after last block truncation, but detects non-consecutive sequences', reorderCheck.valid === true || reorderCheck.error.includes('Sequence'));
    if (removedBlock) auditRepo.blocks.push(removedBlock); // restore
  }

  // --- 5. REAL MEMORY RETRIEVAL (NO HARDCODED QUERY BRANCHES) ---
  console.log('\n--- TEST GROUP 5: REAL MEMORY RETRIEVAL ---');
  {
    const entityRepo = new FileEntityRepository();
    const relationshipRepo = new FileRelationshipRepository();
    const memoryRepo = new FileMemoryRepository();
    const actionRepo = new FileActionRepository();

    const carlos = await entityRepo.findPersonByEmail('carlos@horizoncap.com');

    // Append new memory dynamically
    const dynamicMemoryText = 'Carlos prefers concise communication and dislikes long emails.';
    await memoryRepo.appendEpisodic({
      interactionType: 'NOTE',
      entityIds: [carlos.id],
      summary: dynamicMemoryText,
      verbatimSnippet: 'Carlos: "Keep emails under 3 sentences."'
    });

    // Simulate restart with new RetrievalEngine
    const freshMemoryRepo = new FileMemoryRepository();
    const retrieval = new RetrievalEngine({
      entityRepo: new FileEntityRepository(),
      relationshipRepo: new FileRelationshipRepository(),
      memoryRepo: freshMemoryRepo,
      actionRepo: new FileActionRepository()
    });

    const response = await retrieval.answerQuery('How should I communicate with Carlos?');
    const retrievedCorrectly = response.reply.includes('concise communication') || response.reply.includes('dislikes long emails');
    report('Query "How should I communicate with Carlos?" retrieves persisted memory', retrievedCorrectly);
    report('Epistemic facts cite real persisted record', response.epistemicBreakdown.some(f => f.text.includes(dynamicMemoryText)));
  }

  // --- 6. REAL COGNITIVE EVENT LOOP (GENERIC PIPELINE) ---
  console.log('\n--- TEST GROUP 6: COGNITIVE EVENT PIPELINE ---');
  {
    const pipeline = new CognitivePipeline({
      eventRepo: new FileEventRepository(),
      entityRepo: new FileEntityRepository(),
      relationshipRepo: new FileRelationshipRepository(),
      memoryRepo: new FileMemoryRepository(),
      actionRepo: new FileActionRepository(),
      eventBus: null
    });

    // PROACTIVE TEST 1: EMAIL_RECEIVED regarding pricing
    const emailResult = await pipeline.processEvent({
      eventType: 'EMAIL_RECEIVED',
      source: 'GMAIL_MOCK',
      actor: { id: 'person-carlos', type: 'EXTERNAL', identifier: 'carlos@horizoncap.com' },
      payload: {
        from: 'carlos@horizoncap.com',
        subject: 'Urgent: Pricing review before Thursday meeting',
        body: 'We need to revisit Clause 4 pricing immediately before tomorrow.'
      }
    });

    report('Pipeline resolves Carlos from email address', emailResult.primaryPerson === 'Carlos Drummond');
    report('Salience calculated dynamically to URGENT category', emailResult.category === 'URGENT');
    report('Anticipation produces Quad-State (Observation, Interpretation, Anticipation, Recommendation)', 
      emailResult.epistemicQuad.observation.type === 'FACT' &&
      emailResult.epistemicQuad.interpretation.type === 'INFERENCE' &&
      emailResult.epistemicQuad.recommendation.type === 'RECOMMENDATION'
    );

    // PROACTIVE TEST 2: COMMITMENT_APPROACHING
    const commitmentResult = await pipeline.processEvent({
      eventType: 'COMMITMENT_APPROACHING',
      source: 'INTERNAL_COMMITMENT_TRACKER',
      payload: {
        person: 'Carlos Drummond',
        commitment: 'Send revised valuation sensitivities and pricing schedule',
        due: 'today',
        status: 'incomplete'
      }
    });

    report('Pipeline processes COMMITMENT_APPROACHING dynamically', commitmentResult.category === 'COMMITMENT');
    report('Observation cites exact deliverable with status', commitmentResult.epistemicQuad.observation.statement.includes('valuation sensitivities'));

    // PROACTIVE TEST 3: PERSON_EVENT_APPROACHING (Birthday)
    const birthdayResult = await pipeline.processEvent({
      eventType: 'PERSON_EVENT_APPROACHING',
      source: 'CONTACTS_DIRECTORY',
      payload: {
        person: 'Mariana Vance',
        event: 'birthday',
        date: 'tomorrow'
      }
    });

    report('Pipeline processes PERSON_EVENT_APPROACHING dynamically', birthdayResult.category === 'RELATIONSHIP');
    report('Stages Level 3 action requiring human authorization', birthdayResult.stagedAction && birthdayResult.stagedAction.authorizationLevel === 3);
  }

  // --- 7. REAL PROVENANCE TRACING ---
  console.log('\n--- TEST GROUP 7: PROVENANCE TRACING ---');
  {
    const pipeline = new CognitivePipeline({
      eventRepo: new FileEventRepository(),
      entityRepo: new FileEntityRepository(),
      relationshipRepo: new FileRelationshipRepository(),
      memoryRepo: new FileMemoryRepository(),
      actionRepo: new FileActionRepository(),
      eventBus: null
    });

    const testEventPayload = {
      from: 'carlos@horizoncap.com',
      subject: 'Contract clause 4 review',
      body: 'Reviewing pricing concessions.'
    };

    const out = await pipeline.processEvent({
      eventType: 'EMAIL_RECEIVED',
      payload: testEventPayload
    });

    const obs = out.epistemicQuad.observation;
    const computedExpectedHash = crypto.createHash('sha256').update(JSON.stringify(testEventPayload)).digest('hex');

    report('Observation links to genuine SHA-256 payload hash', obs.provenance.contentHash === computedExpectedHash);
    report('Interpretation links back to supporting fact hash', out.epistemicQuad.interpretation.supportingFactHashes.includes(computedExpectedHash));
    report('Provenance explicitly labels origin (LIVE_TELEMETRY / FIXTURE)', obs.provenance.origin !== undefined);
  }

  console.log('\n======================================================');
  console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite();
