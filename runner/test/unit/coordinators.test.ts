import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Coordinators, runMove } from '../../src/coordinators.ts';
import { acpCoordinatorTool, coordinatorTool, HELPER_THREADBEAR_TOOLS } from '../../src/coordinator-policy.ts';
import { Projects } from '../../src/projects.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { makeHarness, tick, tmpDir, FakeAccounts, FakeAdapter, withCodex } from '../helpers/fakes.ts';
import { Runner } from '../../src/runner.ts';
import { ThreadStore } from '../../src/store.ts';
import { CallerGate } from '../../src/rpc-gate.ts';
import type { Account, ThreadSummary } from '../../src/protocol.ts';
import type { Settings } from '../../src/settings.ts';
import { buildThreadbearTools, type ProjectControl } from '../../src/threadbear-mcp.ts';

const ANTIGRAVITY_ACCOUNT: Account = {
  id: 'antigravity-main',
  provider: 'antigravity',
  title: 'Gemini',
  configDir: '/tmp/fake-antigravity',
  defaultModel: 'gemini-4-neon',
  models: [
    { id: 'gemini-4-neon', model: 'gemini-4-neon', title: 'Gemini 4 Neon' },
    { id: 'gemini-3.5-pro', model: 'gemini-3.5-pro', title: 'Gemini 3.5 Pro' },
  ],
};

function allAccounts(): Account[] {
  return [...withCodex(), ANTIGRAVITY_ACCOUNT];
}

function setup(home = tmpDir(), enabled = () => true) {
  const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger });
  const claude = new FakeAdapter();
  const codex = new FakeAdapter('codex', { wakesAfterTasks: false, archives: true });
  const antigravity = new FakeAdapter('antigravity', { wakesAfterTasks: false });
  const h = makeHarness(home, {}, { projects, accounts: new FakeAccounts(allAccounts()), adapters: { claude, codex, antigravity } });
  const c = new Coordinators({ home, host: h.runner, projects, clock: h.clock, enabled, log: nullLogger });
  h.runner.coordinators = c;
  projects.start(h.runner);
  c.start();
  const project = projects.create({ title: 'Pantry', goals: 'Keep food fresh', by: 'mike' });
  return { h, projects, c, project, home, claude, codex, antigravity };
}

function recoverFresh(h: ReturnType<typeof setup>['h'], home: string) {
  const clock = new FakeClock(h.clock.now());
  const projects = new Projects({ home, clock, log: nullLogger });
  const adapter = new FakeAdapter();
  const codex = new FakeAdapter('codex', { wakesAfterTasks: false, archives: true });
  const antigravity = new FakeAdapter('antigravity', { wakesAfterTasks: false });
  const host = new Runner({ config: h.cfg, store: new ThreadStore(home), adapters: { claude: adapter, codex, antigravity }, accounts: new FakeAccounts(allAccounts()), clock, log: nullLogger, projects, defer: (fn) => fn(), backgroundJobs: false, reachable: async () => true, panelsRoot: home });
  projects.start(host);
  const replacement = new Coordinators({ home, host, projects, clock, enabled: () => true, log: nullLogger });
  host.coordinators = replacement;
  host.start();
  replacement.start();
  return { host, adapter, codex, antigravity, c: replacement };
}

test('a coordinator is one real thread per project, starts with shared notes and retains account selection', async () => {
  const { h, c, project, projects, claude } = setup();
  projects.update(project.id, { notes: 'Use the oldest food first.' });
  const first = c.create({ projectId: project.id, accountId: 'claude-3' });
  assert.equal(c.create({ projectId: project.id }).coordinator.threadId, first.thread.id);
  await tick();
  assert.equal(h.runner.threadRecords().length, 1);
  assert.match(c.context(first.thread.id)!, /Use the oldest food first/);
  assert.equal(claude.sessions.at(-1)?.opts.coordinator?.role, 'coordinator');
  assert.equal(h.runner.get(first.thread.id).accountId, 'claude-3');
  c.stop();
});

test('coordinators can start on Antigravity (Gemini 4 Neon) or Codex and switch providers/models at will', async () => {
  const { h, c, projects, antigravity, codex, claude } = setup();
  const p1 = projects.create({ title: 'Neon Project', goals: 'Run on Gemini', by: 'mike' });
  const p2 = projects.create({ title: 'Codex Project', goals: 'Run on Codex', by: 'mike' });
  const neon = c.create({ projectId: p1.id, accountId: 'antigravity-main', model: 'gemini-4-neon' });
  const codexCoord = c.create({ projectId: p2.id, accountId: 'codex-main', model: 'gpt-6-luna' });
  await tick();
  assert.equal(neon.thread.provider, 'antigravity');
  assert.equal(neon.thread.model, 'gemini-4-neon');
  assert.equal(antigravity.sessions.at(-1)?.opts.coordinator?.role, 'coordinator');
  assert.equal(codexCoord.thread.provider, 'codex');
  assert.equal(codex.sessions.at(-1)?.opts.coordinator?.role, 'coordinator');

  // Switch coordinator from Antigravity -> Codex -> Claude at will.
  h.runner.update({ threadId: neon.thread.id, accountId: 'codex-main', model: 'gpt-6-luna' });
  assert.equal(h.runner.get(neon.thread.id).provider, 'codex');
  assert.equal(h.runner.get(neon.thread.id).coordinatorProjectId, p1.id);
  h.runner.update({ threadId: neon.thread.id, accountId: 'claude-3' });
  assert.equal(h.runner.get(neon.thread.id).provider, 'claude');
  assert.equal(h.runner.get(neon.thread.id).coordinatorProjectId, p1.id);

  // Switching models across providers inside a shared pool also works without naming poolId.
  h.cfg.pools = [{ id: 'main', title: 'Main', accountIds: ['claude-3', 'codex-main', 'antigravity-main'] }];
  const sharedPool = h.runner.poolById('main')!;
  h.runner.update({ threadId: neon.thread.id, poolId: sharedPool.id });
  h.runner.update({ threadId: neon.thread.id, model: 'gemini-4-neon' });
  assert.equal(h.runner.get(neon.thread.id).provider, 'antigravity');
  assert.equal(h.runner.get(neon.thread.id).model, 'gemini-4-neon');
  assert.equal(h.runner.get(neon.thread.id).poolId, sharedPool.id);
  assert.equal(claude.sessions.length, 0);
  c.stop();
});

