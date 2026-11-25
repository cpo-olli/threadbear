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
import type { Settings } from '../../src/settings.ts';

function setup(home = tmpDir(), enabled = () => true) {
  const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger });
  const h = makeHarness(home, {}, { projects, accounts: new FakeAccounts(withCodex()) });
  const c = new Coordinators({ home, host: h.runner, projects, clock: h.clock, enabled, log: nullLogger });
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
  assert.throws(() => c.create({ projectId: project.id, model: 'gpt-6-luna' }), /Claude/);
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
  assert.equal(boundary.checkTool({ name: 'Agent', toolUseId: 'dispatch', input: { description: 'Check pantry', prompt: 'Read current inventory' } }), undefined);
  assert.match(boundary.checkTool({ name: 'Agent', toolUseId: 'duplicate', input: { description: 'More work' } })!, /already/);
  boundary.workerStarted?.('worker-1', 'coordinator-worker', { toolUseId: 'dispatch', runId: 'run-001' });
  assert.equal(boundary.checkTool({ name: 'Read', input: {}, agentId: 'worker-1' }), undefined);
  c.subagent(coordinator.threadId, { id: 'worker-1', runId: 'run-001', status: 'completed', summary: 'Inventory checked' });
  assert.equal(c.get(project.id).tasks[0].run?.status, 'completed');
  assert.equal(c.get(project.id).tasks[0].run?.summary, 'Inventory checked');
  assert.match(boundary.checkTool({ name: 'Agent', toolUseId: 'dispatch', input: { description: 'Replay old work' } })!, /already ended/);
  assert.equal(c.get(project.id).tasks[0].state, 'review');
  c.completeTask(project.id, c.get(project.id).tasks[0].id);
  assert.equal(c.get(project.id).tasks[0].state, 'done');
  assert.throws(() => runMove('completed', 'running'), /cannot/);
  c.stop();
});

test('a stale helper generation cannot finish resumed work or attach to an unrelated job', () => {
  const { c, project } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  const boundary = c.session(coordinator.threadId)!;
  boundary.checkTool({ name: 'Agent', toolUseId: 'first', input: { description: 'Check inventory' } });
  boundary.workerStarted?.('worker', 'coordinator-worker', { toolUseId: 'first', runId: '001' });
  c.subagent(coordinator.threadId, { id: 'worker', runId: '001', status: 'completed' });
  assert.equal(boundary.checkTool({ name: 'Agent', toolUseId: 'second', input: { resume: 'worker' } }), undefined);
  c.subagent(coordinator.threadId, { id: 'worker', runId: '001', status: 'completed' });
  assert.equal(c.get(project.id).tasks[0].run?.status, 'queued');
  boundary.workerStarted?.('worker', 'coordinator-worker', { toolUseId: 'second', runId: '002' });
  c.subagent(coordinator.threadId, { id: 'worker', runId: '001', status: 'completed' });
  c.subagent(coordinator.threadId, { id: 'stranger', runId: '002', status: 'completed' });
  assert.equal(c.get(project.id).tasks[0].run?.status, 'running');
  c.subagent(coordinator.threadId, { id: 'worker', runId: '002', status: 'completed' });
  assert.equal(c.get(project.id).tasks[0].run?.status, 'completed');
  c.stop();
});

test('a failed native launch releases its reservation and archived work stays recoverable', () => {
  const { c, project, home } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  const boundary = c.session(coordinator.threadId)!;
  boundary.checkTool({ name: 'Agent', toolUseId: 'failed', input: { description: 'Check inventory' } });
  boundary.workerFailed?.('failed', 'Launch refused');
  const task = c.get(project.id).tasks[0];
  assert.equal(task.state, 'blocked');
  assert.throws(() => c.archiveTask(project.id, task.id), /finished/);
  c.completeTask(project.id, task.id);
  c.archiveTask(project.id, task.id);
  assert.equal(c.get(project.id).tasks.length, 0);
  const history = JSON.parse(fs.readFileSync(path.join(home, 'coordinator-history.jsonl'), 'utf8'));
  assert.equal(history.task.run.id, 'failed');
  assert.equal(history.task.run.brief, 'Check inventory');
  c.stop();
});

