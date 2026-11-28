// Whether the done card says the thread can be archived, from the runner's
// loose-ends check (docs/protocol/threads.md, "Loose ends"). Worded as the
// Mac's card says it (desktop/gpui composer_card.rs, archive_advice), so the
// two read the same. The row's `looseEnds` is [] when the runner checked and
// found nothing, and absent when there's no check to go on.

export type LooseEnd = { kind: string; text: string; threadId?: string; at?: string };
export type ArchiveAdvice = { note?: string; label: string; suggested: boolean };

export function archiveAdvice(ends: LooseEnd[] | undefined, hasFollowUps: boolean): ArchiveAdvice {
  if (!ends) return { label: 'Archive', suggested: false };
  const open = ends.filter((e) => e.kind !== 'scheduled').length;
  if (open > 0) {
    const note = open === 1 ? '1 thing still open, so check it before you archive.' : `${open} things still open, so check them before you archive.`;
    return { note, label: 'Archive anyway', suggested: false };
  }
  const first = ends.length ? 'Nothing left to follow up, and it comes back for its check-in.' : 'Nothing left to follow up.';
  const then = hasFollowUps ? 'You can archive, or carry on with an idea below.' : 'You can archive this thread.';
  return { note: `${first} ${then}`, label: 'Archive', suggested: true };
}