test('hidden helpers run one at a time, stay invisible to inbox/search/notifications, and surface in Activity and subagent view', async () => {
  const { h, c, project, antigravity } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'antigravity-main', model: 'gemini-4-neon' });
  await tick();
  antigravity.sessions.at(-1)!.result('completed');
  await tick();
  const notesBefore = h.notes.length;

  const started = c.startHelper(project.id, { title: 'Check pantry', doneWhen: 'Inventory reported', brief: 'Read current inventory' });
  await tick();
  assert.equal(c.get(project.id).tasks[0].state, 'working');
  assert.equal(c.get(project.id).tasks[0].run?.status, 'running');
  assert.equal(c.get(project.id).tasks[0].run?.helperThreadId, started.helperId);

  // Single worker at a time.
  assert.throws(() => c.startHelper(project.id, { brief: 'Another job' }), /already working/);

  // Hidden helper is invisible in lists, search, recipe runs, and client notifications.
  assert.equal(h.runner.list(['inbox', 'snoozed', 'archived']).some((t) => t.id === started.helperId), false);
  assert.equal(h.runner.search('Check pantry').some((t) => t.id === started.helperId), false);
  assert.equal(h.runner.recipeRunsSince(0).some((t) => t.id === started.helperId), false);
  assert.equal(h.notes.slice(notesBefore).some((n) => 'params' in n && ((n.params as { threadId?: string; thread?: { id: string } }).threadId === started.helperId || (n.params as { thread?: { id: string } }).thread?.id === started.helperId)), false);

  // Coordinator thread exposes the helper in subagents (for Activity) and its transcript via runner.subagent.
  const subagents = h.runner.get(coordinator.threadId).subagents ?? [];
  assert.equal(subagents.length, 1);
  assert.equal(subagents[0].id, started.helperId);
  assert.equal(subagents[0].status, 'running');

  const helperSession = antigravity.sessions.find((s) => s.opts.threadId === started.helperId)!;
  assert.equal(helperSession.opts.coordinator?.role, 'helper');
  helperSession.text('m1', 'Inventory checked: 4 tins left.');
  helperSession.result('completed');
  await tick();

  assert.equal(c.get(project.id).tasks[0].run?.status, 'completed');
  assert.equal(c.get(project.id).tasks[0].run?.summary, 'Inventory checked: 4 tins left.');
  assert.equal(c.get(project.id).tasks[0].state, 'review');
  assert.equal(h.runner.get(coordinator.threadId).subagents?.[0].status, 'completed');

  const transcript = h.runner.subagent(coordinator.threadId, started.helperId);
  assert.equal(transcript.subagent?.id, started.helperId);
  assert.ok(transcript.events.some((e) => e.type === 'assistant.text' && e.text.includes('4 tins left')));

  // Coordinator was woken with the quoted helper report.
  const coordSession = antigravity.sessions.find((s) => s.opts.threadId === coordinator.threadId)!;
  assert.ok(coordSession.sent.some((m) => m.text.includes('A helper turn finished') && m.text.includes('4 tins left')));

  c.completeTask(project.id, started.taskId);
  assert.equal(c.get(project.id).tasks[0].state, 'done');
  assert.throws(() => runMove('completed', 'running'), /cannot/);
  c.stop();
});

test('a stale turn id cannot finish a resumed helper run', async () => {
  const { c, project, antigravity } = setup();
  c.create({ projectId: project.id, accountId: 'antigravity-main', model: 'gemini-4-neon' });
  await tick();
  const started = c.startHelper(project.id, { brief: 'First pass' });
  await tick();
  const firstRunId = c.get(project.id).tasks[0].run!.nativeRunId!;
  antigravity.sessions.find((s) => s.opts.threadId === started.helperId)!.result('completed');
  await tick();
  assert.equal(c.get(project.id).tasks[0].run?.status, 'completed');

  const resumed = c.resumeHelper(project.id, { helperId: started.helperId, brief: 'Second pass' });
  await tick();
  assert.equal(resumed.helperId, started.helperId);
  assert.equal(c.get(project.id).tasks[0].run?.status, 'running');
  // Stale completion from first run id is ignored.
  c.onHelperTurn(started.helperId, 'completed', 'Stale result', firstRunId);
  assert.equal(c.get(project.id).tasks[0].run?.status, 'running');
  // Current completion finishes it.
  antigravity.sessions.find((s) => s.opts.threadId === started.helperId)!.result('completed');
  await tick();
  assert.equal(c.get(project.id).tasks[0].run?.status, 'completed');
  c.stop();
});