test('dispatch selects the intended unstarted task and never reopens accepted work implicitly', () => {
  const { c, project } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  const first = c.addTask(project.id, 'Already answered', 'The answer is recorded').tasks[0];
  c.completeTask(project.id, first.id);
  const second = c.addTask(project.id, 'Check food', 'Inventory checked').tasks[1];
  c.addTask(project.id, 'Order next week', 'Order prepared');
  const boundary = c.session(coordinator.threadId)!;
  assert.match(boundary.checkTool({ name: 'Agent', toolUseId: 'ambiguous', input: { description: 'Check food' } })!, /selectTask/);
  c.selectTask(project.id, second.id);
  assert.equal(boundary.checkTool({ name: 'Agent', toolUseId: 'correct', input: { description: 'Check food' } }), undefined);
  const tasks = c.get(project.id).tasks;
  assert.equal(tasks[0].state, 'done');
  assert.equal(tasks[0].run, undefined);
  assert.equal(tasks[1].run?.id, 'correct');
  assert.equal(tasks[2].run, undefined);
  c.stop();
});

test('pause rejects parent and helper dispatch and survives a restart; records retain interrupted work', async () => {
  const { c, h, project, home } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  const boundary = c.session(coordinator.threadId)!;
  boundary.checkTool({ name: 'Agent', toolUseId: 'dispatch', input: { description: 'Check pantry', prompt: 'Inspect food' } });
  boundary.workerStarted?.('worker-1', 'coordinator-worker', { toolUseId: 'dispatch', runId: 'run-001' });
  await c.pause(project.id, true);
  assert.match(boundary.checkTool({ name: 'Read', input: {}, agentId: 'worker-1' })!, /paused/);
  c.stop();
  const restarted = new Coordinators({ home, host: h.runner, projects: h.runner.projects!, clock: h.clock, enabled: () => true, log: nullLogger });
  assert.equal(restarted.get(project.id).state, 'paused');
  assert.equal(restarted.get(project.id).tasks[0].run?.status, 'interrupted');
  assert.match(restarted.context(coordinator.threadId)!, /reconcile/i);
  restarted.stop();
});

test('a concurrent resume waits for the old helper process to stop', async () => {
  const { c, h, project } = setup();
  c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const session = h.adapter.sessions.at(-1)!;
  session.slowExit = true;
  const pause = c.pause(project.id, true);
  const resume = c.pause(project.id, false);
  await tick();
  assert.equal(c.get(project.id).state, 'paused');
  session.exit();
  await Promise.all([pause, resume]);
  assert.equal(c.get(project.id).state, 'active');
  c.stop();
});

test('a runner handover ends coordinator sessions and prevents the draining writer changing its registry', async () => {
  const { c, h, project, home, projects } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const boundary = c.session(coordinator.threadId)!;
  boundary.checkTool({ name: 'Agent', toolUseId: 'dispatch', input: { description: 'Inspect food' } });
  boundary.workerStarted?.('worker', 'coordinator-worker', { toolUseId: 'dispatch', runId: '001' });
  const session = h.adapter.sessions.at(-1)!;
  await c.handover();
  assert.equal(session.endedHard, true);
  assert.equal(c.get(project.id).tasks[0].run?.status, 'interrupted');
  const saved = fs.readFileSync(path.join(home, 'coordinators.json'), 'utf8');
  c.subagent(coordinator.threadId, { id: 'worker', runId: '001', status: 'completed' });
  boundary.workerFailed?.('dispatch', 'Old process cleanup');
  assert.equal(fs.readFileSync(path.join(home, 'coordinators.json'), 'utf8'), saved);
  const replacement = new Coordinators({ home, host: h.runner, projects, clock: h.clock, enabled: () => true, log: nullLogger });
  assert.equal(replacement.get(project.id).tasks[0].run?.status, 'interrupted');
  replacement.stop();
});

