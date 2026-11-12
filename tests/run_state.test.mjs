import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createState, applyEvent, decide, updateFile } from '../skills/product-listing/scripts/run_state.mjs';

const now = '2026-11-12T12:00:00.000Z';
const future = '2026-11-12T12:15:00.000Z';
function harness(recordIds = ['recA'], requireFinalVerification = false) {
  let state = createState({ batchId: 'mock-batch', recordIds, requireFinalVerification }, now);
  return {
    get state() { return state; },
    event(type, fields = {}) {
      state = applyEvent(state, { expectedRevision: state.revision, type, ...fields }, now);
      return state;
    },
    work(type, fields = {}) {
      return this.event(type, { workerId: state.worker.id, generation: state.worker.generation, recordId: 'recA', ...fields });
    },
    assign() { return this.event('assign', { workerId: 'worker-one' }); },
    done() { return this.work('worker_report', { kind: 'done' }); },
    decision() { return decide(state, now); },
    receipt(recordId = 'recA', itemId = 'item-one') {
      this.work('begin_submit', { recordId, attemptId: `attempt-${recordId}` });
      this.work('receipt', { recordId, itemId, evidence: 'mock success page', nextCheckAt: future });
    },
    writeback(recordId = 'recA') {
      this.work('writeback', { recordId, evidence: 'mock readback ID and status match', readbackConfirmed: true });
    },
  };
}

test('a worker ending its turn does not complete pending business work', () => {
  const h = harness(); h.assign(); h.done();
  assert.equal(h.decision().canFinish, false);
  assert.equal(h.decision().orchestrationAction, 'followup_worker');
  assert.equal(h.decision().actions[0].action, 'resume');
});

test('a minimized window is recovered without asking the user to continue', () => {
  const h = harness(); h.assign();
  h.work('fault', { code: 'window_minimized', message: 'screenshot unavailable', recoverable: true });
  h.work('worker_report', { kind: 'interrupted' });
  assert.equal(h.decision().actions[0].action, 'recover');
  assert.equal(h.decision().orchestrationAction, 'followup_worker');
  h.work('worker_report', { kind: 'running' });
  h.work('step', { step: 'window restored', progressKey: 'new snapshot' });
  assert.equal(h.decision().actions[0].action, 'resume');
});

test('unchanged recovery errors require diagnosis rather than premature finish or endless retry', () => {
  const h = harness(); h.assign();
  for (let i = 0; i < 2; i++) h.work('fault', { code: 'stale_ref', message: 'old selector', recoverable: true });
  h.done();
  assert.equal(h.decision().actions[0].action, 'diagnose');
  assert.equal(h.decision().orchestrationAction, 'diagnose_then_resume');
  assert.equal(h.decision().canFinish, false);
  assert.throws(() => h.event('block', { recordIds: ['recA'], kind: 'tool_error', evidence: 'two failures', nextAction: 'ask user' }), /ordinary faults/);
});

test('an unknown tool fault remains actionable and is not relabeled as platform rejection', () => {
  const h = harness(); h.assign(); h.work('fault', { code: 'unknown', message: 'unclassified', recoverable: false }); h.done();
  assert.equal(h.state.items[0].status, 'pending');
  assert.equal(h.decision().actions[0].action, 'diagnose');
  assert.equal(h.decision().canFinish, false);
});

test('worker replacement requires old worker termination and fences stale reports', () => {
  const h = harness(); h.assign();
  assert.throws(() => h.event('assign', { workerId: 'replacement' }), /previous worker/);
  h.event('assign', { workerId: 'replacement', previousWorkerStopped: true });
  assert.throws(() => h.event('step', { workerId: 'worker-one', generation: 1, recordId: 'recA', step: 'old', progressKey: 'old' }), /stale/);
  assert.equal(h.state.worker.generation, 2);
});

test('submit intent survives a separate process and prevents a duplicate platform call', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-checkpoint-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const stateFile = path.join(temp, 'state.json');
  updateFile(stateFile, 'init', { batchId: 'process-test', recordIds: ['recA'] });
  updateFile(stateFile, 'apply', { expectedRevision: 0, type: 'assign', workerId: 'worker-one' });
  updateFile(stateFile, 'apply', { expectedRevision: 1, type: 'begin_submit', workerId: 'worker-one', generation: 1, recordId: 'recA', attemptId: 'one' });
  const cli = fileURLToPath(new URL('../skills/product-listing/scripts/run_state.mjs', import.meta.url));
  const inspect = spawnSync(process.execPath, [cli, 'inspect', stateFile], { encoding: 'utf8' });
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.equal(JSON.parse(inspect.stdout).actions[0].action, 'reconcile');
  assert.throws(() => updateFile(stateFile, 'apply', { expectedRevision: 2, type: 'begin_submit', workerId: 'worker-one', generation: 1, recordId: 'recA', attemptId: 'two' }), /reconcile first/);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).revision, 2);
});

