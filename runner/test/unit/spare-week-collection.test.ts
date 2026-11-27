// The primitives the spare-week brief asks an agent to use. No model,
// accounts, backend or real transcripts: scripted tool calls exercise the
// contract, not whether an LLM will follow it or write an accurate digest.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAccounts, makeHarness, tick, withCodex } from '../helpers/fakes.ts';
import { patiently } from '../helpers/patience.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { Scheduler } from '../../src/schedules.ts';
import { nullLogger } from '../../src/log.ts';
import { formatThread } from '../../src/tb-dev.ts';

const TWO_HOURS = 2 * 3_600_000;
const END_TURN = 'mcp__threadbear__end_turn';

function setup(t: TestContext) {
  const h = makeHarness(undefined, { oneReply: true }, { accounts: new FakeAccounts(withCodex()) });
  const parent = h.runner.create({ text: 'Start the four selected reviews.', accountId: 'codex-main', permissionMode: 'full' }).thread.id;
  const session = (id: string) => h.codex.sessions.filter((s) => s.opts.threadId === id).at(-1)!;
  session(parent).init(undefined, 'gpt-6.1-sol');
  const sched = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC' });
  h.runner.schedulesFor = (id) => sched.list(id);
  sched.start();
  t.after(async () => { sched.stop(); await h.runner.shutdown(); });
  const tools = buildThreadbearTools(h.runner, parent, () => h.clock.now(), sched, undefined, undefined, {
    provider: 'codex', oneReply: () => true, plainCardNote: false, projectStepNote: false,
  });
  let seq = 0;
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const tool = tools.find((x) => x.name === name)!;
    assert.ok(tool, name);
    const s = session(parent);
    const itemId = `call-${++seq}`;
    s.out({ kind: 'event', event: { type: 'tool.call', itemId, name: `mcp__threadbear__${name}`, kind: 'mcp', title: name, input } });
    const r = await tool.handler(input as never, {}) as { content: { text: string }[]; isError?: boolean };
    const text = r.content.map((c) => c.text).join('\n');
    s.out({ kind: 'event', event: { type: 'tool.result', itemId, ok: !r.isError, text, truncated: false, images: [] } });
    return { text, error: Boolean(r.isError) };
  };
  const ok = async (name: string, input: Record<string, unknown> = {}) => {
    const r = await call(name, input);
    assert.equal(r.error, false, r.text);
    return r.text;
  };
  const end = async (input: Record<string, unknown>, reply = 'The reports will be collected here.') => {
    await ok('end_turn', input);
    session(parent).text(`reply-${++seq}`, reply);
    session(parent).result();
    await tick();
  };
  const finish = (id: string, reply: string, input: Record<string, unknown> = { needs: 'nothing' }) => {
    const s = session(id);
    s.out({ kind: 'event', event: { type: 'tool.call', itemId: `end-${++seq}`, name: END_TURN, kind: 'mcp', title: 'end_turn', input } });
    s.text(`reply-${++seq}`, reply);
    s.result();
  };
  const launch = async (count = 4) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const title = `Synthetic review ${i + 1}`;
      const text = await ok('create_thread', { title, text: 'Review only. Leave the full report here.', account: 'codex-main', effort: 'max', nested: false });
      const id = /^Started thread ([\w-]+) /.exec(text)?.[1];
      assert.ok(id, text);
      const thread = h.runner.get(id);
      assert.equal(thread.accountId, 'codex-main');
      assert.equal(thread.poolId, undefined);
      assert.equal(thread.effort, 'max');
      assert.equal(thread.detached, true);
      assert.equal(thread.startedBy?.threadId, parent);
      session(id).init(undefined, 'gpt-6.1-sol');
      ids.push(id);
    }
    return ids;
  };
  const book = async (ids: string[]) => {
    const deadline = new Date(h.clock.now() + TWO_HOURS).toISOString();
    const title = `Collect spare-week ${ids[0]}`;
    // A synthetic agent's self-contained fallback, in the shape the brief
    // requires. The scheduler, delivery, MCP validation and reads are real.
    const text = `Collect batch ${ids[0]} in parent ${parent} by ${deadline}.\n${ids.map((id) => `[${h.runner.get(id).title}](thread:${id})`).join('\n')}\nRead original full reports with read_thread; compare the parent's recorded outcomes. Never launch or retry jobs. Report partial results at the deadline, close this round and delete its check. No further timer or wait.`;
    await ok('schedule_message', { when: deadline, title, text, threadId: parent });
    const schedules = sched.list(parent);
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0]!.cron, undefined);
    assert.equal(schedules[0]!.threadId, parent);
    return { id: schedules[0]!.id, deadline, text };
  };
  const wakeMessages = () => h.events(parent).filter((e) => e.type === 'user.message' && e.origin === 'runner' && e.text.startsWith('The threads you hibernated'));
  return { h, parent, session, sched, call, ok, end, finish, launch, book, wakeMessages };
}