test('a failed helper send releases its reservation and archived work stays recoverable', async () => {
  const { c, h, project, home } = setup();
  c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const origSend = h.runner.send.bind(h.runner);
  h.runner.send = (id, ...rest) => {
    if (h.runner.threads.get(id)?.rec.coordinatorHelperFor) throw new Error('Launch refused');
    return origSend(id, ...rest);
  };
  assert.throws(() => c.startHelper(project.id, { title: 'Check inventory', brief: 'Check inventory' }), /Launch refused/);
  const task = c.get(project.id).tasks[0];
  assert.equal(task.state, 'blocked');
  assert.equal(task.run?.status, 'failed');
  assert.throws(() => c.archiveTask(project.id, task.id), /finished/);
  c.completeTask(project.id, task.id);
  c.archiveTask(project.id, task.id);
  assert.equal(c.get(project.id).tasks.length, 0);
  const history = JSON.parse(fs.readFileSync(path.join(home, 'coordinator-history.jsonl'), 'utf8'));
  assert.equal(history.task.run.brief, 'Check inventory');
  c.stop();
});

test('startHelper selects the intended unstarted task, validates cwd, and never reopens accepted work implicitly', async () => {
  const { c, project, projects } = setup();
  const repoDir = tmpDir();
  const outsideDir = tmpDir();
  projects.update(project.id, { folders: [repoDir] });
  c.create({ projectId: project.id, accountId: 'claude-3' });
  const first = c.addTask(project.id, 'Already answered', 'The answer is recorded').tasks[0];
  c.completeTask(project.id, first.id);
  const second = c.addTask(project.id, 'Check food', 'Inventory checked').tasks[1];
  c.addTask(project.id, 'Order next week', 'Order prepared');

  assert.throws(() => c.startHelper(project.id, { brief: 'Check food' }), /selectTask/);
  assert.throws(() => c.startHelper(project.id, { taskId: second.id, brief: 'Check food', cwd: outsideDir }), /project’s folders/);
  c.selectTask(project.id, second.id);
  const started = c.startHelper(project.id, { brief: 'Check food' });
  await tick();
  const tasks = c.get(project.id).tasks;
  assert.equal(tasks[0].state, 'done');
  assert.equal(tasks[0].run, undefined);
  assert.equal(tasks[1].id, started.taskId);
  assert.equal(tasks[1].run?.helperThreadId, started.helperId);
  assert.equal(tasks[2].run, undefined);
  c.stop();
});

test('pause stops coordinator and helper sessions, rejects dispatch, and survives a restart', async () => {
  const { c, h, project, home, claude } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const started = c.startHelper(project.id, { brief: 'Inspect food' });
  await tick();
  const helperSession = claude.sessions.find((s) => s.opts.threadId === started.helperId)!;
  const helperBoundary = c.session(started.helperId)!;
  await c.pause(project.id, true);
  assert.equal(helperSession.endedHard, true);
  assert.match(helperBoundary.checkTool({ name: 'Read', input: {} })!, /paused/);
  assert.match(c.dispatchRefusal(started.helperId)!, /paused/);
  c.stop();
  const restarted = new Coordinators({ home, host: h.runner, projects: h.runner.projects!, clock: h.clock, enabled: () => true, log: nullLogger });
  assert.equal(restarted.get(project.id).state, 'paused');
  assert.equal(restarted.get(project.id).tasks[0].run?.status, 'interrupted');
  assert.match(restarted.context(coordinator.threadId)!, /reconcile/i);
  restarted.stop();
});

test('a concurrent resume waits for both coordinator and helper processes to stop', async () => {
  const { c, project, claude } = setup();
  c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const started = c.startHelper(project.id, { brief: 'Inspect food' });
  await tick();
  const coordSession = claude.sessions.find((s) => s.opts.threadId !== started.helperId)!;
  const helperSession = claude.sessions.find((s) => s.opts.threadId === started.helperId)!;
  coordSession.slowExit = true;
  helperSession.slowExit = true;
  const pause = c.pause(project.id, true);
  const resume = c.pause(project.id, false);
  await tick();
  assert.equal(c.get(project.id).state, 'paused');
  coordSession.exit();
  await tick();
  assert.equal(c.get(project.id).state, 'paused', 'still waiting for the helper to exit');
  helperSession.exit();
  await Promise.all([pause, resume]);
  assert.equal(c.get(project.id).state, 'active');
  c.stop();
});

test('a runner handover ends coordinator and helper sessions and prevents the draining writer changing its registry', async () => {
  const { c, h, project, home, projects, claude } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const started = c.startHelper(project.id, { brief: 'Inspect food' });
  await tick();
  const coordSession = claude.sessions.find((s) => s.opts.threadId === coordinator.threadId)!;
  const helperSession = claude.sessions.find((s) => s.opts.threadId === started.helperId)!;
  await c.handover();
  assert.equal(coordSession.endedHard, true);
  assert.equal(helperSession.endedHard, true);
  assert.equal(c.get(project.id).tasks[0].run?.status, 'interrupted');
  const saved = fs.readFileSync(path.join(home, 'coordinators.json'), 'utf8');
  c.onHelperTurn(started.helperId, 'completed', 'Late finish');
  assert.equal(fs.readFileSync(path.join(home, 'coordinators.json'), 'utf8'), saved);
  const replacement = new Coordinators({ home, host: h.runner, projects, clock: h.clock, enabled: () => true, log: nullLogger });
  assert.equal(replacement.get(project.id).tasks[0].run?.status, 'interrupted');
  replacement.stop();
});

