#!/usr/bin/env node
// Local checkpoint and decision helper. It does not call agents, browsers or services.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function text(value, name) {
  requireThat(typeof value === 'string' && value.trim().length > 0, `${name} must be nonempty text`);
  return value;
}
function evidence(value, name = 'evidence') { return text(value, name); }
function itemFor(state, id) {
  const item = state.items.find(item => item.recordId === id);
  requireThat(item, `record outside batch: ${id}`);
  return item;
}
function writer(state, event) {
  requireThat(state.worker && event.workerId === state.worker.id && event.generation === state.worker.generation,
    'stale or unassigned worker generation');
  requireThat(state.worker.status === 'running', 'worker is not running; assign or resume it first');
}
function changed(item) {
  item.writebackVerified = false;
  item.writebackEvidence = null;
  item.writebackUnavailableEvidence = null;
}

export function createState(request, now = new Date().toISOString()) {
  text(request.batchId, 'batchId');
  requireThat(Array.isArray(request.recordIds) && request.recordIds.length > 0, 'recordIds must be nonempty');
  request.recordIds.forEach(id => text(id, 'recordId'));
  requireThat(new Set(request.recordIds).size === request.recordIds.length, 'duplicate record IDs');
  requireThat(request.requireFinalVerification === undefined || typeof request.requireFinalVerification === 'boolean',
    'requireFinalVerification must be boolean');
  return {
    version: 1, batchId: request.batchId, revision: 0, createdAt: now, updatedAt: now,
    requireFinalVerification: request.requireFinalVerification ?? false,
    stopped: false, stopEvidence: null, worker: null, browserControl: null,
    items: request.recordIds.map(recordId => ({
      recordId, status: 'pending', step: 'pending', progressKey: null, fault: null,
      attemptId: null, itemId: null, origin: null, existingEvidence: null,
      receiptEvidence: null, verificationEvidence: null,
      nextCheckAt: null, blocker: null, writebackVerified: false,
      writebackEvidence: null, writebackUnavailableEvidence: null, resolvedBlockers: [],
    })),
    history: [],
  };
}