// Jobs start with nested: false, so they're detached and quiet inbox leaves
// them in the inbox when they finish (Mike's release 2026-11-27). Their
// reports must still read in full once someone archives them.
test('four detached pinned jobs finish out of order, stay in the inbox, and have full reports readable after one wake, archived or not', async (t) => {
  const r = setup(t);
  const ids = await r.launch();
  const fallback = await r.book(ids);
  await r.end({ needs: 'nothing', waitFor: ids, snooze: fallback.deadline });
  assert.equal(r.h.runner.get(r.parent).waitingOn?.length, 4, 'none silently dropped by the tool schema or parser');
  for (const i of [2, 0, 3, 1]) {
    r.finish(ids[i]!, 'Synthetic report. '.repeat(200) + `Important limitation ${i}: no runtime verification.`);
    if (i !== 1) assert.ok(r.h.runner.get(r.parent).waitingOn);
  }
  await patiently(() => r.wakeMessages().length > 0);
  assert.equal(r.wakeMessages().length, 1);
  assert.doesNotMatch(r.wakeMessages()[0]!.text, /Important limitation/);
  for (const id of ids) assert.equal(r.h.runner.get(id).archivedAt, undefined, 'a detached job stays in the inbox');
  for (const id of ids) r.h.runner.update({ threadId: id, archived: true });
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const before = r.h.runner.get(id).archivedAt;
    assert.ok(before);
    const report = await r.ok('read_thread', { threadId: id, messages: 20 });
    assert.ok(report.includes(id), 'full ID resolves even after archival');
    assert.match(report, /more characters\)/, 'read_thread is clipped too');
    assert.ok(!report.includes(`Important limitation ${i}`));
    // tb show's actual renderer, fed the original stored events, without
    // invoking a live CLI or connecting to the user's runner.
    const log = r.h.store.log(id);
    const full = formatThread(r.h.runner.get(id), log.read(1, log.lastSeq), { last: 1 });
    assert.ok(full.includes(`Important limitation ${i}`), 'tb show retains the full report');
    assert.equal(r.h.runner.get(id).archivedAt, before, 'reading does not reopen the job');
  }
  await r.ok('delete_schedule', { scheduleId: fallback.id });
  await r.end({ needs: 'nothing' }, ids.map((id) => `[Full report](thread:${id}): reviewed, with limitations.`).join('\n'));
  r.h.runner.reconcileWaits();
  r.h.clock.advance(TWO_HOURS * 2);
  await tick(8);
  assert.equal(r.wakeMessages().length, 1);
  assert.equal(r.sched.list(r.parent).length, 0);
  assert.equal(r.h.runner.list(['inbox', 'snoozed', 'archived']).length, 5, 'collection creates no jobs');
  assert.equal(r.h.events(r.parent).filter((e) => e.type === 'user.message' && e.scheduleId).length, 0);
});