test('helper approval and question cards never reach the user; they record on the coordinator and resume cleanly', async () => {
  const { c, h, project, codex } = setup();
  c.create({ projectId: project.id, accountId: 'codex-main', model: 'gpt-6-luna' });
  await tick();
  const started = c.startHelper(project.id, { brief: 'Check pantry' });
  await tick();
  const helperSession = codex.sessions.find((s) => s.opts.threadId === started.helperId)!;
  const helperSt = h.runner.threads.get(started.helperId)!;

  // Helper asking a question or needing approval gets refused with HELPER_REPORT and recorded on coordinator.
  const questions = [{ header: 'Food', question: 'Keep the milk?', options: [{ label: 'Keep', description: 'Keep it' }, { label: 'Discard', description: 'Discard it' }], multiSelect: false }];
  const qAns1 = await h.runner.requestQuestion(helperSt, helperSt.rt.generation, { questions, signal: new AbortController().signal });
  const qAns2 = await h.runner.requestQuestion(helperSt, helperSt.rt.generation, { questions, signal: new AbortController().signal });
  assert.equal(qAns1.answers, null);
  assert.match(qAns1.message!, /coordinator/i);
  assert.equal(qAns2.answers, null);
  assert.equal(helperSt.rt.approvals.size, 0);
  assert.equal(c.get(project.id).questions.length, 1);

  const aAns = await h.runner.requestApproval(helperSt, helperSt.rt.generation, { name: 'Bash', title: 'Run rm', input: {}, canAlwaysAllow: false, signal: new AbortController().signal });
  assert.equal(aAns.decision, 'deny');
  assert.match(aAns.message!, /coordinator/i);
  assert.equal(helperSt.rt.approvals.size, 0);

  helperSession.text('m1', 'Waiting for an answer');
  helperSession.result('completed');
  await tick();
  assert.equal(c.get(project.id).tasks[0].run?.status, 'interrupted');
  assert.equal(c.get(project.id).tasks[0].state, 'blocked');

  const question = c.get(project.id).questions[0];
  c.answer(project.id, question.id, 'Keep, as Mike already decided');
  assert.equal(c.get(project.id).questions[0].state, 'answered');
  assert.match(c.get(project.id).questions[0].answer!, /Mike already decided/);

  // Resume the helper (even switching it to Antigravity!).
  c.resumeHelper(project.id, { helperId: started.helperId, brief: 'Answer: Keep the milk.', accountId: 'antigravity-main', model: 'gemini-4-neon' });
  await tick();
  assert.equal(c.get(project.id).tasks[0].run?.status, 'running');
  assert.equal(h.runner.threads.get(started.helperId)?.rec.provider, 'antigravity');
  c.stop();
});

test('corrupt registry fails closed rather than losing coordinator restrictions', () => {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'coordinators.json'), '{broken');
  assert.throws(() => setup(home), /coordinator registry/i);
});