export function applyEvent(original, event, now = new Date().toISOString()) {
  requireThat(original.version === 1, 'unsupported checkpoint version');
  requireThat(Number.isInteger(event.expectedRevision) && event.expectedRevision === original.revision,
    'revision conflict; reread checkpoint before retrying');
  const state = structuredClone(original);
  const workerEvents = new Set(['step', 'fault', 'begin_submit', 'receipt', 'existing', 'verify', 'writeback']);
  requireThat(!state.stopped || ['resume_user', 'worker_report', 'control_released'].includes(event.type), 'user stopped this batch');
  if (workerEvents.has(event.type)) writer(state, event);
  let item;
  switch (event.type) {
    case 'assign': {
      text(event.workerId, 'workerId');
      if (state.worker) requireThat(event.previousWorkerStopped === true,
        'confirm previous worker and its in-flight operations stopped before assigning');
      state.worker = { id: event.workerId, generation: (state.worker?.generation ?? 0) + 1, status: 'running' };
      break;
    }
    case 'worker_report': {
      requireThat(state.worker && event.workerId === state.worker.id && event.generation === state.worker.generation,
        'stale or unassigned worker generation');
      requireThat(['running', 'interrupted', 'done'].includes(event.kind), 'invalid worker report');
      requireThat(!state.stopped || event.kind !== 'running', 'user stopped this batch');
      state.worker.status = event.kind;
      // A worker ending its turn is not evidence that any business item is complete.
      break;
    }
    case 'control_acquired': {
      text(event.spaceId, 'spaceId'); evidence(event.evidence);
      requireThat(!state.browserControl?.held || state.browserControl.spaceId === event.spaceId,
        'release existing browser control before recording a different space');
      state.browserControl = { spaceId: event.spaceId, held: true, evidence: event.evidence, at: now };
      break;
    }
    case 'control_released': {
      requireThat(state.browserControl?.held, 'no held browser control to release');
      requireThat(['finish', 'handOff'].includes(event.method), 'invalid browser release method');
      evidence(event.evidence);
      const business = decide({ ...state, browserControl: null }, now);
      if (event.method === 'finish') {
        requireThat(business.canFinish && !state.stopped && !state.items.some(item => item.status === 'blocked'),
          'finish requires completed work; use handOff for user stop or real blockers');
      } else {
        requireThat(state.stopped || state.items.some(item => item.status === 'blocked'),
          'ordinary interruption must recover; handOff needs user stop or a real blocker');
        requireThat(business.canFinish, 'stop the worker and finish independent items before handOff');
      }
      state.browserControl = { ...state.browserControl, held: false, method: event.method,
        releaseEvidence: event.evidence, releasedAt: now };
      break;
    }
    case 'step': {
      item = itemFor(state, event.recordId);
      requireThat(['pending', 'preparing'].includes(item.status), 'cannot prepare an attempted or terminal item');
      text(event.step, 'step'); text(event.progressKey, 'progressKey');
      if (item.progressKey !== event.progressKey) item.fault = null;
      item.progressKey = event.progressKey;
      item.step = event.step;
      item.status = 'preparing';
      break;
    }
    case 'fault': {
      item = itemFor(state, event.recordId);
      text(event.code, 'code'); text(event.message, 'message');
      requireThat(typeof event.recoverable === 'boolean', 'recoverable must be boolean');
      const same = item.fault?.code === event.code && item.fault?.progressKey === item.progressKey;
      item.fault = { code: event.code, message: event.message, recoverable: event.recoverable,
        progressKey: item.progressKey, repeats: same ? item.fault.repeats + 1 : 1, at: now };
      break;
    }
    case 'begin_submit': {
      item = itemFor(state, event.recordId);
      requireThat(['pending', 'preparing'].includes(item.status) && !item.itemId, 'submission already attempted; reconcile first');
      text(event.attemptId, 'attemptId');
      requireThat(!state.history.some(entry => entry.type === 'begin_submit' && entry.attemptId === event.attemptId),
        'attemptId must be new');
      item.attemptId = event.attemptId;
      item.origin = 'new';
      item.status = 'submit_unknown'; item.step = 'submission intent recorded'; item.fault = null;
      changed(item);
      break;
    }
    case 'receipt':
    case 'existing': {
      item = itemFor(state, event.recordId);
      if (event.type === 'existing') {
        requireThat(['pending', 'preparing'].includes(item.status) && !item.itemId,
          'existing requires a pre-submission duplicate check');
      } else {
        requireThat(item.attemptId && item.origin !== 'existing' && ['submit_unknown', 'submitted'].includes(item.status),
          'receipt needs an attempted submission');
      }
      text(event.itemId, 'itemId'); evidence(event.evidence);
      requireThat(!item.itemId || item.itemId === event.itemId, 'cannot replace a platform item ID');
      requireThat(!state.items.some(other => other.recordId !== item.recordId && other.itemId === event.itemId),
        'platform item ID already belongs to another batch record');
      if (event.nextCheckAt != null) requireThat(Number.isFinite(Date.parse(event.nextCheckAt)), 'invalid nextCheckAt');
      item.itemId = event.itemId; item.origin = event.type === 'existing' ? 'existing' : 'new';
      if (event.type === 'existing') item.existingEvidence = event.evidence;
      else item.receiptEvidence = event.evidence;
      item.status = 'submitted'; item.step = event.type === 'existing' ? 'existing product found' : 'receipt saved'; item.fault = null;
      item.nextCheckAt = event.nextCheckAt ?? null; changed(item);
      break;
    }
    case 'reconcile_not_submitted': {
      item = itemFor(state, event.recordId);
      requireThat(item.status === 'submit_unknown' && !item.itemId, 'only unknown submissions can be reconciled as absent');
      requireThat(event.conclusive === true, 'one empty search is not conclusive evidence');
      evidence(event.evidence);
      item.status = 'pending'; item.step = 'confirmed not submitted'; item.fault = null;
      break;
    }
    case 'verify': {
      item = itemFor(state, event.recordId);
      requireThat(item.itemId && ['submitted', 'verified'].includes(item.status), 'verify requires a saved platform item ID');
      requireThat(event.itemId === item.itemId, 'verification item ID mismatch');
      requireThat(['warehouse', 'on_sale'].includes(event.outcome), 'invalid platform outcome');
      evidence(event.evidence);
      item.status = 'verified'; item.step = event.outcome; item.verificationEvidence = event.evidence;
      item.nextCheckAt = null; item.fault = null; changed(item);
      break;
    }
    case 'writeback': {
      item = itemFor(state, event.recordId);
      requireThat(['submitted', 'verified', 'blocked'].includes(item.status), 'no terminal state or receipt to write back');
      evidence(event.evidence);
      requireThat(event.readbackConfirmed === true, 'write accepted is insufficient; read back fields first');
      item.writebackVerified = true; item.writebackEvidence = event.evidence;
      item.writebackUnavailableEvidence = null; item.fault = null;
      break;
    }
    case 'block': {
      requireThat(Array.isArray(event.recordIds) && event.recordIds.length > 0 &&
        new Set(event.recordIds).size === event.recordIds.length, 'block needs explicit unique recordIds');
      requireThat(['platform', 'auth', 'missing_input', 'control'].includes(event.kind), 'ordinary faults are not terminal blockers');
      evidence(event.evidence); text(event.nextAction, 'nextAction');
      if (event.stage != null) requireThat(['verification', 'writeback', 'submission_resolution'].includes(event.stage), 'invalid blocker stage');
      if (event.writebackUnavailableEvidence != null) {
        requireThat(['auth', 'control'].includes(event.kind), 'writeback exception requires auth/control evidence');
        evidence(event.writebackUnavailableEvidence, 'writebackUnavailableEvidence');
      }
      for (const id of event.recordIds) {
        item = itemFor(state, id);
        requireThat(item.status !== 'blocked', 'item already blocked; resolve its blocker before replacing it');
        requireThat(!(item.status === 'verified' && item.writebackVerified), 'cannot block completed work');
        if (item.itemId) {
          requireThat(event.submissionRejected !== true, 'cannot erase submitted success with a rejection');
          requireThat(['verification', 'writeback'].includes(event.stage), 'submitted work requires an explicit blocker stage');
          requireThat(event.stage !== 'verification' || item.status === 'submitted', 'verification already complete');
          requireThat(event.stage !== 'writeback' || !item.writebackVerified, 'writeback already complete');
        }
        if (item.status === 'submit_unknown') {
          requireThat(event.stage === 'submission_resolution', 'unknown submission must be reconciled at submission_resolution');
          requireThat((event.kind === 'platform' && event.submissionRejected === true) ||
            ['auth', 'control'].includes(event.kind), 'unknown submission needs explicit rejection or an auth/control pause');
        }
        const rejected = item.status === 'submit_unknown' && event.kind === 'platform' && event.submissionRejected === true;
        const resume = { status: rejected ? 'pending' : item.status,
          step: rejected ? 'platform rejected submission' : item.step,
          writebackVerified: item.writebackVerified, writebackEvidence: item.writebackEvidence };
        item.status = 'blocked'; item.step = 'blocked'; item.fault = null; changed(item);
        item.blocker = { kind: event.kind, stage: event.stage ?? null, evidence: event.evidence,
          nextAction: event.nextAction, at: now, resume };
        item.writebackUnavailableEvidence = event.writebackUnavailableEvidence ?? null;
      }
      break;
    }
    case 'unblock': {
      requireThat(Array.isArray(event.recordIds) && event.recordIds.length > 0 &&
        new Set(event.recordIds).size === event.recordIds.length, 'unblock needs explicit unique recordIds');
      evidence(event.evidence);
      for (const id of event.recordIds) {
        item = itemFor(state, id);
        requireThat(item.status === 'blocked' && item.blocker?.resume, 'item has no resumable blocker');
        const blocker = item.blocker;
        item.status = blocker.resume.status; item.step = blocker.resume.step;
        item.resolvedBlockers ??= [];
        item.resolvedBlockers.push({ ...blocker, resolvedAt: now, resolutionEvidence: event.evidence,
          blockedWritebackEvidence: item.writebackEvidence });
        item.blocker = null; item.fault = null;
        // The table may now show the blocker, so restore and read back business facts.
        changed(item);
      }
      break;
    }
    case 'stop':
      evidence(event.evidence); state.stopped = true; state.stopEvidence = event.evidence; break;
    case 'resume_user':
      requireThat(state.stopped, 'batch is not user-stopped');
      evidence(event.evidence); state.stopped = false; state.stopEvidence = null;
      if (state.worker) state.worker.status = 'interrupted';
      break;
    default: throw new Error(`unsupported event: ${event.type}`);
  }
  state.revision += 1; state.updatedAt = now;
  state.history.push({ ...event, at: now, revision: state.revision });
  return state;
}