test('a single empty search cannot reset an uncertain submission', () => {
  const h = harness(); h.assign(); h.work('begin_submit', { attemptId: 'one' });
  assert.throws(() => h.event('reconcile_not_submitted', { recordId: 'recA', evidence: 'empty search' }), /not conclusive/);
  h.event('reconcile_not_submitted', { recordId: 'recA', evidence: 'platform explicitly rejected this attempt without creating an item', conclusive: true });
  h.work('begin_submit', { attemptId: 'two' });
  assert.equal(h.state.items[0].attemptId, 'two');
});

test('writeback failure resumes only writeback and retains the platform item ID', () => {
  const h = harness(); h.assign(); h.receipt();
  for (let i = 0; i < 3; i++) h.work('fault', { code: 'writeback_failed', message: 'transport unavailable', recoverable: true });
  h.done();
  assert.equal(h.decision().actions[0].action, 'writeback');
  assert.equal(h.decision().orchestrationAction, 'diagnose_then_resume');
  assert.equal(h.decision().actions[0].itemId, 'item-one');
  h.work('worker_report', { kind: 'running' });
  assert.throws(() => h.work('begin_submit', { attemptId: 'duplicate' }), /already attempted/);
  assert.throws(() => h.work('writeback', { evidence: 'request accepted' }), /read back/);
  h.writeback(); h.done();
  assert.equal(h.decision().canFinish, true);
  assert.equal(h.decision().actions[0].action, 'awaiting_platform');
});

test('common platform blockers affect only explicit records and independent work continues', () => {
  const h = harness(['recA', 'recB', 'recC']); h.assign();
  h.event('block', { recordIds: ['recA', 'recB'], kind: 'platform', evidence: 'mock same-SPU limit', nextAction: 'resolve limit' });
  h.writeback('recA'); h.writeback('recB'); h.done();
  assert.deepEqual(h.decision().counts, { blocked: 2, resume: 1 });
  assert.equal(h.decision().canFinish, false);
  assert.equal(h.decision().orchestrationAction, 'followup_worker');
});

test('unknown submissions need explicit rejection and successes cannot be overwritten by a blocker', () => {
  const h = harness(['recA', 'recB']); h.assign(); h.receipt();
  assert.throws(() => h.event('block', { recordIds: ['recA'], kind: 'platform', evidence: 'limit', nextAction: 'later' }), /explicit blocker stage/);
  assert.throws(() => h.event('block', { recordIds: ['recA'], kind: 'platform', stage: 'verification', evidence: 'limit', nextAction: 'later', submissionRejected: true }), /erase submitted success/);
  h.work('begin_submit', { recordId: 'recB', attemptId: 'B' });
  assert.throws(() => h.event('block', { recordIds: ['recB'], kind: 'auth', evidence: 'lost login', nextAction: 'login' }), /must be reconciled/);
  h.event('block', { recordIds: ['recB'], kind: 'platform', stage: 'submission_resolution', evidence: 'explicit rejection', nextAction: 'resolve limit', submissionRejected: true });
  assert.equal(h.state.items[1].status, 'blocked');
});

test('user stop halts dispatch and needs explicit resume evidence', () => {
  const h = harness(); h.assign(); h.event('stop', { evidence: 'user requested stop' });
  assert.equal(h.decision().orchestrationAction, 'stop_worker');
  assert.equal(h.decision().canFinish, false);
  assert.throws(() => h.work('step', { step: 'continue anyway', progressKey: 'x' }), /user stopped/);
  h.work('worker_report', { kind: 'interrupted' });
  assert.equal(h.decision().orchestrationAction, 'respect_stop');
  assert.throws(() => h.event('resume_user'), /evidence/);
  h.event('resume_user', { evidence: 'user explicitly resumed task' });
  assert.equal(h.decision().orchestrationAction, 'followup_worker');
});

