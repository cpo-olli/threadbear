import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Coordinators, runMove } from '../../src/coordinators.ts';
import { Projects } from '../../src/projects.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { makeHarness, tick, tmpDir, FakeAccounts, withCodex } from '../helpers/fakes.ts';
import { CallerGate } from '../../src/rpc-gate.ts';

function setup(home = tmpDir()) {
  const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger });
  const h = makeHarness(home, {}, { projects, accounts: new FakeAccounts(withCodex()) });
  const c = new Coordinators({ home, host: h.runner, projects, clock: h.clock, enabled: () => true, log: nullLogger });
  h.runner.coordinators = c;
  projects.start(h.runner);
  c.start();
  const project = projects.create({ title: 'Pantry', goals: 'Keep food fresh', by: 'mike' });
  return { h, projects, c, project, home };
}

test('a coordinator is one real thread per project, starts with shared notes and retains pool selection', async () => {
  const { h, c, project, projects } = setup();
  projects.update(project.id, { notes: 'Use the oldest food first.' });
  const first = c.create({ projectId: project.id, accountId: 'claude-3' });
  assert.equal(c.create({ projectId: project.id }).coordinator.threadId, first.thread.id);
  await tick();
  assert.equal(h.runner.threadRecords().length, 1);
  assert.match(c.context(first.thread.id)!, /Use the oldest food first/);
  assert.ok(h.adapter.sessions.at(-1)?.opts.coordinator);
  assert.equal(h.runner.get(first.thread.id).accountId, 'claude-3');
  c.stop();
});

test('unsupported provider refuses before saving any coordinator or thread', () => {
  const { c, h, project } = setup();
  assert.throws(() => c.create({ projectId: project.id, accountId: 'codex-main' }), /Claude/);
  assert.equal(c.list().length, 0);
  assert.equal(h.runner.threadRecords().length, 0);
  c.stop();
});

test('native dispatch is durable, one worker at a time, trusted identity only; completion derives task state', () => {
  const { c, project } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  const boundary = c.session(coordinator.threadId)!;
  assert.match(boundary.checkTool({ name: 'Write', input: {}, agentId: 'forged' })!, /known helper/);
  assert.equal(boundary.checkTool({ name: 'Agent', toolUseId: 'dispatch', input: { description: 'Check pantry', prompt: 'Read current inventory' } }), undefined);
  assert.match(boundary.checkTool({ name: 'Agent', toolUseId: 'duplicate', input: { description: 'More work' } })!, /already/);
  boundary.workerStarted?.('worker-1', 'coordinator-worker');
  assert.equal(boundary.checkTool({ name: 'Read', input: {}, agentId: 'worker-1' }), undefined);
  c.subagent(coordinator.threadId, { id: 'worker-1', status: 'completed', summary: 'Inventory checked' });
  assert.equal(c.get(project.id).tasks[0].run?.status, 'completed');
  assert.equal(c.get(project.id).tasks[0].run?.summary, 'Inventory checked');
  assert.throws(() => runMove('completed', 'running'), /cannot/);
  c.stop();
});

test('pause rejects parent and helper dispatch and survives a restart; records retain interrupted work', async () => {
  const { c, h, project, home } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  const boundary = c.session(coordinator.threadId)!;
  boundary.checkTool({ name: 'Agent', toolUseId: 'dispatch', input: { description: 'Check pantry', prompt: 'Inspect food' } });
  boundary.workerStarted?.('worker-1', 'coordinator-worker');
  await c.pause(project.id, true);
  assert.match(boundary.checkTool({ name: 'Read', input: {}, agentId: 'worker-1' })!, /paused/);
  c.stop();
  const restarted = new Coordinators({ home, host: h.runner, projects: h.runner.projects!, clock: h.clock, enabled: () => true, log: nullLogger });
  assert.equal(restarted.get(project.id).state, 'paused');
  assert.equal(restarted.get(project.id).tasks[0].run?.status, 'interrupted');
  assert.match(restarted.context(coordinator.threadId)!, /reconcile/i);
  restarted.stop();
});

test('helper questions deduplicate outside the chat and an answer updates the same record', () => {
  const { c, project } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  const boundary = c.session(coordinator.threadId)!;
  boundary.checkTool({ name: 'Agent', toolUseId: 'dispatch', input: { description: 'Check pantry' } });
  boundary.workerStarted?.('worker-1', 'coordinator-worker');
  const questions = [{ header: 'Food', question: 'Keep the milk?', options: [{ label: 'Keep', description: 'Keep it' }, { label: 'Discard', description: 'Discard it' }], multiSelect: false }];
  boundary.helperQuestion?.('worker-1', questions);
  boundary.helperQuestion?.('worker-1', questions);
  assert.equal(c.get(project.id).questions.length, 1);
  c.subagent(coordinator.threadId, { id: 'worker-1', status: 'completed', summary: 'Waiting for an answer' });
  assert.equal(c.get(project.id).tasks[0].run?.status, 'interrupted');
  const question = c.get(project.id).questions[0];
  c.answer(project.id, question.id, 'Keep, as Mike already decided');
  assert.equal(c.get(project.id).questions[0].state, 'answered');
  assert.match(c.get(project.id).questions[0].answer!, /Mike already decided/);
  assert.equal(boundary.checkTool({ name: 'Agent', toolUseId: 'resume', input: { resume: 'worker-1' } }), undefined);
  c.stop();
});

