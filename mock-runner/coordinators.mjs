// Opt-in project-home examples; the ordinary mock fixtures stay unchanged.
export function coordinatorDemo({ threads, projects, broadcast, projectChanged, threadChanged, accountFor, error }) {
  const coordinators = [];
  const now = () => new Date().toISOString();
  const publish = () => broadcast('coordinators.updated', { coordinators });
  const project = (id) => projects.find((p) => p.id === id);
  const make = (p, selection = {}) => {
    const ts = now();
    const id = `coordinator_${p.id}`;
    const events = [
      { type: 'user.message', text: `Keep ${p.title} moving. Bring me the decisions that need me and keep the project notes current.`, images: [] },
      { type: 'turn.started' },
      { type: 'assistant.text', itemId: 'coordinator_reply', text: 'The project home is taking shape. Two helpers are working on the conversation layout and keeping project notes in sync.\n\nI will bring their results together here. You can follow the current work in Highlights, or read the details in Activity.' },
      { type: 'turn.completed', outcome: 'completed', needs: 'nothing', durationMs: 1200 },
    ].map((e, i) => ({ ...e, seq: i + 1, ts, threadId: id, turnId: 'coordinator_first' }));
    const summary = {
      id, title: p.title, cwd: p.folders[0], accountId: accountFor(selection), poolId: selection.poolId, model: selection.model, effort: selection.effort, provider: 'claude', permissionMode: 'full',
      status: 'idle', needsYou: false, createdAt: ts, updatedAt: ts, lastActivityAt: ts,
      preview: 'Two helpers are working on the project home.', lastSeq: events.length, lastSeenSeq: events.length,
      projects: [{ id: p.id, title: p.title, by: 'mike', pinned: true }],
      subagents: [
        { id: 'helper_layout', description: 'Build the project conversation layout', status: 'running', startedAt: ts },
        { id: 'helper_notes', description: 'Keep the project notes in sync', status: 'running', startedAt: ts },
      ],
    };
    const subagentEvents = new Map(summary.subagents.map((helper) => [helper.id, [
      { type: 'user.message', text: helper.description, images: [] },
      { type: 'assistant.text', itemId: `${helper.id}_reply`, text: 'The shared project fields are the source of truth. I am checking the project home against the approved layout.' },
    ].map((event, i) => ({ ...event, seq: i + 1, ts, turnId: helper.id }))]));
    threads.set(id, { summary, events, subagentEvents, inProgress: new Map(), timers: [] });
    const coordinator = {
      projectId: p.id, threadId: id, state: 'active', charter: 'Keep the project moving and bring decisions to Mike.', interests: [], updatedAt: ts,
      tasks: [
        { id: 'layout', state: 'working', title: 'Build the project home', doneWhen: 'The conversation and project document match the approved layout.', run: { agentId: 'helper_layout', status: 'running' } },
        { id: 'notes', state: 'working', title: 'Keep project notes in sync', doneWhen: 'Edits from the coordinator and project page share the same document.', run: { agentId: 'helper_notes', status: 'running' } },
        { id: 'research', state: 'done', title: 'Compare the Prints document model', doneWhen: 'The focused document approach is included in the design.', run: { status: 'completed', summary: 'The project document uses the existing shared goals, state and notes.' } },
      ],
    };
    coordinators.push(coordinator);
    return coordinator;
  };
  const initial = projects.find((p) => p.title === 'Threadbear');
  if (initial) {
    initial.goals = 'Make Threadbear a place to talk to a project, follow its work and make the decisions that need you.';
    initial.state = 'The coordinator experiment is being built. Two helpers are working on the project home and shared notes. The approved design keeps the conversation beside a living project document.';
    initial.notes = '## Decisions\n\n- Use the same pools and model picker as ordinary threads.\n- Routine work stays in helpers, outside the inbox.\n- Keep questions with the coordinator.\n- Project goals, state and notes are shared with the project page.';
    make(initial);
  }
  return (method, p) => {
    if (method === 'coordinators.list') return { coordinators };
    const target = project(p.projectId ?? initial?.id);
    if (!target) throw error(-32602, 'Project not found.');
    let coordinator = coordinators.find((c) => c.projectId === target.id);
    if (method === 'coordinators.get') return { coordinator: coordinator ?? null };
    if (method === 'coordinators.start') {
      if (!coordinator) coordinator = make(target, p);
      publish();
      threadChanged(coordinator.threadId);
      return { coordinator, thread: threads.get(coordinator.threadId).summary };
    }
    if (!coordinator) throw error(-32602, 'This project has no coordinator.');
    if (method === 'coordinators.pause') {
      coordinator.state = p.paused ? 'paused' : 'active';
      for (const task of coordinator.tasks) {
        if (p.paused && task.run?.status === 'running') { task.run.status = 'interrupted'; task.state = 'blocked'; }
      }
      if (p.paused) for (const helper of threads.get(coordinator.threadId).summary.subagents) {
        if (helper.status === 'running') helper.status = 'stopped';
      }
      threadChanged(coordinator.threadId);
    } else if (method === 'coordinators.addTask') {
      if (!p.title?.trim() || !p.doneWhen?.trim()) throw error(-32602, 'Add a title and what finished looks like.');
      coordinator.tasks.push({ id: `todo_${coordinator.tasks.length}`, state: 'todo', title: p.title, doneWhen: p.doneWhen });
    } else if (method === 'coordinators.update') {
      if (p.charter !== undefined) coordinator.charter = p.charter;
      if (p.interests !== undefined) coordinator.interests = p.interests;
    } else if (method === 'mock.coordinatorFinish') {
      coordinator.tasks[0].run.status = 'completed';
      coordinator.tasks[0].state = 'review';
      const helper = threads.get(coordinator.threadId).summary.subagents[0];
      helper.status = 'completed';
      helper.summary = 'The conversation and living document match the approved layout.';
      threadChanged(coordinator.threadId);
      target.state = 'The project home helper has returned. The coordinator is checking its result before marking the work done.';
      target.stateUpdatedAt = now();
      projectChanged();
    } else if (method === 'mock.coordinatorVerify') {
      coordinator.tasks[0].state = 'done';
      target.state = 'The project home is ready. The coordinator checked the helper result and the conversation and living document use the same project state.';
      target.stateUpdatedAt = now();
      projectChanged();
    } else throw error(-32601, 'Unknown coordinator method.');
    coordinator.updatedAt = now();
    publish();
    return { coordinator };
  };
}
