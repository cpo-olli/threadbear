import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRunner, effortTitle, efforts, keeps, models } from './new-thread-choices.ts';

const opus = { id: 'opus', title: 'Opus', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] };
const gpt = { id: 'gpt', title: 'GPT', effortLevels: ['low', 'medium', 'high', 'ultra'] };

test('models: Claude first, each once, only the runner’s own logins', () => {
  const accounts = [
    { runnerId: 'a', provider: 'codex', models: [gpt] },
    { runnerId: 'a', provider: 'claude', models: [opus] },
    { runnerId: 'a', provider: 'claude', models: [opus] },
    { runnerId: 'b', provider: 'claude', models: [{ id: 'other', title: 'Other' }] },
  ];
  assert.deepEqual(models(accounts, 'a').map((m) => m.id), ['opus', 'gpt']);
  assert.deepEqual(models(accounts, 'b').map((m) => m.id), ['other']);
  assert.deepEqual(models(accounts).map((m) => m.id), ['opus', 'other', 'gpt']);
});

test('models: an account from before API 20 has none, not a broken list', () => {
  assert.deepEqual(models([{ runnerId: 'a', provider: 'claude' }], 'a'), []);
});

test('efforts follow the model, Claude’s levels with none picked', () => {
  assert.deepEqual(efforts(gpt), ['low', 'medium', 'high', 'ultra']);
  assert.deepEqual(efforts(undefined), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(keeps('ultra', opus), false);
  assert.equal(keeps('high', opus), true);
  assert.equal(keeps('', opus), true);
  assert.equal(effortTitle('xhigh'), 'Extra high');
});

test('defaultRunner: first placed online, else the main one', () => {
  const rs = [
    { runnerId: 'x', placed: true },
    { runnerId: 'y', placed: true },
    { runnerId: 'm', main: true },
  ];
  assert.equal(defaultRunner(rs, (r) => r.runnerId === 'y')?.runnerId, 'y');
  assert.equal(defaultRunner(rs, () => false)?.runnerId, 'm');
});
