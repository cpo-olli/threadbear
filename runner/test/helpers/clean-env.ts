// Loaded before every unit test file (`--import`, in package.json's test
// script and deploy-steps.mjs's rerun). Setup and deploys are often started
// from inside a Claude Code session, whose CLAUDECODE, CLAUDE_* and
// ANTHROPIC_* variables the tests would otherwise inherit: the desktop app's
// CLAUDE_CODE_TERMINAL_MCP_TOOLS failed the adapter's end_turn test and
// stopped setup (David, 8 Nov 2026). The installed runner, a LaunchAgent,
// never has them, so the tests run as it does: without them. They go back
// as they were when the test process exits.
const SESSION_VAR = /^(CLAUDECODE$|CLAUDE_|ANTHROPIC_)/;

const saved: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (value === undefined || !SESSION_VAR.test(name)) continue;
  saved[name] = value;
  delete process.env[name];
}

// A thread's own key (THREADBEAR_THREAD_KEY, docs/protocol.md) is the live
// runner's: a tb a test spawns would offer it to the test's runner, which
// refuses it, once check.sh has unset THREADBEAR_RUNNER_HOME (tb-connect.ts
// then takes the test's data dir for the thread's). tb land from a thread
// failed two tb tests that way (11 Nov). Like the others, it goes back on exit.
for (const name of ['THREADBEAR_THREAD_KEY']) {
  const value = process.env[name];
  if (value === undefined) continue;
  saved[name] = value;
  delete process.env[name];
}

process.on('exit', () => {
  for (const [name, value] of Object.entries(saved)) process.env[name] = value;
});