test('all records reconcile into complete, blocked, and documented future checks', () => {
  const h = harness(['recA', 'recB', 'recC']); h.assign(); h.receipt();
  h.work('verify', { itemId: 'item-one', outcome: 'warehouse', evidence: 'warehouse listing' }); h.writeback();
  h.receipt('recB', 'item-two'); h.writeback('recB');
  h.event('block', { recordIds: ['recC'], kind: 'missing_input', evidence: 'required field absent in linked sources', nextAction: 'provide actual value' }); h.writeback('recC'); h.done();
  assert.equal(h.decision().canFinish, true);
  assert.deepEqual(h.decision().counts, { complete: 1, awaiting_platform: 1, blocked: 1 });
  assert.equal(Object.values(h.decision().counts).reduce((a, b) => a + b), 3);
});

test('due platform checks cannot be silently skipped', () => {
  const h = harness(); h.assign(); h.receipt(); h.writeback(); h.done();
  const decision = decide(h.state, '2026-11-12T12:16:00Z');
  assert.equal(decision.canFinish, false);
  assert.equal(decision.actions[0].action, 'verify');
});

test('final-status requests wait for the scheduled check instead of declaring submission complete', () => {
  const h = harness(['recA'], true); h.assign(); h.receipt(); h.writeback(); h.done();
  assert.equal(h.decision().canFinish, false);
  assert.equal(h.decision().orchestrationAction, 'wait_until_due');
});

test('duplicate and replacement platform IDs are rejected', () => {
  const h = harness(['recA', 'recB']); h.assign(); h.receipt();
  assert.throws(() => h.work('receipt', { itemId: 'replacement', evidence: 'wrong page' }), /cannot replace/);
  h.work('begin_submit', { recordId: 'recB', attemptId: 'B' });
  assert.throws(() => h.work('receipt', { recordId: 'recB', itemId: 'item-one', evidence: 'wrong page' }), /already belongs/);
});

test('concurrent or stale file writes leave the saved checkpoint intact', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-lock-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'state.json');
  updateFile(file, 'init', { batchId: 'lock-test', recordIds: ['recA'] });
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => updateFile(file, 'init', { batchId: 'overwrite', recordIds: ['recB'] }), /already exists/);
  assert.throws(() => updateFile(file, 'apply', { type: 'assign', expectedRevision: 10, workerId: 'wrong' }), /revision conflict/);
  fs.writeFileSync(file + '.lock', 'active owner');
  assert.throws(() => updateFile(file, 'apply', { type: 'assign', expectedRevision: 0, workerId: 'wrong' }), /locked/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), 'active owner');
});

test('finished work cannot end while the browser still reports agent control', () => {
  const h = harness(); h.assign(); h.event('control_acquired', { spaceId: 'mock-space', evidence: 'agent owns space' });
  h.receipt(); h.work('verify', { itemId: 'item-one', outcome: 'warehouse', evidence: 'warehouse page' }); h.writeback(); h.done();
  assert.equal(h.decision().canFinish, false);
  assert.equal(h.decision().orchestrationAction, 'cleanup_required');
  assert.equal(h.decision().cleanupMethod, 'finish');
  assert.throws(() => h.event('control_released', { method: 'finish' }), /evidence/);
  h.event('control_released', { method: 'finish', evidence: 'finish resolved and task space no longer agent controlled' });
  assert.equal(h.decision().canFinish, true);
});

test('user stop and real blockers require handOff rather than successful finish', () => {
  const h = harness(); h.assign(); h.event('control_acquired', { spaceId: 'mock-space', evidence: 'agent owns space' });
  h.event('block', { recordIds: ['recA'], kind: 'auth', evidence: 'verification requires user', nextAction: 'user verifies login', writebackUnavailableEvidence: 'account cannot write before verification' }); h.done();
  assert.equal(h.decision().cleanupMethod, 'handOff');
  assert.throws(() => h.event('control_released', { method: 'finish', evidence: 'wrong cleanup' }), /use handOff/);
  h.event('control_released', { method: 'handOff', evidence: 'agentDelegatedToUser observed' });
  assert.equal(h.decision().canFinish, true);
});

test('ordinary interruptions retain browser ownership for automatic recovery', () => {
  const h = harness(); h.assign(); h.event('control_acquired', { spaceId: 'mock-space', evidence: 'agent owns space' });
  h.work('fault', { code: 'missing_image', message: 'crop needed', recoverable: true }); h.done();
  assert.equal(h.decision().orchestrationAction, 'followup_worker');
  assert.equal(h.decision().cleanupMethod, null);
  assert.throws(() => h.event('control_released', { method: 'handOff', evidence: 'ask user to crop' }), /ordinary interruption/);
});