test('coordinator and helper restrictions apply to thread-owned RPC, MCP tool lists, and adapter policies before Full access', async () => {
  const { c, h, project, projects } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'antigravity-main', model: 'gemini-4-neon' });
  await tick();
  const started = c.startHelper(project.id, { brief: 'Implement fix' });
  await tick();

  const gate = new CallerGate({ runner: h.runner });
  for (const tid of [coordinator.threadId, started.helperId]) {
    assert.throws(() => gate.check(tid, 'threads.create', { text: 'Escape' }), /cannot/);
    assert.throws(() => gate.check(tid, 'settings.update', {}), /cannot/);
    assert.throws(() => gate.check(tid, 'coordinators.start', { projectId: project.id }), /project home/);
    assert.throws(() => gate.check(tid, 'projects.update', { projectId: project.id, state: 'Working' }), /cannot/);
  }

  // Coordinator boundary checks project ownership.
  const coordBoundary = c.session(coordinator.threadId)!;
  assert.equal(coordBoundary.checkTool({ name: 'mcp__threadbear__update_project', input: { project: project.id } }), undefined);
  assert.match(coordBoundary.checkTool({ name: 'mcp__threadbear__update_project', input: { project: 'another-project' } })!, /own project/);
  assert.match(coordBoundary.checkTool({ name: 'mcp__threadbear__create_thread', input: {} })!, /not available/);
  assert.equal(coordBoundary.checkTool({ name: 'mcp__threadbear__add_button', input: { title: 'Tidy contacts', start: { text: 'Brief' } } }), undefined);

  // Helper boundary only permits read-only Threadbear tools.
  const helperBoundary = c.session(started.helperId)!;
  assert.equal(helperBoundary.checkTool({ name: 'mcp__threadbear__read_project', input: {} }), undefined);
  assert.match(helperBoundary.checkTool({ name: 'mcp__threadbear__end_turn', input: {} })!, /coordinator/i);
  assert.match(helperBoundary.checkTool({ name: 'mcp__threadbear__coordinator', input: {} })!, /coordinator/i);

  // MCP tool list filtering for coordinator vs helper.
  const pc: ProjectControl = {
    list: (p) => projects.list(p), get: (id) => projects.get(id), find: (q) => projects.find(q),
    create: (p) => projects.create(p), editNotes: (id, edits, p) => projects.editNotes(id, edits, p),
    appendNote: (id, text) => projects.appendNote(id, text), changeMembership: (id, p) => projects.changeMembership(id, p),
    update: (id, p) => projects.update(id, p),
  };
  const coordTools = buildThreadbearTools(h.runner, coordinator.threadId, () => h.clock.now(), undefined, pc, undefined, { coordinators: () => c }).map((t) => t.name);
  assert.ok(coordTools.includes('coordinator'));
  assert.ok(coordTools.includes('end_turn'));
  assert.ok(coordTools.includes('update_project'));
  assert.equal(coordTools.includes('create_thread'), false);
  assert.equal(coordTools.includes('delete_thread'), false);
  assert.ok(coordTools.includes('add_button'), 'side jobs are offered as a button only Mike can press');
  const buttonTool = buildThreadbearTools(h.runner, coordinator.threadId, () => h.clock.now(), undefined, pc, undefined, { coordinators: () => c }).find((t) => t.name === 'add_button') as unknown as { handler: (p: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> };
  for (const extra of [{ panel: { folder: '.', panel: 'missing' } }, { send: { threadId: coordinator.threadId, text: 'Hi' } }, {}]) {
    const r = await buttonTool.handler({ title: 'Do it', ...extra }, {});
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.match(r.content[0]!.text, /only make start buttons/);
  }
  const made = await buttonTool.handler({ title: 'Tidy contacts', start: { text: 'Find duplicate contacts and suggest merges.' } }, {});
  assert.notEqual(made.isError, true, made.content[0]!.text);
  assert.match(made.content[0]!.text, /starts a thread/);

  const helperTools = buildThreadbearTools(h.runner, started.helperId, () => h.clock.now(), undefined, pc, undefined, { coordinators: () => c }).map((t) => t.name);
  assert.ok(helperTools.every((n) => HELPER_THREADBEAR_TOOLS.has(n)));
  assert.equal(helperTools.includes('end_turn'), false);
  assert.equal(helperTools.includes('coordinator'), false);
  assert.equal(helperTools.includes('create_thread'), false);
  assert.equal(helperTools.includes('add_button'), false);

  // Shared ACP & Claude policies block coordinator writes/sub-agents and helper escalation.
  assert.ok(acpCoordinatorTool({ role: 'coordinator', kind: 'edit', name: 'write_to_file' }).reason);
  assert.ok(acpCoordinatorTool({ role: 'coordinator', kind: 'execute', name: 'run_command' }).reason);
  assert.ok(acpCoordinatorTool({ role: 'coordinator', name: 'invoke_subagent' }).reason);
  assert.ok(acpCoordinatorTool({ role: 'coordinator', external: true, name: 'external_write' }).reason);
  assert.equal(acpCoordinatorTool({ role: 'coordinator', kind: 'read', name: 'view_file' }).reason, undefined);
  assert.equal(acpCoordinatorTool({ role: 'coordinator', mcpName: 'threadbear__coordinator' }).reason, undefined);
  // Agent Archive only reads, so a coordinator can look back before asking; other servers stay out.
  assert.ok(acpCoordinatorTool({ role: 'coordinator', external: true, mcpName: 'agent-archive__search_archive' }).reason, 'ACP sessions have no archive, so nothing claiming to be it is let through');
  assert.ok(coordinatorTool('mcp__agent-archive__evil__write_file', {}, false).reason, 'a server named agent-archive__evil is not the archive');
  assert.ok(coordinatorTool('mcp__agent-archive__write', {}, false).reason, 'only the known read tools');
  assert.deepEqual(coordinatorTool('mcp__agent-archive__get_archive_context', {}, false), {});
  assert.ok(coordinatorTool('mcp__connectors__gmail__send_message', {}, false).reason);
  assert.ok(coordinatorTool('mcp__agent-archive__search_archive', {}, true).reason === undefined, 'helpers already have non-escalating tools');
  assert.equal(acpCoordinatorTool({ role: 'helper', kind: 'edit', name: 'write_to_file' }).reason, undefined);
  assert.ok(acpCoordinatorTool({ role: 'helper', name: 'invoke_subagent' }).reason);
  assert.ok(acpCoordinatorTool({ role: 'helper', name: 'ask_question' }).reason);
  assert.ok(acpCoordinatorTool({ role: 'helper', mcpName: 'threadbear__end_turn' }).reason);
  assert.ok(coordinatorTool('Agent', {}, false).reason);
  assert.ok(coordinatorTool('Write', {}, false).reason);
  assert.equal(coordinatorTool('Write', {}, true).reason, undefined);
  assert.ok(coordinatorTool('Agent', {}, true).reason);
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

test('a coordinator project edit compares its source fields on the owning write, even in Full access', async () => {
  const { c, h, project, projects } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  projects.update(project.id, { notes: 'Original decision' });
  const pc: ProjectControl = {
    list: (p) => projects.list(p), get: (id) => projects.get(id), find: (q) => projects.find(q),
    create: (p) => projects.create(p), editNotes: (id, edits, p) => projects.editNotes(id, edits, p),
    appendNote: (id, text) => projects.appendNote(id, text), changeMembership: (id, p) => projects.changeMembership(id, p),
    update: (id, p) => {
      projects.update(id, { notes: 'A newer decision from another thread' });
      return projects.update(id, p);
    },
  };
  const tool = buildThreadbearTools(h.runner, coordinator.threadId, () => h.clock.now(), undefined, pc, undefined, { coordinators: () => c }).find((t) => t.name === 'update_project')!;
  const result = await tool.handler({ project: project.id, notes: 'Would overwrite the newer decision', state: 'Would overwrite too' } as never, {});
  assert.equal(result.isError, true);
  assert.equal(projects.get(project.id).project.notes, 'A newer decision from another thread');
  assert.equal(projects.get(project.id).project.state, '');
  c.stop();
});

test('a user timer earlier than a pending event batch takes precedence and delivers the pending events together', async () => {
  const { c, h, project, claude } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const other = h.runner.create({ text: 'Check stock', accountId: 'claude-3', projectIds: [project.id] }).thread;
  await tick();
  claude.sessions.find((s) => s.opts.threadId === other.id)!.result('completed');
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
  const { c, h, project, claude } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  claude.sessions.at(-1)!.result('completed');
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

test('acknowledged project events survive recovery by a fresh runner before their queued turn starts', async () => {
  const { c, h, project, home } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  c.forThread(coordinator.threadId)!.events.push({ key: 'durable', text: 'Durable project event' });
  c.update(project.id, { wakeAt: new Date(h.clock.now() + 60_000).toISOString() });
  h.clock.advance(60_000);
  assert.equal(c.forThread(coordinator.threadId)!.events.length, 0);
  assert.ok(h.runner.threads.get(coordinator.threadId)!.rec.queue.some((q) => q.text.includes('Durable project event')));
  c.stop();
  const { adapter, c: replacement } = recoverFresh(h, home);
  await tick();
  assert.ok(adapter.sessions.some((s) => s.sent.some((m) => m.text.includes('Durable project event'))), 'recovery dispatches the queued event instead of turning it into a note');
  replacement.stop();
});

test('a fresh runner does not replay a started update left in a stale queue snapshot', async () => {
  const { c, h, project, home, claude } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  c.forThread(coordinator.threadId)!.events.push({ key: 'stale', text: 'Already delivered update' });
  c.update(project.id, { wakeAt: new Date(h.clock.now() + 60_000).toISOString() });
  h.clock.advance(60_000);
  const stale = structuredClone(h.runner.threads.get(coordinator.threadId)!.rec);
  assert.ok(stale.queue.some((q) => q.text.includes('Already delivered update')));
  claude.sessions.at(-1)!.result('completed');
  await tick();
  assert.ok(h.events(coordinator.threadId).some((e) => e.type === 'user.message' && e.text.includes('Already delivered update')));
  h.runner.store.save(stale);
  c.stop();
  const fresh = recoverFresh(h, home);
  await tick();
  assert.ok(fresh.host.threads.get(coordinator.threadId)!.rec.queue.every((q) => !q.text.includes('Already delivered update')));
  assert.ok(fresh.adapter.sessions.every((s) => s.sent.every((m) => !m.text.includes('Already delivered update'))));
  fresh.c.stop();
});

test('project removal cannot race a slow Pause and its pending Resume', async () => {
  const { c, h, projects, project, claude } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const session = claude.sessions.at(-1)!;
  session.slowExit = true;
  const pause = c.pause(project.id, true);
  const resume = c.pause(project.id, false);
  assert.throws(() => projects.delete(project.id), /still stopping/);
  assert.throws(() => h.runner.delete(coordinator.threadId), /still stopping/);
  session.exit();
  await Promise.all([pause, resume]);
  assert.equal(c.get(project.id).state, 'active');
  assert.equal(h.runner.get(coordinator.threadId).coordinatorProjectId, project.id);
  assert.equal(h.runner.get(coordinator.threadId).archivedAt, undefined);
  c.stop();
});

test('removal keeps restrictions until the archived conversation has saved durably', async () => {
  const { c, h, projects, project, home } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  await c.pause(project.id, true);
  const save = h.runner.store.save.bind(h.runner.store);
  h.runner.store.save = () => { throw Error('Disk unavailable'); };
  assert.throws(() => projects.delete(project.id), /Disk unavailable/);
  assert.equal(c.get(project.id).state, 'paused');
  assert.equal(projects.get(project.id).project.id, project.id);
  h.runner.store.save = save;
  projects.delete(project.id);
  assert.equal(c.list().length, 0);
  assert.ok(new ThreadStore(home).loadAll().records.find((r) => r.id === coordinator.threadId)?.archivedAt);
  c.stop();
});

test('project deletion and merge require the coordinator stopped, then archive its conversation and trash its hidden helpers', async () => {
  for (const action of ['delete', 'merge'] as const) {
    const { c, h, projects, project, home } = setup();
    const target = projects.create({ title: 'Other project', by: 'mike' });
    const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
    await tick();
    const started = c.startHelper(project.id, { brief: 'Work item' });
    await tick();
    assert.throws(() => h.runner.delete(started.helperId), /managed by its project coordinator/);
    const remove = () => action === 'delete' ? projects.delete(project.id) : projects.merge(project.id, target.id);
    assert.throws(remove, /Pause/);
    assert.equal(projects.get(project.id).project.id, project.id);
    await c.pause(project.id, true);
    remove();
    assert.equal(c.list().length, 0);
    assert.ok(h.runner.get(coordinator.threadId).archivedAt);
    assert.equal(h.runner.has(started.helperId), false);
    const history = fs.readFileSync(path.join(home, 'coordinator-history.jsonl'), 'utf8');
    assert.ok(history.includes(coordinator.threadId));
    c.stop();
  }
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

test('turning the experiment off stops coordinator and helper sessions and keeps their restrictions', async () => {
  let enabled = true;
  const { c, h, project, claude } = setup(tmpDir(), () => enabled);
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const started = c.startHelper(project.id, { brief: 'Background job' });
  await tick();
  const coordSession = claude.sessions.find((s) => s.opts.threadId === coordinator.threadId)!;
  const helperSession = claude.sessions.find((s) => s.opts.threadId === started.helperId)!;
  assert.equal(h.runner.get(coordinator.threadId).coordinatorProjectId, project.id);
  enabled = false;
  h.runner.publish({ method: 'settings.updated', params: { settings: {} as Settings } });
  assert.equal(coordSession.killed, true);
  assert.equal(helperSession.killed, true);
  assert.equal(c.get(project.id).state, 'paused');
  assert.equal(h.runner.get(coordinator.threadId).coordinatorProjectId, undefined);
  assert.match(c.dispatchRefusal(coordinator.threadId)!, /paused/);
  assert.match(c.dispatchRefusal(started.helperId)!, /paused/);
  assert.match(c.rpcRefusal(coordinator.threadId, 'threads.create', {})!, /paused/);
  assert.match(c.rpcRefusal(started.helperId, 'threads.create', {})!, /paused/);
  c.stop();
});

test('an active coordinator and its helpers cannot disappear through archive, delete or a cross-runner move', async () => {
  const { c, h, project } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const started = c.startHelper(project.id, { brief: 'Helper work' });
  await tick();
  assert.throws(() => h.runner.update({ threadId: coordinator.threadId, archived: true }), /Pause/);
  assert.throws(() => h.runner.delete(coordinator.threadId), /Pause/);
  await assert.rejects(h.runner.describeForMove(coordinator.threadId, 0), /owning runner/);
  await assert.rejects(h.runner.describeForMove(started.helperId, 0), /owning runner/);
  await c.pause(project.id, true);
  h.runner.update({ threadId: coordinator.threadId, archived: true });
  assert.ok(h.runner.get(coordinator.threadId).archivedAt);
  h.runner.delete(coordinator.threadId);
  assert.equal(c.list().length, 0);
  assert.throws(() => h.runner.get(coordinator.threadId), /not found/i);
  assert.equal(h.runner.has(started.helperId), false);
  c.stop();
});

test('idle coordinator compaction sends /compact on Claude/Codex and skips ACP providers', async () => {
  const { c, h, project, projects, claude, antigravity } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const session = claude.sessions.at(-1)!;
  const st = h.runner.threads.get(coordinator.threadId)!;
  st.rec.contextTokens = 110_000;
  session.result('completed');
  await tick();
  h.clock.advance(49 * 60_000);
  assert.equal(session.sent.filter((m) => m.text.startsWith('/compact')).length, 0);
  h.clock.advance(60_000);
  await tick();
  const compact = claude.sessions.flatMap((s) => s.sent).find((m) => m.text.startsWith('/compact'));
  assert.ok(compact, 'no project memory is prepended to the slash command');
  projects.update(project.id, { notes: 'A decision made while compacting' });
  assert.match(session.opts.coordinator!.context!()!, /decision made while compacting/);

  // ACP coordinator does not receive /compact.
  const p2 = projects.create({ title: 'Neon Compaction', goals: 'Test ACP', by: 'mike' });
  const neon = c.create({ projectId: p2.id, accountId: 'antigravity-main', model: 'gemini-4-neon' });
  await tick();
  const neonSession = antigravity.sessions.at(-1)!;
  h.runner.threads.get(neon.thread.id)!.rec.contextTokens = 180_000;
  neonSession.result('completed');
  await tick();
  h.clock.advance(60 * 60_000);
  await tick();
  assert.equal(neonSession.sent.filter((m) => m.text.startsWith('/compact')).length, 0);
  c.stop();
});

test('a turn finishing on a draining runner’s thread reaches the coordinator through the peer’s summary (THREADBEAR-2R)', async () => {
  const home = tmpDir();
  const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger });
  const h = makeHarness(home, {}, { projects, accounts: new FakeAccounts(allAccounts()) });
  const peerThreads = new Map<string, ThreadSummary>();
  const c = new Coordinators({ home, host: h.runner, projects, clock: h.clock, enabled: () => true, log: nullLogger, elsewhere: (id) => peerThreads.get(id) });
  h.runner.coordinators = c;
  projects.start(h.runner);
  c.start();
  const project = projects.create({ title: 'Pantry', goals: 'Keep food fresh', by: 'mike' });
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  peerThreads.set('peer-thread', { id: 'peer-thread', title: 'Check stock', preview: 'Two tins left', projects: [{ id: project.id, title: 'Pantry' }] } as ThreadSummary);
  const forward = (threadId: string, turnId: string) => h.runner.publish({ method: 'thread.event', params: { threadId, seq: 1, event: { type: 'turn.completed', turnId, outcome: 'completed' } } } as never);
  assert.doesNotThrow(() => forward('peer-thread', 't1'));
  assert.doesNotThrow(() => forward('unknown-thread', 't2'));
  const events = c.forThread(coordinator.threadId)!.events;
  assert.equal(events.length, 1);
  assert.match(events[0]!.text, /Check stock/);
  c.stop();
});

test('adding a coordinator when every login for its chosen provider in the pool is out says when one is back, before making a thread', () => {
  const home = tmpDir();
  const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger });
  const fake = new FakeAccounts(allAccounts());
  const h = makeHarness(home, {}, { projects, accounts: fake });
  const resetsAt = new Date(h.clock.now() + 6 * 3600_000).toISOString();
  fake.base = fake.base.map((a) => (a.provider === 'claude' ? { ...a, usage: { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 0, resetsAt }], readAt: new Date(h.clock.now()).toISOString(), source: 'live' as const, blocked: true } } : a));
  const c = new Coordinators({ home, host: h.runner, projects, clock: h.clock, enabled: () => true, log: nullLogger });
  h.runner.coordinators = c;
  projects.start(h.runner);
  c.start();
  const project = projects.create({ title: 'Pantry', goals: 'Keep food fresh', by: 'mike' });
  assert.throws(() => c.create({ projectId: project.id, model: 'claude-opus-4-6' }), /No Claude login in .+ has room until/);
  assert.equal(c.list().length, 0);
  assert.equal(h.runner.threadRecords().length, 0);
  c.stop();
});

