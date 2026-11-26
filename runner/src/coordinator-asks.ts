import type { Ask, DesignReview } from './protocol.ts';
import { putsOff } from './needs.ts';
import { boardRecords, getTaskDetails, isTaskDone, workTaskView, type Coordinator } from './coordinator-desk.ts';

export type BoardRecord = ReturnType<typeof boardRecords>[number];

export const taskTitleKey = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

export function isUserDecision(record: BoardRecord): boolean {
  const work = getTaskDetails(record);
  return work.kind === 'decision' && work.owner.kind === 'user';
}

export function askMatches(row: Coordinator, ask: Ask): BoardRecord[] {
  const records = boardRecords(row);
  if (ask.taskId) return records.filter((record) => record.id === ask.taskId);
  const title = taskTitleKey(ask.action.slice(0, 240));
  return records.filter((r) => !isTaskDone(r) && isUserDecision(r) && (taskTitleKey(r.title) === title || taskTitleKey(r.asked?.action ?? '') === taskTitleKey(ask.action)));
}

export function askTask(row: Coordinator, ask: Ask): BoardRecord | undefined {
  const matches = askMatches(row, ask);
  return matches.length === 1 ? matches[0] : undefined;
}

export function decisionChoices(ask: Ask, row: Coordinator, record?: BoardRecord, review?: DesignReview) {
  const saved = record && workTaskView(record, row.threadId).decision;
  const fromAsk = (ask.options ?? []).flatMap((label, index) => {
    if (putsOff(label)) return [];
    const does = ask.optionNotes?.[index]?.trim() || saved?.options?.find((option) => option.label === label)?.does;
    return [{ label: label.trim(), ...(does ? { does } : {}) }];
  });
  const fromReview = review?.options.filter((option) => !option.reference).map((option) => ({ label: option.title.slice(0, 240), ...(option.note ? { does: option.note.slice(0, 1000) } : {}) }));
  const choices = fromAsk.length ? fromAsk : (saved?.options?.filter((option) => !putsOff(option.label)) ?? fromReview ?? []);
  const options = [...new Map(choices.filter((option) => option.label).map((option) => [option.label, option])).values()].slice(0, 4);
  const selected = ask.suggested === undefined ? undefined : ask.options?.[ask.suggested];
  const keepRecommendation = !fromAsk.length || options.some((option) => option.label === saved?.recommendation);
  const recommendation = selected && options.some((option) => option.label === selected)
    ? selected
    : (keepRecommendation ? saved?.recommendation : undefined) ?? review?.options.find((option) => option.id === review.recommended)?.title.slice(0, 240);
  return { options, recommendation };
}

export function decisionCard(ask: Ask, taskId: string, options: { label: string; does?: string }[], recommendation: string | undefined, hasReview: boolean): Ask {
  const labels = options.map((option) => option.label);
  const notes = options.map((option) => option.does ?? '');
  const suggested = labels.indexOf(recommendation ?? '');
  const defer = ask.options?.find(putsOff) ?? 'Not now';
  const { suggested: _suggested, optionNotes: _notes, ...base } = ask;
  // A visual review is answered in its review window.
  if (hasReview) return { ...base, taskId, options: [defer] };
  return {
    ...base, taskId, options: [...labels, defer],
    ...(notes.some(Boolean) ? { optionNotes: [...notes, ''] } : {}),
    ...(suggested >= 0 ? { suggested } : {}),
  };
}