test('one blocked item cannot hand off browser control before independent items finish', () => {
  const h = harness(['recA', 'recB']); h.assign();
  h.event('control_acquired', { spaceId: 'mock-space', evidence: 'agent owns space' });
  h.event('block', { recordIds: ['recA'], kind: 'platform', evidence: 'limit on A only', nextAction: 'resolve limit' });
  h.writeback('recA'); h.done();
  assert.throws(() => h.event('control_released', { method: 'handOff', evidence: 'premature handoff' }), /finish independent items/);
  assert.equal(h.decision().canFinish, false);
  assert.equal(h.decision().browserControl.held, true);
});

test('CLI accepts a UTF-8 BOM from Windows PowerShell JSON files', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-bom-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'state.json'), request = path.join(temp, 'request.json');
  fs.writeFileSync(request, '\uFEFF' + JSON.stringify({ batchId: 'bom-test', recordIds: ['recA'] }));
  const cli = fileURLToPath(new URL('../skills/product-listing/scripts/run_state.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'init', file, request], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).orchestrationAction, 'assign_worker');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).batchId, 'bom-test');
});

test('an existing product is recorded without fabricating a submit intent or a new listing', () => {
  const h = harness(); h.assign();
  h.work('existing', { itemId: 'historical-item', evidence: 'SKU matched the existing platform product' });
  assert.equal(h.state.items[0].attemptId, null);
  assert.equal(h.state.history.some(event => event.type === 'begin_submit'), false);
  assert.equal(h.decision().actions[0].origin, 'existing');
  assert.equal(h.decision().actions[0].existingEvidence, 'SKU matched the existing platform product');
  assert.throws(() => h.work('begin_submit', { attemptId: 'duplicate' }), /already attempted/);
  assert.throws(() => h.work('receipt', { itemId: 'historical-item', evidence: 'not a new receipt' }), /attempted submission/);
  h.work('verify', { itemId: 'historical-item', outcome: 'on_sale', evidence: 'existing item verified on sale' });
  h.writeback(); h.done();
  assert.equal(h.decision().canFinish, true);
  assert.equal(h.decision().actions[0].origin, 'existing');
});

test('resolving a missing input restores the exact preparation step', () => {
  const h = harness(); h.assign();
  h.work('step', { step: 'fill dimensions', progressKey: 'prepared images' });
  h.event('block', { recordIds: ['recA'], kind: 'missing_input', evidence: 'dimensions absent from sources', nextAction: 'supply dimensions' });
  h.writeback(); h.done();
  assert.throws(() => h.event('unblock', { recordIds: ['recA'] }), /evidence/);
  h.event('unblock', { recordIds: ['recA'], evidence: 'user provided verified dimensions' });
  assert.equal(h.state.items[0].status, 'preparing');
  assert.equal(h.state.items[0].step, 'fill dimensions');
  assert.equal(h.state.items[0].progressKey, 'prepared images');
  assert.equal(h.state.items[0].resolvedBlockers[0].blockedWritebackEvidence, 'mock readback ID and status match');
  assert.equal(h.decision().orchestrationAction, 'followup_worker');
});

test('a login blocker after submission permits handOff and resumes verification with the saved ID', () => {
  const h = harness(); h.assign(); h.receipt(); h.writeback();
  h.event('control_acquired', { spaceId: 'mock-space', evidence: 'agent owns space' });
  h.event('block', { recordIds: ['recA'], kind: 'auth', stage: 'verification',
    evidence: 'platform requires verification before checking item status', nextAction: 'user verifies login',
    writebackUnavailableEvidence: 'account verification also prevents table update' }); h.done();
  assert.equal(h.decision().actions[0].businessStatus, 'submitted');
  assert.equal(h.decision().actions[0].itemId, 'item-one');
  assert.equal(h.decision().cleanupMethod, 'handOff');
  h.event('control_released', { method: 'handOff', evidence: 'agentDelegatedToUser observed' });
  assert.equal(h.decision().canFinish, true);
  h.event('unblock', { recordIds: ['recA'], evidence: 'user completed login and read access restored' });
  assert.equal(h.state.items[0].status, 'submitted');
  assert.equal(h.state.items[0].receiptEvidence, 'mock success page');
  assert.equal(h.state.items[0].attemptId, 'attempt-recA');
  assert.equal(h.decision().actions[0].action, 'writeback');
  h.work('worker_report', { kind: 'running' }); h.writeback(); h.done();
  assert.equal(decide(h.state, '2026-11-12T12:16:00Z').actions[0].action, 'verify');
});