test('helper questions deduplicate outside the chat and an answer updates the same record', () => {
  const { c, project } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  const boundary = c.session(coordinator.threadId)!;
  boundary.checkTool({ name: 'Agent', toolUseId: 'dispatch', input: { description: 'Check pantry' } });
  boundary.workerStarted?.('worker-1', 'coordinator-worker', { toolUseId: 'dispatch', runId: 'run-001' });
  const questions = [{ header: 'Food', question: 'Keep the milk?', options: [{ label: 'Keep', description: 'Keep it' }, { label: 'Discard', description: 'Discard it' }], multiSelect: false }];
  boundary.helperQuestion?.('worker-1', questions);
  boundary.helperQuestion?.('worker-1', questions);
  assert.equal(c.get(project.id).questions.length, 1);
  c.subagent(coordinator.threadId, { id: 'worker-1', runId: 'run-001', status: 'completed', summary: 'Waiting for an answer' });
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
  assert.throws(() => gate.check(coordinator.threadId, 'projects.update', { projectId: project.id, state: 'Working' }), /cannot/);
  const boundary = c.session(coordinator.threadId)!;
  assert.equal(boundary.checkTool({ name: 'mcp__threadbear__update_project', input: { project: project.id } }), undefined);
  assert.match(boundary.checkTool({ name: 'mcp__threadbear__update_project', input: { project: 'another-project' } })!, /own project/);
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
  assert.equal(c.forThread(coordinator.threadId)!.events.length, 1);
  c.update(project.id, { wakeAt: new Date(h.clock.now() + 60_000).toISOString() });
  h.clock.advance(60_000);
  await tick();
  const rec = h.runner.threadRecords().find((r) => r.id === coordinator.threadId)!;
  assert.ok(rec.queue.some((q) => q.text.includes('check you scheduled is due') && q.text.includes('Check stock')));
  assert.equal(c.forThread(coordinator.threadId)!.events.length, 0);
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

test('a crash after queueing a wake retries its original batch independently of new arrivals', async () => {
  const { c, h, project, home, projects } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  c.forThread(coordinator.threadId)!.events.push({ key: 'A', text: 'First event A' });
  c.update(project.id, { wakeAt: new Date(h.clock.now() + 60_000).toISOString() });
  const save = h.runner.store.save.bind(h.runner.store);
  let crash = true;
  h.runner.store.save = (record) => { save(record); if (crash && record.id === coordinator.threadId && record.queue.some((q) => q.text.includes('First event A'))) { throw Error('Crash after thread save'); } };
  h.clock.advance(60_000);
  assert.ok(c.forThread(coordinator.threadId)!.delivery);
  c.stop();
  crash = false;
  h.runner.store.save = save;
  const restarted = new Coordinators({ home, host: h.runner, projects, clock: h.clock, enabled: () => true, log: nullLogger });
  h.runner.coordinators = restarted;
  restarted.start();
  restarted.forThread(coordinator.threadId)!.events.push({ key: 'B', text: 'New arrival B' });
  restarted.update(project.id, {});
  h.clock.advance(21 * 60_000);
  await tick();
  const queued = h.runner.threads.get(coordinator.threadId)!.rec.queue;
  assert.equal(queued.filter((q) => q.text.includes('First event A')).length, 1);
  assert.equal(queued.filter((q) => q.text.includes('New arrival B')).length, 1);
  assert.equal(restarted.forThread(coordinator.threadId)!.events.length, 0);
  restarted.stop();
});

test('a started wake is a durable receipt even after it leaves the queue', async () => {
  const { c, h, project } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  h.adapter.sessions.at(-1)!.result('completed');
  await tick();
  const row = c.forThread(coordinator.threadId)!;
  row.delivery = { id: 'delivery', text: 'Only one delivery', eventKeys: [] };
  const { scheduledMessageId } = await import('../../src/runner/messages.ts');
  const messageId = scheduledMessageId(coordinator.threadId, `coordinator:${project.id}`, 'delivery');
  h.runner.send(coordinator.threadId, row.delivery.text, [], { origin: 'runner', messageId });
  await tick();
  assert.equal(h.runner.threads.get(coordinator.threadId)!.rec.queue.length, 0);
  c.update(project.id, { wakeAt: new Date(h.clock.now() + 60_000).toISOString() });
  h.clock.advance(60_000);
  await tick();
  assert.equal(h.events(coordinator.threadId).filter((e) => e.type === 'user.message' && e.text === 'Only one delivery').length, 1);
  assert.equal(h.runner.threads.get(coordinator.threadId)!.rec.queue.filter((q) => q.text === 'Only one delivery').length, 0);
  c.stop();
});

test('distant wake times use bounded timer intervals and keep their actual deadline', () => {
  const { c, h, project } = setup();
  c.create({ projectId: project.id, accountId: 'claude-3' });
  const delays: number[] = [];
  const setTimeout = h.clock.setTimeout.bind(h.clock);
  h.clock.setTimeout = (fn, ms) => { delays.push(ms); return setTimeout(fn, ms); };
  const deadline = new Date(h.clock.now() + 30 * 24 * 60 * 60_000).toISOString();
  c.update(project.id, { wakeAt: deadline });
  assert.ok(delays.length > 0);
  assert.ok(delays.every((ms) => ms <= 2_147_483_647));
  assert.equal(c.get(project.id).wakeAt, deadline);
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

test('turning the experiment off stops the owned session and keeps its restrictions', async () => {
  let enabled = true;
  const { c, h, project } = setup(tmpDir(), () => enabled);
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const session = h.adapter.sessions.at(-1)!;
  assert.equal(h.runner.get(coordinator.threadId).coordinatorProjectId, project.id);
  enabled = false;
  h.runner.publish({ method: 'settings.updated', params: { settings: {} as Settings } });
  assert.equal(session.killed, true);
  assert.equal(c.get(project.id).state, 'paused');
  assert.equal(h.runner.get(coordinator.threadId).coordinatorProjectId, undefined);
  assert.match(c.dispatchRefusal(coordinator.threadId)!, /paused/);
  assert.match(c.rpcRefusal(coordinator.threadId, 'threads.create', {})!, /paused/);
  c.stop();
});

test('an active coordinator cannot disappear through archive, delete or a cross-runner move', async () => {
  const { c, h, project } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  assert.throws(() => h.runner.update({ threadId: coordinator.threadId, archived: true }), /Pause/);
  assert.throws(() => h.runner.delete(coordinator.threadId), /Pause/);
  await assert.rejects(h.runner.describeForMove(coordinator.threadId, 0), /owning runner/);
  await c.pause(project.id, true);
  h.runner.update({ threadId: coordinator.threadId, archived: true });
  assert.ok(h.runner.get(coordinator.threadId).archivedAt);
  h.runner.delete(coordinator.threadId);
  assert.equal(c.list().length, 0);
  assert.throws(() => h.runner.get(coordinator.threadId), /not found/i);
  c.stop();
});

test('idle coordinator compaction reaches the CLI as a command, with current memory restored by the hook', async () => {
  const { c, h, project, projects } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const session = h.adapter.sessions.at(-1)!;
  const st = h.runner.threads.get(coordinator.threadId)!;
  st.rec.contextTokens = 110_000;
  session.result('completed');
  await tick();
  h.clock.advance(49 * 60_000);
  assert.equal(session.sent.filter((m) => m.text.startsWith('/compact')).length, 0);
  h.clock.advance(60_000);
  await tick();
  const compact = h.adapter.sessions.flatMap((s) => s.sent).find((m) => m.text.startsWith('/compact'));
  assert.ok(compact, 'no project memory is prepended to the slash command');
  projects.update(project.id, { notes: 'A decision made while compacting' });
  assert.match(session.opts.coordinator!.context!()!, /decision made while compacting/);
  c.stop();
});
