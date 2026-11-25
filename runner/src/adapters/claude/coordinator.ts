// The main coordinator reads and orchestrates; only its native helpers do
// the implementation. PreToolUse enforces this even in bypassPermissions.
// Keep it separate from ordinary permission policy: a coordinator's Full
// access is not permission to become its own worker.
export const COORDINATOR_WORKER = 'coordinator-worker';

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
const CONTROL_TOOLS = new Set(['Agent', 'Task', 'TaskOutput', 'TaskStop', 'AskUserQuestion']);
const PROJECT_READS = new Set(['list_projects', 'read_project', 'list_threads', 'read_thread', 'list_schedules', 'list_accounts']);
const COORDINATOR_TOOLS = new Set(['update_project', 'send_message', 'end_turn', 'ask_secret', 'pin', 'unpin', 'show_options', 'show_panel', 'coordinator']);

export const HELPER_REPORT = 'Report this question or blocked operation to the coordinator in your result and stop this job. The coordinator will answer from its instructions or ask the user, then resume you. Do not open a user card or try another way to get approval.';

export const COORDINATOR_WORKER_PROMPT = `You are an unattended helper for a Threadbear project coordinator. Nobody answers you directly.
Do the bounded job in the coordinator's brief and report the result to the coordinator. Use the repository's worktree workflow before editing; never edit its shared main checkout. Keep checkpoints and the paths, branch and verification needed to resume safely.
If information or permission is missing, report the question or blocked operation in your final result and stop. The coordinator handles it and may resume you with an answer. Never assume approval or repeat an uncertain side effect.
Do not call end_turn, ask_secret, user question tools, start another agent or create a Threadbear thread. Your final report goes to the coordinator. Do not ask the user to visit this helper.`;

function threadbearTool(name: string): string | undefined {
  return name.startsWith('mcp__threadbear__') ? name.slice('mcp__threadbear__'.length) : undefined;
}

// Returns a refusal, or the sanitized dispatch input when it is an Agent
// call. The separate host check authorizes a live helper/run and pause.
export function coordinatorTool(name: string, input: Record<string, unknown>, helper: boolean): { reason?: string; updatedInput?: Record<string, unknown> } {
  const tb = threadbearTool(name);
  if (helper) {
    if (name === 'Agent' || name === 'Task' || name === 'AskUserQuestion' || name === 'EnterPlanMode' || name === 'ExitPlanMode' || /(?:^|__)request_user_input(?:_async)?$/.test(name) || (tb !== undefined && !PROJECT_READS.has(tb))) return { reason: HELPER_REPORT };
    return {};
  }
  if (name === 'Agent' || name === 'Task') {
    // The SDK definition inherits the parent's actual mode/model. Tool
    // input must not select a different definition or widen that mode.
    const { mode: _mode, permissionMode: _permission, model: _model, tools: _tools, allowedTools: _allowed, disallowedTools: _denied, ...rest } = input;
    return { updatedInput: { ...rest, subagent_type: COORDINATOR_WORKER } };
  }
  if (READ_TOOLS.has(name) || CONTROL_TOOLS.has(name) || (tb !== undefined && (PROJECT_READS.has(tb) || COORDINATOR_TOOLS.has(tb)))) return {};
  return { reason: 'The project coordinator can read and orchestrate. Delegate implementation to a coordinator-worker helper; this tool is not available to the coordinator.' };
}
