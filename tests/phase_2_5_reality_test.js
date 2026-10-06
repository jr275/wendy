import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every run gets its own data directory: tests never touch the project's data/.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wendy-legacy-test-'));
process.env.WENDY_DATA_DIR = DATA_DIR;

const {
  FileEntityRepository,
  FileRelationshipRepository,
  FileEventRepository,
  FileActionRepository,
  FileIdempotencyRepository,
  FileAuditRepository,
  FileMemoryRepository,
  ActionState
} = await import('../src/repositories/fileStorage.js');
const { initializeDatabaseWithFixtures } = await import('../src/sensory/fixtures.js');
const { CognitivePipeline } = await import('../src/cognition/cognitivePipeline.js');
const { ReasoningEngine } = await import('../src/cognition/reasoningEngine.js');
const { ActionAdapters } = await import('../src/governance/actionAdapters.js');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${name}\n        ${err.message}`);
    failed++;
  }
}

const ledgerFile = path.join(DATA_DIR, 'audit_ledger.json');
const headFile = path.join(DATA_DIR, 'audit_head.json');
const readLedger = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf-8'));
const writeLedger = (blocks) => fs.writeFileSync(ledgerFile, JSON.stringify(blocks));

async function freshLedgerWithBlocks(n) {
  fs.rmSync(ledgerFile, { force: true });
  fs.rmSync(headFile, { force: true });
  const repo = new FileAuditRepository();
  for (let i = 0; i < n; i++) {
    await repo.appendBlock({ eventType: 'TEST', actionId: `a${i}`, actorId: 'tester', authorizationLevel: 3, payload: { i } });
  }
  return readLedger();
}

const newPipeline = () => new CognitivePipeline({
  eventRepo: new FileEventRepository(),
  entityRepo: new FileEntityRepository(),
  relationshipRepo: new FileRelationshipRepository(),
  memoryRepo: new FileMemoryRepository(),
  actionRepo: new FileActionRepository(),
  eventBus: null
});

console.log(`\nLEGACY PROTOTYPE TEST SUITE (data dir: ${DATA_DIR})\n`);

console.log('--- persistence & boot ---');
await check('first boot seeds labeled fixtures; second boot does not reseed', async () => {
  const repos = { entityRepo: new FileEntityRepository(), relationshipRepo: new FileRelationshipRepository(), memoryRepo: new FileMemoryRepository(), actionRepo: new FileActionRepository() };
  const boot1 = await initializeDatabaseWithFixtures(repos);
  const count1 = await repos.entityRepo.countPeople();
  const boot2 = await initializeDatabaseWithFixtures(repos);
  assert.strictEqual(boot1.seeded, true);
  assert.strictEqual(boot2.seeded, false);
  assert.strictEqual(await repos.entityRepo.countPeople(), count1);
  for (const p of await repos.entityRepo.getAllPeople()) assert.strictEqual(p.provenance.sourceType, 'DEVELOPMENT_FIXTURE');
});
await check('fixtures do not seed pre-written staged actions', async () => {
  assert.deepStrictEqual(await new FileActionRepository().listActions(), []);
});
await check('corrupt state file fails closed instead of loading empty state', async () => {
  const f = path.join(DATA_DIR, 'idempotency.json');
  fs.writeFileSync(f, '{not json');
  assert.throws(() => new FileIdempotencyRepository(), /Corrupt state file/);
  fs.rmSync(f);
});

console.log('\n--- action lifecycle ---');
await check('legal transitions persist across restart', async () => {
  const repo = new FileActionRepository();
  await repo.saveAction({ actionId: 'act-1', actionType: 'SEND_EMAIL', authorizationLevel: 3, state: ActionState.PROPOSED, preview: { body: 'x' } });
  await repo.updateActionState('act-1', ActionState.AWAITING_APPROVAL);
  await repo.updateActionState('act-1', ActionState.REJECTED, { rejectionReason: 'no' });
  const loaded = await new FileActionRepository().getAction('act-1');
  assert.strictEqual(loaded.state, ActionState.REJECTED);
  assert.strictEqual(loaded.rejectionReason, 'no');
});
await check('illegal transition REJECTED -> APPROVED is refused', async () => {
  await assert.rejects(new FileActionRepository().updateActionState('act-1', ActionState.APPROVED), /Illegal action transition/);
});
await check('saveAction cannot resurrect a terminal action', async () => {
  await assert.rejects(new FileActionRepository().saveAction({ actionId: 'act-1', state: ActionState.AWAITING_APPROVAL }), /cannot change state/);
});

console.log('\n--- dispatch honesty & idempotency ---');
const adapters = () => new ActionAdapters({ idempotencyRepo: new FileIdempotencyRepository(), auditRepo: new FileAuditRepository(), memoryRepo: new FileMemoryRepository(), actionRepo: new FileActionRepository() });
await check('without a provider dispatch reports NOT_EXECUTED and writes no "sent" memory', async () => {
  const before = (await new FileMemoryRepository().queryEpisodic({ limit: 1000 })).length;
  const r = await adapters().dispatchEmail({ actionId: 'act-d', recipient: 'a@b.c', subject: 's', bodyText: 'v1', actorId: 'p' });
  assert.strictEqual(r.status, 'NOT_EXECUTED');
  assert.strictEqual(r.result.executed, false);
  assert.strictEqual((await new FileMemoryRepository().queryEpisodic({ limit: 1000 })).length, before);
});
await check('idempotency key depends on action identity, not on edited content', async () => {
  assert.strictEqual(ActionAdapters.idempotencyKeyFor('act-d'), ActionAdapters.idempotencyKeyFor('act-d'));
  const idem = new FileIdempotencyRepository();
  await idem.recordAttempt('k', 'act-x', 'DISPATCH_EMAIL', 'h1');
  await idem.completeAttempt('k', { ok: true });
  const again = await new FileIdempotencyRepository().recordAttempt('k', 'act-x', 'DISPATCH_EMAIL', 'h2-edited');
  assert.strictEqual(again.alreadyCompleted, true);
});
await check('IN_PROGRESS record left by a crash is reported in-doubt, never re-run', async () => {
  await new FileIdempotencyRepository().recordAttempt('k-crash', 'act-c', 'DISPATCH_EMAIL', 'h');
  const after = await new FileIdempotencyRepository().recordAttempt('k-crash', 'act-c', 'DISPATCH_EMAIL', 'h');
  assert.strictEqual(after.inDoubt, true);
});

console.log('\n--- audit ledger (fail closed) ---');
await check('untampered ledger verifies', async () => {
  await freshLedgerWithBlocks(4);
  assert.strictEqual((await new FileAuditRepository().verifyLedgerIntegrity()).valid, true);
});
const tamperCases = {
  'altered payload': b => { b[1].payload.i = 99; },
  'altered actorId (previously unhashed)': b => { b[1].actorId = 'attacker'; },
  'altered authorizationLevel (previously unhashed)': b => { b[1].authorizationLevel = 0; },
  'altered verificationStatus (previously unhashed)': b => { b[1].verificationStatus = 'FORGED'; },
  'altered entryHash': b => { b[2].entryHash = 'f'.repeat(64); },
  'altered prevHash': b => { b[2].prevHash = 'f'.repeat(64); },
  'removed middle block': b => { b.splice(1, 1); },
  'duplicated block': b => { b.splice(2, 0, { ...b[1] }); },
  'reordered blocks': b => { [b[1], b[2]] = [b[2], b[1]]; },
  'truncated tail': b => { b.pop(); }
};
for (const [name, mutate] of Object.entries(tamperCases)) {
  await check(`detects ${name}`, async () => {
    const blocks = await freshLedgerWithBlocks(4);
    mutate(blocks);
    writeLedger(blocks);
    const result = await new FileAuditRepository().verifyLedgerIntegrity();
    assert.strictEqual(result.valid, false, `expected invalid, got ${JSON.stringify(result)}`);
  });
}
await check('corrupted ledger file is invalid (not an empty valid ledger)', async () => {
  await freshLedgerWithBlocks(2);
  fs.writeFileSync(ledgerFile, '{not json');
  assert.strictEqual((await new FileAuditRepository().verifyLedgerIntegrity()).valid, false);
});
await check('deleted ledger file with surviving head anchor is invalid', async () => {
  await freshLedgerWithBlocks(2);
  fs.rmSync(ledgerFile);
  assert.strictEqual((await new FileAuditRepository().verifyLedgerIntegrity()).valid, false);
});
await check('appending to a compromised ledger is refused', async () => {
  const blocks = await freshLedgerWithBlocks(2);
  blocks[0].payload.i = 7;
  writeLedger(blocks);
  await assert.rejects(new FileAuditRepository().appendBlock({ eventType: 'X', actionId: 'a', actorId: 'b', authorizationLevel: 1, payload: {} }), /compromised/);
});

console.log('\n--- legacy pipeline (no keyword intelligence, no crashes) ---');
await check('unknown sender does not crash and produces no staged action', async () => {
  const out = await newPipeline().processEvent({ eventType: 'EMAIL_RECEIVED', payload: { from: 'stranger@x.com', subject: 'pricing', body: 'urgent pricing' } });
  assert.strictEqual(out.primaryPerson, null);
  assert.strictEqual(out.stagedAction, null);
});
await check('birthday event for unknown person does not crash', async () => {
  const out = await newPipeline().processEvent({ eventType: 'PERSON_EVENT_APPROACHING', payload: { person: 'Nobody Known', event: 'birthday' } });
  assert.strictEqual(out.stagedAction, null);
});
await check('reasoning layers are reported NOT_IMPLEMENTED (no canned statements)', async () => {
  const out = await newPipeline().processEvent({ eventType: 'EMAIL_RECEIVED', payload: { from: 'carlos@horizoncap.com', subject: 'pricing', body: 'urgent pricing before the meeting' } });
  for (const layer of ['interpretation', 'anticipation', 'recommendation']) {
    assert.strictEqual(out.epistemicQuad[layer].status, 'NOT_IMPLEMENTED');
    assert.strictEqual(out.epistemicQuad[layer].statement, null);
  }
});
await check('duplicate eventId is not reprocessed (no repeated memory writes)', async () => {
  const before = (await new FileMemoryRepository().queryEpisodic({ limit: 1000 })).length;
  const p = newPipeline();
  const ev = { eventId: 'evt-fixed', eventType: 'EMAIL_RECEIVED', payload: { from: 'carlos@horizoncap.com', subject: 'x', body: 'y' } };
  const first = await p.processEvent(ev);
  const second = await newPipeline().processEvent(ev);
  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual((await new FileMemoryRepository().queryEpisodic({ limit: 1000 })).length, before + 1);
});
await check('dossier is not hardcoded', async () => {
  const engine = new ReasoningEngine({ entityRepo: new FileEntityRepository(), relationshipRepo: new FileRelationshipRepository(), eventRepo: new FileEventRepository(), actionRepo: new FileActionRepository(), memoryRepo: new FileMemoryRepository() });
  const dossier = await engine.generateExecutiveDossier();
  assert.strictEqual(dossier.quadrants, null);
  assert.strictEqual(dossier.status, 'NOT_IMPLEMENTED');
});

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\nRESULTS: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