test('durable open loops track user questions and coordinator asks across overlapping topics, with close/reopen/reply and restart recovery', async () => {
  const { h, c, project, home, claude } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const session = claude.sessions.at(-1)!;
  session.result('completed');
  await tick();

  // Coordinator records a user question while checking, then marks it answered with a summary.
  const q1 = c.openLoop(project.id, { kind: 'user_question', title: 'What hardware and sensors are inside Omi CV1?' });
  assert.equal(c.get(project.id).loops.length, 1);
  assert.equal(c.get(project.id).loops[0]!.state, 'open');

  // Deduplicates by normalized title rather than creating a second loop.
  const q1Dup = c.openLoop(project.id, {
    kind: 'user_question',
    title: '  what hardware   and sensors are inside omi cv1? ',
    state: 'answered',
    summary: '6-axis IMU and 2x PDM mics, disabled on stock 3.0.24.',
  });
  assert.equal(q1Dup.loopId, q1.loopId);
  assert.equal(c.get(project.id).loops.length, 1);
  assert.equal(c.get(project.id).loops[0]!.state, 'answered');

  // Auto-captures waiting_on_user asks from turn.completed without overwriting earlier loops.
  h.runner.publish({
    method: 'thread.event',
    params: {
      threadId: coordinator.threadId,
      seq: 12,
      event: {
        type: 'turn.completed',
        seq: 12,
        turnId: 'turn-1',
        outcome: 'completed',
        needs: 'you',
        asks: [{ action: 'Build iOS movement auto-resume?', why: 'Bypasses 2h 100% battery flatline.', options: ['Build it', 'Not yet'] }],
      },
    },
  } as never);
  h.runner.publish({
    method: 'thread.event',
    params: {
      threadId: coordinator.threadId,
      seq: 18,
      event: {
        type: 'turn.completed',
        seq: 18,
        turnId: 'turn-2',
        outcome: 'completed',
        needs: 'you',
        asks: [{ action: 'Which voice-triage fixes should I ship?', options: ['Dedupe + queue floor', '+ LLM TV filter'] }],
      },
    },
  } as never);
  assert.equal(c.get(project.id).loops.length, 3);
  const ask1 = c.get(project.id).loops[1]!;
  const ask2 = c.get(project.id).loops[2]!;
  assert.equal(ask1.kind, 'waiting_on_user');
  assert.deepEqual(ask1.options, ['Build it', 'Not yet']);
  assert.equal(ask1.sourceSeq, 12);
  assert.equal(ask2.title, 'Which voice-triage fixes should I ship?');

  // Open loops are included in the coordinator's desk context.
  assert.match(c.context(coordinator.threadId)!, /What hardware and sensors/);
  assert.match(c.context(coordinator.threadId)!, /Build iOS movement auto-resume/);

  // Explicit close + reopen (Undo) on answered user question restores answered state.
  c.closeLoop(project.id, q1.loopId);
  assert.equal(c.get(project.id).loops[0]!.state, 'closed');
  assert.ok(c.get(project.id).loops[0]!.closedAt);
  c.reopenLoop(project.id, q1.loopId);
  assert.equal(c.get(project.id).loops[0]!.state, 'answered');
  assert.equal(c.get(project.id).loops[0]!.closedAt, undefined);

  // Follow-up reply on a user question sends to the thread and returns it to open (Checking...).
  c.replyLoop(project.id, q1.loopId, 'Does stock firmware expose battery voltage?');
  await tick();
  assert.equal(c.get(project.id).loops[0]!.state, 'open');
  assert.ok(session.sent.some((m) => m.text.includes('Follow-up on') && m.text.includes('battery voltage')));

  // Answering a waiting_on_user loop via replyLoop closes it and messages the coordinator.
  c.replyLoop(project.id, ask1.id, 'Build it');
  await tick();
  assert.equal(c.get(project.id).loops[1]!.state, 'closed');
  assert.ok(session.sent.some((m) => m.text.includes('Build iOS movement auto-resume?') && m.text.includes('Build it')));

  // Answering an ask on the composer card (user.message answers) auto-closes the matching loop.
  h.runner.publish({
    method: 'thread.event',
    params: {
      threadId: coordinator.threadId,
      seq: 22,
      event: {
        type: 'user.message',
        seq: 22,
        text: 'Dedupe + queue floor',
        answers: [{ action: 'Which voice-triage fixes should I ship?', answer: 'Dedupe + queue floor' }],
      },
    },
  } as never);
  assert.equal(c.get(project.id).loops[2]!.state, 'closed');

  // Paused coordinator refuses replyLoop, while closeLoop still works.
  await c.pause(project.id, true);
  assert.throws(() => c.replyLoop(project.id, q1.loopId, 'Still checking?'), /paused/);
  c.closeLoop(project.id, q1.loopId);
  assert.equal(c.get(project.id).loops[0]!.state, 'closed');

  // Loops persist across restart, and legacy coordinators.json without loops loads cleanly.
  c.stop();
  const restarted = recoverFresh(h, home);
  assert.equal(restarted.c.get(project.id).loops.length, 3);
  restarted.c.stop();

  const raw = JSON.parse(fs.readFileSync(path.join(home, 'coordinators.json'), 'utf8')) as Record<string, unknown>[];
  delete raw[0]!.loops;
  fs.writeFileSync(path.join(home, 'coordinators.json'), JSON.stringify(raw));
  const legacy = recoverFresh(h, home);
  assert.deepEqual(legacy.c.get(project.id).loops, []);
  legacy.c.stop();
});