test('mixed success, failure, stop and needs-user keep their states and reach the parent through one fallback', async (t) => {
  const r = setup(t);
  const ids = await r.launch();
  const fallback = await r.book(ids);
  await r.end({ needs: 'nothing', waitFor: ids, snooze: fallback.deadline });
  r.finish(ids[0]!, 'Review completed; changes were not made.');
  r.session(ids[1]!).result('failed', undefined, 'Synthetic provider failure');
  r.session(ids[2]!).result('interrupted');
  r.finish(ids[3]!, 'Needs a scope decision.', { needs: 'you', asks: [{ question: 'Which folder should be reviewed?' }] });
  await tick(8);
  assert.equal(r.wakeMessages().length, 0, 'blocked outcomes do not satisfy waitFor');
  r.h.clock.advance(TWO_HOURS);
  await tick(12);
  const messages = r.h.events(r.parent).filter((e) => e.type === 'user.message' && e.scheduleId === fallback.id);
  assert.equal(messages.length, 1);
  assert.ok(messages[0]!.text.includes(fallback.text));
  for (const id of ids) assert.ok((await r.ok('read_thread', { threadId: id })).includes(id));
  assert.equal(r.h.runner.get(ids[1]!).status, 'error');
  assert.equal(r.h.runner.get(ids[2]!).status, 'idle', 'an interrupted result can leave an idle thread');
  const stoppedLog = r.h.store.log(ids[2]!);
  assert.match(formatThread(r.h.runner.get(ids[2]!), stoppedLog.read(1, stoppedLog.lastSeq), { last: 1 }), /interrupted/);
  assert.equal(r.h.runner.get(ids[3]!).needs, 'you');
  for (const id of ids.slice(1)) assert.equal(r.h.runner.get(id).archivedAt, undefined);
  await r.ok('delete_schedule', { scheduleId: fallback.id });
  await r.end({ needs: 'nothing' }, 'Partial digest: one complete, one failed, one stopped, one needs a scope decision.');
  r.h.clock.advance(TWO_HOURS * 24);
  await tick(8);
  assert.equal(r.sched.list(r.parent).length, 0);
  assert.equal(r.h.runner.get(r.parent).waitingOn, undefined);
  assert.equal(r.h.events(r.parent).filter((e) => e.type === 'user.message' && e.scheduleId === fallback.id).length, 1);
});

test('archives before validation and during registration leave the fallback able to read both reports', async (t) => {
  const r = setup(t);
  const [a, b] = await r.launch(2) as [string, string];
  const fallback = await r.book([a, b]);
  // Detached jobs aren't archived by quiet inbox, so these archive as a
  // person would, the moment each finishes.
  r.finish(a, 'First report.');
  await patiently(() => r.h.runner.get(a).status === 'idle');
  r.h.runner.update({ threadId: a, archived: true });
  const refused = await r.call('end_turn', { needs: 'nothing', waitFor: [a, b], snooze: fallback.deadline });
  assert.equal(refused.error, true);
  assert.match(refused.text, /archived/);
  assert.match(await r.ok('read_thread', { threadId: a }), /First report/);
  await r.ok('end_turn', { needs: 'nothing', waitFor: [b], snooze: fallback.deadline });
  r.finish(b, 'Second report.');
  await patiently(() => r.h.runner.get(b).status === 'idle');
  r.h.runner.update({ threadId: b, archived: true });
  r.session(r.parent).text('waiting', 'The fallback will collect the reports.');
  r.session(r.parent).result();
  await tick();
  assert.equal(r.h.runner.get(r.parent).waitingOn, undefined, 'registration skipped the newly archived target');
  r.h.clock.advance(TWO_HOURS);
  await tick(12);
  assert.match(await r.ok('read_thread', { threadId: a }), /First report/);
  assert.match(await r.ok('read_thread', { threadId: b }), /Second report/);
  await r.ok('delete_schedule', { scheduleId: fallback.id });
  await r.end({ needs: 'nothing' }, 'Both reports collected.');
  assert.equal(r.sched.list(r.parent).length, 0);
});

test('an interrupted wait can be restored without moving its deadline or adding a schedule', async (t) => {
  const r = setup(t);
  const ids = await r.launch();
  const fallback = await r.book(ids);
  await r.end({ needs: 'nothing', waitFor: ids, snooze: fallback.deadline });
  r.h.clock.advance(60_000);
  r.h.runner.send(r.parent, 'How are the reviews going?');
  await tick();
  assert.equal(r.h.runner.get(r.parent).waitingOn, undefined);
  assert.ok((await r.ok('list_schedules')).includes(`Collect spare-week ${ids[0]}`));
  for (const id of ids) await r.ok('read_thread', { threadId: id });
  await r.end({ needs: 'nothing', waitFor: ids, snooze: fallback.deadline });
  assert.equal(r.h.runner.get(r.parent).snoozedUntil, fallback.deadline);
  assert.equal(r.sched.list(r.parent).length, 1);
  for (const id of ids) r.finish(id, 'Review done.');
  await tick();
  assert.equal(r.wakeMessages().length, 1);
  await r.ok('delete_schedule', { scheduleId: fallback.id });
  await r.end({ needs: 'nothing' }, 'All four reports collected.');
});