export function decide(state, now = new Date().toISOString()) {
  requireThat(Number.isFinite(Date.parse(now)), 'invalid decision time');
  const actions = state.items.map(item => {
    let action;
    if (state.stopped) action = 'respect_stop';
    else if (item.status === 'submit_unknown') action = 'reconcile';
    else if (['submitted', 'verified', 'blocked'].includes(item.status) &&
      !item.writebackVerified && !item.writebackUnavailableEvidence) action = 'writeback';
    else if (item.status === 'blocked') action = 'blocked';
    else if (item.status === 'verified') action = 'complete';
    else if (item.status === 'submitted') {
      const due = !item.nextCheckAt || Date.parse(item.nextCheckAt) <= Date.parse(now);
      action = due ? 'verify' : state.requireFinalVerification ? 'wait_verification' : 'awaiting_platform';
    } else if (item.fault) action = !item.fault.recoverable || item.fault.repeats >= 2 ? 'diagnose' : 'recover';
    else action = 'resume';
    return { recordId: item.recordId, status: item.status,
      businessStatus: item.status === 'blocked' ? item.blocker.resume?.status ?? 'pending' : item.status,
      origin: item.origin ?? (item.itemId ? 'new' : null), action, itemId: item.itemId,
      receiptEvidence: item.receiptEvidence, existingEvidence: item.existingEvidence ?? null,
      verificationEvidence: item.verificationEvidence,
      step: item.step, nextCheckAt: item.nextCheckAt, fault: item.fault, blocker: item.blocker };
  });
  const terminal = new Set(['complete', 'blocked', 'awaiting_platform']);
  const allAccounted = actions.every(item => terminal.has(item.action));
  const businessCanFinish = (state.stopped || allAccounted) && state.worker?.status !== 'running';
  const cleanupRequired = businessCanFinish && Boolean(state.browserControl?.held);
  const canFinish = businessCanFinish && !cleanupRequired;
  let orchestrationAction;
  if (state.stopped && state.worker?.status === 'running') orchestrationAction = 'stop_worker';
  else if (cleanupRequired) orchestrationAction = 'cleanup_required';
  else if (state.stopped) orchestrationAction = 'respect_stop';
  else if (state.worker?.status === 'running') orchestrationAction = 'observe_worker';
  else if (canFinish) orchestrationAction = 'finish';
  else if (actions.some(item => !terminal.has(item.action) && item.action !== 'wait_verification' && item.fault &&
    (!item.fault.recoverable || item.fault.repeats >= 2))) orchestrationAction = 'diagnose_then_resume';
  else if (actions.every(item => terminal.has(item.action) || item.action === 'wait_verification')) orchestrationAction = 'wait_until_due';
  else orchestrationAction = state.worker ? 'followup_worker' : 'assign_worker';
  const counts = Object.fromEntries([...new Set(actions.map(item => item.action))]
    .map(action => [action, actions.filter(item => item.action === action).length]));
  return { batchId: state.batchId, revision: state.revision, worker: state.worker,
    decisionsOnly: true, canFinish, orchestrationAction, browserControl: state.browserControl,
    cleanupMethod: cleanupRequired ? (state.stopped || state.items.some(item => item.status === 'blocked') ? 'handOff' : 'finish') : null,
    total: actions.length, counts, actions };
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function atomicWrite(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  const handle = fs.openSync(temp, 'wx');
  try {
    try {
      fs.writeFileSync(handle, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    fs.renameSync(temp, file);
  }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function updateFile(file, command, request) {
  const resolved = path.resolve(file), lock = `${resolved}.lock`;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  let handle;
  try { handle = fs.openSync(lock, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('checkpoint locked; confirm owner stopped before recovering the lock');
    throw error;
  }
  try {
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    let state;
    if (command === 'init') {
      requireThat(!fs.existsSync(resolved), 'checkpoint already exists; inspect and resume it');
      state = createState(request);
    } else {
      requireThat(command === 'apply', 'invalid mutation command');
      state = applyEvent(readJson(resolved), request);
    }
    atomicWrite(resolved, state); return decide(state);
  } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, file, request] = process.argv.slice(2);
    if (command === '--help' || !command) {
      console.log('Usage: node run_state.mjs init|apply <state.json> <request.json>\n       node run_state.mjs inspect <state.json>\nLocal decisions only. The supervisor must invoke agent tools; this is not a daemon.');
    } else {
      requireThat(file, 'state path required');
      let result;
      if (command === 'inspect') result = decide(readJson(file));
      else { requireThat(request, 'JSON request file required'); result = updateFile(file, command, readJson(request)); }
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1;
  }
}