test('coordinator MCP tool supports openLoop, updateLoop, and closeLoop', async () => {
  const { h, c, project } = setup();
  const { coordinator } = c.create({ projectId: project.id, accountId: 'claude-3' });
  await tick();
  const tools = buildThreadbearTools(
    {} as never,
    coordinator.threadId,
    () => h.clock.now(),
    undefined,
    {} as ProjectControl,
    undefined,
    { coordinators: () => c },
  );
  const coordTool = tools.find((t) => t.name === 'coordinator') as unknown as { handler: (p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };
  assert.ok(coordTool);
  const openedRes = await coordTool.handler({ action: 'openLoop', loopKind: 'user_question', title: 'Does waterproofing muffle mic level 8?' });
  const opened = JSON.parse(openedRes.content[0]!.text) as { loopId: string };
  assert.equal(c.get(project.id).loops[0]!.state, 'open');

  await coordTool.handler({ action: 'updateLoop', loopId: opened.loopId, loopState: 'answered', summary: 'Minimal attenuation under 1 dB.' });
  assert.equal(c.get(project.id).loops[0]!.state, 'answered');
  assert.equal(c.get(project.id).loops[0]!.summary, 'Minimal attenuation under 1 dB.');

  await coordTool.handler({ action: 'closeLoop', loopId: opened.loopId });
  assert.equal(c.get(project.id).loops[0]!.state, 'closed');
  c.stop();
});

