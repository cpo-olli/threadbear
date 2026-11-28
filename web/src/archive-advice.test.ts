// The done card's line about archiving, worded as the Mac's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveAdvice } from './archive-advice.ts';

test('a clear check says the thread can be archived', () => {
  assert.deepEqual(archiveAdvice([], false), { note: 'Nothing left to follow up. You can archive this thread.', label: 'Archive', suggested: true });
  assert.equal(archiveAdvice([], true).note, 'Nothing left to follow up. You can archive, or carry on with an idea below.');
});

test('a booked check-in alone still leaves it safe to archive', () => {
  const advice = archiveAdvice([{ kind: 'scheduled', text: 'Review the week' }], false);
  assert.equal(advice.suggested, true);
  assert.equal(advice.note, 'Nothing left to follow up, and it comes back for its check-in. You can archive this thread.');
});

test('something open turns Archive into Archive anyway', () => {
  const one = archiveAdvice([{ kind: 'unpushed', text: "2 commits aren't pushed" }, { kind: 'scheduled', text: 'Review the week' }], false);
  assert.deepEqual(one, { note: '1 thing still open, so check it before you archive.', label: 'Archive anyway', suggested: false });
  const two = archiveAdvice([{ kind: 'unpushed', text: 'a' }, { kind: 'running', text: 'b' }], true);
  assert.equal(two.note, '2 things still open, so check them before you archive.');
});

test('with no check it stays a plain Done', () => {
  assert.deepEqual(archiveAdvice(undefined, true), { label: 'Archive', suggested: false });
});