test('the deadline ends collection with pending jobs still running, without another timer or automatic round', async (t) => {
  const r = setup(t);
  const ids = await r.launch();
  const fallback = await r.book(ids);
  await r.end({ needs: 'nothing', waitFor: ids, snooze: fallback.deadline });
  r.finish(ids[0]!, 'First report ready.');
  r.h.clock.advance(TWO_HOURS);
  await tick(12);
  for (const id of ids) await r.ok('read_thread', { threadId: id });
  for (const id of ids.slice(1)) assert.equal(r.h.runner.get(id).status, 'running');
  await r.ok('delete_schedule', { scheduleId: fallback.id });
  await r.end({ needs: 'nothing' }, 'Partial digest: one report ready, three pending. Collection round closed.');
  for (const id of ids.slice(1)) r.finish(id, 'Later report.');
  r.h.clock.advance(TWO_HOURS * 24);
  await tick(12);
  assert.equal(r.wakeMessages().length, 0, 'closed collection is not silently resumed');
  assert.equal(r.h.runner.get(r.parent).waitingOn, undefined);
  assert.equal(r.sched.list(r.parent).length, 0);
});

test('deleting a fallback queued during collection drops the reminder and preserves the saved digest', async (t) => {
  const r = setup(t);
  const ids = await r.launch();
  const fallback = await r.book(ids);
  await r.end({ needs: 'nothing', waitFor: ids, snooze: fallback.deadline });
  for (const id of ids) r.finish(id, 'Review complete.');
  assert.equal(r.wakeMessages().length, 1);
  r.h.clock.advance(TWO_HOURS);
  await tick(12);
  assert.equal(r.h.runner.threads.get(r.parent)!.rec.queue.length, 1, 'fallback waits behind the collector turn');
  for (const id of ids) await r.ok('read_thread', { threadId: id });
  await r.ok('delete_schedule', { scheduleId: fallback.id });
  assert.equal(r.h.runner.threads.get(r.parent)!.rec.queue.length, 0);
  const digest = `Batch ${ids[0]} closed.\n${ids.map((id) => `[Full report](thread:${id}): reviewed.`).join('\n')}`;
  await r.end({ needs: 'nothing' }, digest);
  await tick(12);
  assert.equal(r.h.events(r.parent).filter((e) => e.type === 'user.message' && e.scheduleId === fallback.id).length, 0);
  r.h.runner.send(r.parent, 'Show the collected reports again.');
  await tick();
  const saved = await r.ok('read_thread', { threadId: r.parent, messages: 20 });
  assert.ok(saved.includes(digest), 'a redundant turn can preserve the digest rather than replace it with nothing new');
  r.h.runner.reconcileWaits();
  assert.equal(r.wakeMessages().length, 1);
  assert.equal(r.sched.list(r.parent).length, 0);
});

test('a delivered fallback clears the wait; completions arriving during collection do not add another wake', async (t) => {
  const r = setup(t);
  const ids = await r.launch();
  const fallback = await r.book(ids);
  await r.end({ needs: 'nothing', waitFor: ids, snooze: fallback.deadline });
  r.h.clock.advance(TWO_HOURS);
  await tick(12);
  assert.equal(r.h.runner.get(r.parent).waitingOn, undefined);
  assert.equal(r.h.events(r.parent).filter((e) => e.type === 'user.message' && e.scheduleId === fallback.id).length, 1);
  for (const id of ids) r.finish(id, 'Report ready as collection started.');
  for (const id of ids) assert.match(await r.ok('read_thread', { threadId: id }), /Report ready as collection started/);
  await r.ok('delete_schedule', { scheduleId: fallback.id });
  await r.end({ needs: 'nothing' }, 'All four outcomes collected in this round.');
  r.h.runner.reconcileWaits();
  assert.equal(r.wakeMessages().length, 0);
  assert.equal(r.sched.list(r.parent).length, 0);
});

test('explicitly stopping collection cancels its check without stopping the detached jobs', async (t) => {
  const r = setup(t);
  const ids = await r.launch();
  const fallback = await r.book(ids);
  await r.end({ needs: 'nothing', waitFor: ids, snooze: fallback.deadline });
  r.h.runner.send(r.parent, 'Stop collecting this batch. Leave the jobs running.');
  await tick();
  await r.ok('delete_schedule', { scheduleId: fallback.id });
  await r.end({ needs: 'nothing' }, 'Collection closed; the independent jobs are still running.');
  r.h.clock.advance(TWO_HOURS);
  await tick(12);
  assert.equal(r.sched.list(r.parent).length, 0);
  assert.equal(r.h.runner.get(r.parent).waitingOn, undefined);
  for (const id of ids) assert.equal(r.h.runner.get(id).status, 'running');
});