test('a blocked writeback retains verified success and unblocks only the missing writeback', () => {
  const h = harness(); h.assign(); h.receipt();
  h.work('verify', { itemId: 'item-one', outcome: 'warehouse', evidence: 'warehouse confirmed before writeback outage' });
  h.event('block', { recordIds: ['recA'], kind: 'auth', stage: 'writeback', evidence: 'table authorization revoked',
    nextAction: 'restore permission', writebackUnavailableEvidence: 'table API denies writes' }); h.done();
  assert.equal(h.decision().actions[0].businessStatus, 'verified');
  h.event('unblock', { recordIds: ['recA'], evidence: 'table authorization restored' });
  assert.equal(h.decision().actions[0].action, 'writeback');
  assert.equal(h.state.items[0].verificationEvidence, 'warehouse confirmed before writeback outage');
  h.work('worker_report', { kind: 'running' }); h.writeback(); h.done();
  assert.equal(h.decision().canFinish, true);
  assert.throws(() => h.event('block', { recordIds: ['recA'], kind: 'auth', stage: 'writeback', evidence: 'unrelated outage', nextAction: 'ignore' }), /completed work/);
});

test('an unknown submission paused for login resumes reconciliation and never automatically resubmits', () => {
  const h = harness(); h.assign(); h.work('begin_submit', { attemptId: 'uncertain-click' });
  h.event('block', { recordIds: ['recA'], kind: 'auth', stage: 'submission_resolution', evidence: 'login expired during result lookup',
    nextAction: 'restore login', writebackUnavailableEvidence: 'cannot record blocked state in table' }); h.done();
  assert.equal(h.decision().actions[0].businessStatus, 'submit_unknown');
  assert.equal(h.decision().canFinish, true);
  h.event('unblock', { recordIds: ['recA'], evidence: 'login restored' });
  assert.equal(h.decision().actions[0].action, 'reconcile');
  assert.equal(h.state.items[0].attemptId, 'uncertain-click');
  h.work('worker_report', { kind: 'running' });
  assert.throws(() => h.work('begin_submit', { attemptId: 'unsafe-retry' }), /already attempted/);
  h.work('receipt', { itemId: 'recovered-item', evidence: 'exact SKU and submission time matched the result' });
  assert.equal(h.decision().actions[0].origin, 'new');
});

test('only an explicit platform rejection makes an unknown submission retryable after unblock', () => {
  const h = harness(); h.assign(); h.work('begin_submit', { attemptId: 'rejected-click' });
  assert.throws(() => h.event('block', { recordIds: ['recA'], kind: 'platform', stage: 'submission_resolution',
    evidence: 'generic page error', nextAction: 'retry' }), /explicit rejection/);
  h.event('block', { recordIds: ['recA'], kind: 'platform', stage: 'submission_resolution',
    evidence: 'platform expressly rejected creation', nextAction: 'fix rejected field', submissionRejected: true });
  h.writeback(); h.done();
  h.event('unblock', { recordIds: ['recA'], evidence: 'rejected field corrected' });
  assert.equal(h.decision().actions[0].businessStatus, 'pending');
  assert.equal(h.state.items[0].attemptId, 'rejected-click');
  h.work('worker_report', { kind: 'running' }); h.work('begin_submit', { attemptId: 'corrected-click' });
  assert.equal(h.state.items[0].attemptId, 'corrected-click');
  assert.equal(h.state.history.filter(event => event.type === 'begin_submit').length, 2);
});

test('a user stop hands off browser control only after the executor has actually stopped', () => {
  const h = harness(); h.assign();
  h.event('control_acquired', { spaceId: 'mock-space', evidence: 'agent owns space' });
  h.event('stop', { evidence: 'user explicitly requested stop' });
  assert.equal(h.decision().orchestrationAction, 'stop_worker');
  assert.throws(() => h.event('control_released', { method: 'handOff', evidence: 'worker still running' }), /stop the worker/);
  h.work('worker_report', { kind: 'interrupted' });
  assert.equal(h.decision().canFinish, false);
  assert.equal(h.decision().cleanupMethod, 'handOff');
  h.event('control_released', { method: 'handOff', evidence: 'agentDelegatedToUser observed after worker stopped' });
  assert.equal(h.decision().canFinish, true);
  assert.equal(h.decision().orchestrationAction, 'respect_stop');
  assert.equal(h.state.items[0].status, 'pending');
});