test('corrupt registry fails closed rather than losing coordinator restrictions', () => {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'coordinators.json'), '{broken');
  assert.throws(() => setup(home), /coordinator registry/i);
});

test('coordinator restrictions apply to thread-owned RPC before the Full access shortcut', () => {
  const { c, h, project } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  const gate = new CallerGate({ runner: h.runner });
  assert.equal(h.runner.get(coordinator.threadId).permissionMode, 'full');
  assert.throws(() => gate.check(coordinator.threadId, 'threads.create', { text: 'Escape' }), /cannot/);
  assert.throws(() => gate.check(coordinator.threadId, 'settings.update', {}), /cannot/);
  assert.throws(() => gate.check(coordinator.threadId, 'coordinators.start', { projectId: project.id }), /project home/);
  assert.throws(() => gate.check(coordinator.threadId, 'projects.update', { projectId: 'someone-else', notes: 'overwrite' }), /cannot/);
  assert.deepEqual(gate.check(coordinator.threadId, 'projects.update', { projectId: project.id, state: 'Working' }), { projectId: project.id, state: 'Working' });
  c.stop();
});

test('the shared project editor rejects a stale draft atomically and preserves newer decisions', () => {
  const { c, project, projects } = setup();
  projects.update(project.id, { notes: 'An answer from another thread' });
  assert.throws(() => projects.update(project.id, { notes: 'My older draft', state: 'Would overwrite too', ifUnchanged: { notes: '' } }), /changed while/);
  assert.equal(projects.get(project.id).project.notes, 'An answer from another thread');
  assert.equal(projects.get(project.id).project.state, '');
  projects.update(project.id, { notes: 'My merged draft', ifUnchanged: { notes: 'An answer from another thread' } });
  assert.equal(projects.get(project.id).project.notes, 'My merged draft');
  c.stop();
});

test('a user timer earlier than a pending event batch takes precedence and delivers the pending events together', async () => {
  const { c, h, project } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const other = h.runner.create({ text: 'Check stock', accountId: 'claude-3', projectIds: [project.id] }).thread;
  await tick();
  h.adapter.sessions.find((s) => s.opts.threadId === other.id)!.result('completed');
  await tick();
  assert.equal(c.get(project.id).events.length, 1);
  c.update(project.id, { wakeAt: new Date(h.clock.now() + 60_000).toISOString() });
  h.clock.advance(60_000);
  await tick();
  const rec = h.runner.threadRecords().find((r) => r.id === coordinator.threadId)!;
  assert.ok(rec.queue.some((q) => q.text.includes('check you scheduled is due') && q.text.includes('Check stock')));
  assert.equal(c.get(project.id).events.length, 0);
  c.stop();
});

test('pause and resume rearms a scheduled check without a later project update', async () => {
  const { c, h, project } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  c.update(project.id, { wakeAt: new Date(h.clock.now() + 120_000).toISOString() });
  await c.pause(project.id, true);
  h.clock.advance(60_000);
  await c.pause(project.id, false);
  h.clock.advance(60_000);
  await tick();
  assert.equal(c.get(project.id).wakeAt, undefined);
  assert.ok(h.runner.threadRecords().find((r) => r.id === coordinator.threadId)!.queue.some((q) => q.text.includes('check you scheduled is due')));
  c.stop();
});

test('event delivery keeps whole records and retries a failed wake with a delay', async () => {
  const { c, h, project } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const row = c.forThread(coordinator.threadId)!;
  for (let i = 0; i < 20; i++) row.events.push({ key: String(i), text: JSON.stringify({ i, summary: 'x'.repeat(2000) }) });
  c.update(project.id, { wakeAt: new Date(h.clock.now() + 60_000).toISOString() });
  const send = h.runner.send.bind(h.runner);
  let failures = 1;
  h.runner.send = (...args) => { if (failures-- > 0) throw Error('Temporary outage'); return send(...args); };
  h.clock.advance(60_000);
  assert.equal(row.events.length, 20);
  h.clock.advance(59_999);
  assert.equal(row.events.length, 20);
  h.clock.advance(1);
  assert.ok(row.events.length > 0 && row.events.length < 20);
  h.clock.advance(20 * 60_000);
  await tick();
  assert.equal(row.events.length, 0);
  assert.equal(new Set(row.seen).size, 20);
  const messages = h.runner.threadRecords().find((r) => r.id === coordinator.threadId)!.queue.map((q) => q.text).filter((s) => s.includes('Project events'));
  const delivered = messages.flatMap((s) => s.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).i));
  assert.deepEqual(delivered, Array.from({ length: 20 }, (_, i) => i));
  c.stop();
});

test('coordinator model changes reject unsupported providers before changing the record', () => {
  const { c, h, project } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  assert.throws(() => h.runner.update({ threadId: coordinator.threadId, accountId: 'codex-main' }), /Claude/);
  assert.throws(() => h.runner.update({ threadId: coordinator.threadId, model: 'gpt-6-luna' }), /Claude/);
  assert.equal(h.runner.get(coordinator.threadId).accountId, 'claude-3');
  c.stop();
});
