// A model's and an effort level's names, as a thread's chips show them.
// Split out of runner.ts (24 Nov 2026) so its parts under runner/ can use them
// without importing runner.ts back (mikecann-lint's no-import-cycle).
import type { Account, EffortLevel, ModelChoice, Provider } from '../protocol.ts';
import { stripModelSuffix } from '../accounts.ts';

// Claude's own ids: its aliases, and anything starting claude- (with or
// without a [1m] suffix).
export function isClaudeModel(id: string): boolean {
  const bare = stripModelSuffix(id).toLowerCase();
  return ['opus', 'sonnet', 'haiku', 'default', 'opusplan'].includes(bare) || bare.startsWith('claude-');
}

export function nativeModelProvider(id: string): Provider | undefined {
  if (isClaudeModel(id)) return 'claude';
  if (id.startsWith('gpt-')) return 'codex';
  return undefined;
}

// The account's row for a model id, matched by picker id or full id.
export function modelRow(account: Account, model: string | undefined): ModelChoice | undefined {
  if (!model) return undefined;
  return pickerModelRow(account, model) ?? account.models?.find((m) => m.model === model);
}

export function pickerModelRow(account: Account, model: string): ModelChoice | undefined {
  return account.models?.find((m) => m.id === model);
}

// The pickers send the id, which can also be another row's resolved model.
export function modelAccounts(accounts: Account[], model: string): Account[] {
  const exact = accounts.filter((a) => pickerModelRow(a, model));
  return exact.length ? exact : accounts.filter((a) => modelRow(a, model));
}

export function modelTitle(account: Account, model: string): string {
  return modelRow(account, model)?.title ?? model;
}

const EFFORT_TITLES: Record<EffortLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };

export function effortTitle(e: EffortLevel): string {
  return EFFORT_TITLES[e] ?? e;
}
