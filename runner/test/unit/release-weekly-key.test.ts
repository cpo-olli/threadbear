// Releases signed by a weekly key the release key certified
// (release-keys.ts, "Releases signed by a weekly key"; release-delegate.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FakeClock } from '../../src/clock.ts';
import { applyKeyChanges, certVerifyArgs, keyStatePath, readRevoked, readWeeklyRevoked, revokedPath, signatureCert, signerKey, weeklyRevokedPath, withAuthorities } from '../../src/release-keys.ts';
import { currentCert, delegatePaths, readDelegateState, renewDelegate, usableCert } from '../../src/release-delegate.ts';
import { SETTLE_MS, gitAsync, type GitOptions } from '../../src/upstream.ts';
import { GIT_ENV, commit, git, key, pubOf, release, upstreamFor, world } from '../helpers/upstream-harness.ts';

type World = ReturnType<typeof world>;

// A weekly key certified by `ca` for Mike's principal, valid as `-V` says.
function weekly(w: World, name: string, validity: string, ca = w.mikeKey.priv): { priv: string; cert: string; pub: string } {
  const priv = path.join(w.root, name);
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', priv]).status, 0);
  const r = spawnSync('ssh-keygen', ['-q', '-s', ca, '-I', name, '-n', 'mike@example.com', '-V', validity, `${priv}.pub`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { priv, cert: `${priv}-cert.pub`, pub: fs.readFileSync(`${priv}.pub`, 'utf8').split(' ').slice(0, 2).join(' ') };
}

const armorOf = (tag: string) => tag.slice(tag.indexOf('-----BEGIN SSH SIGNATURE-----')) + '\n';

// A release tag signed with a weekly key's certificate, dated `date`.
function certTag(repo: string, tag: string, cert: string, date: string): void {
  const r = spawnSync('git', ['-C', repo, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${cert}`, 'tag', '-s', '-m', `Threadbear ${tag}`, tag], { encoding: 'utf8', env: { ...GIT_ENV, GIT_COMMITTER_DATE: date, SSH_AUTH_SOCK: '' } });
  assert.equal(r.status, 0, r.stderr);
}

test('a fork takes a release signed by a weekly key its pinned key certified', async () => {
  const w = world();
  const k = weekly(w, 'week', '20261029Z:20261106Z');
  const tip = commit(w.mike, 'b.txt', 'Work');
  certTag(w.mike, 'release/2026-10-30', k.cert, '2026-10-30T10:00:00Z');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const s = await upstreamFor(w.theirs, w.home).check();
  assert.equal(s.release?.tag, 'release/2026-10-30', s.reason ?? '');
  assert.equal(s.release?.commit, tip);
  // The release counts as the pinned key's, for the key rules.
  const sig = armorOf(git(w.mike, 'cat-file', 'tag', 'release/2026-10-30'));
  assert.equal(signerKey(sig), pubOf(w.mikeKey));
  assert.equal(signatureCert(sig)?.key, k.pub);
});

test("not when the tag's date is outside the certificate, or not the day its name says", async () => {
  const w = world();
  const k = weekly(w, 'week', '20261029Z:20261106Z');
  commit(w.mike, 'b.txt', 'After it ran out');
  certTag(w.mike, 'release/2026-11-20', k.cert, '2026-11-20T10:00:00Z');
  commit(w.mike, 'c.txt', 'Backdated, under a newer name');
  certTag(w.mike, 'release/2026-11-21', k.cert, '2026-11-01T10:00:00Z');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const s = await upstreamFor(w.theirs, w.home).check();
  assert.equal(s.release?.tag, 'release/2026-10-01');
  assert.equal(certVerifyArgs('release/2026-11-21', '2026-11-01T10:00:00Z'), undefined);
  assert.ok(certVerifyArgs('release/2026-11-21', '2026-11-20T23:00:00Z'), 'UTC+14 is already on the 21st');
  assert.ok(certVerifyArgs('release/2026-11-21', '2026-11-22T11:00:00Z'), 'UTC-12 is still on the 21st');
  assert.equal(certVerifyArgs('release/2026-11-21', '2026-11-22T13:00:00Z'), undefined);
});

test("not a certificate from a key that isn't pinned, nor a weekly key that's been revoked", async () => {
  const w = world();
  const stranger = key(w.root, 'stranger');
  const theirs = weekly(w, 'strangers-week', '20261029Z:20261106Z', stranger.priv);
  commit(w.mike, 'b.txt', 'Certified by a stranger');
  certTag(w.mike, 'release/2026-10-30', theirs.cert, '2026-10-30T10:00:00Z');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  assert.equal((await upstreamFor(w.theirs, w.home).check()).release?.tag, 'release/2026-10-01');

  const leaked = weekly(w, 'leaked', '20261029Z:20261106Z');
  commit(w.mike, 'c.txt', 'Signed by a leaked weekly key');
  certTag(w.mike, 'release/2026-10-31', leaked.cert, '2026-10-31T10:00:00Z');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  assert.equal((await upstreamFor(w.theirs, w.home).check()).release?.tag, 'release/2026-10-31', 'taken until it is revoked');
  fs.writeFileSync(revokedPath(w.home), `${leaked.pub}\n`);
  assert.equal((await upstreamFor(w.theirs, w.home).check()).release?.tag, 'release/2026-10-01');
});

test('withAuthorities: each pinned key also counts as an authority, for git only', () => {
  const line = 'threadbear-releases namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample';
  assert.equal(withAuthorities(`${line}\n`), `${line}\nthreadbear-releases cert-authority,namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n`);
  assert.equal(withAuthorities('# a comment\n'), '# a comment\n');
});

// Mike's side: the release before has the check that takes the weekly key,
// and his weekly key is in place.
function readyToDelegate(w: World, validity = '-1d:+8d') {
  release(w, 'release/2026-10-02', w.mikeKey.priv, { 'runner/src/release-keys.ts': '// cert-authority\n' });
  const k = weekly(w, 'week', validity);
  const p = delegatePaths(w.home);
  fs.mkdirSync(path.dirname(p.key), { recursive: true });
  fs.copyFileSync(k.priv, p.key);
  fs.copyFileSync(`${k.priv}.pub`, `${p.key}.pub`);
  fs.copyFileSync(k.cert, p.cert);
  return k;
}

test("Mike's runner signs with the weekly key, and a fork takes it", async () => {
  const w = world();
  readyToDelegate(w);
  commit(w.mike, 'b.txt', 'Newer work');
  git(w.mike, 'push', '-q', 'origin', 'main');
  // The real time, as forks refuse a weekly key's tag dated ahead of theirs.
  const clock = new FakeClock(Date.now());
  const signs: string[][] = [];
  const up = upstreamFor(w.mike, w.home, clock, {
    publish: { publish: true, signingKey: w.mikeKey.priv, delegate: true },
    runningMainSettled: () => true,
    git: (cwd: string, args: string[], opts: GitOptions = {}) => {
      if (args.includes('-s') && args.includes('tag')) signs.push(args);
      return gitAsync(cwd, args, opts);
    },
  });
  const tag = await up.publishOnce({ now: true });
  assert.ok(tag, up.status().held?.why ?? 'no tag');
  assert.ok(signs[0]!.includes(`user.signingkey=${delegatePaths(w.home).cert}`));
  assert.ok(signatureCert(armorOf(git(w.mike, 'cat-file', 'tag', tag))));
  assert.equal((await upstreamFor(w.theirs, w.home, clock).check()).release?.tag, tag);
});

test("the release key signs instead until forks have the check, or when the weekly key's run out", async () => {
  for (const how of ['no check yet', 'ran out'] as const) {
    const w = world();
    if (how === 'ran out') readyToDelegate(w, '-10d:-1d');
    else {
      const k = weekly(w, 'week', '-1d:+8d');
      fs.mkdirSync(path.dirname(delegatePaths(w.home).key), { recursive: true });
      fs.copyFileSync(k.priv, delegatePaths(w.home).key);
      fs.copyFileSync(`${k.priv}.pub`, `${delegatePaths(w.home).key}.pub`);
      fs.copyFileSync(k.cert, delegatePaths(w.home).cert);
    }
    commit(w.mike, 'b.txt', 'Newer work');
    git(w.mike, 'push', '-q', 'origin', 'main');
    const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
    const up = upstreamFor(w.mike, w.home, new FakeClock(committed + 2 * SETTLE_MS), { publish: { publish: true, signingKey: w.mikeKey.priv, delegate: true }, runningMainSettled: () => true });
    const tag = await up.publishOnce();
    assert.ok(tag, how);
    assert.equal(signatureCert(armorOf(git(w.mike, 'cat-file', 'tag', tag))), undefined, how);
  }
});

test('renewDelegate makes a key the release key certifies, checked before it goes in place', async () => {
  const w = world();
  const signers = fs.readFileSync(w.mikeKey.signers, 'utf8');
  const now = Date.now();
  const c = await renewDelegate({ home: w.home, signingKey: w.mikeKey.priv, signers, now, timeoutMs: 30_000 });
  assert.equal(c.ca, pubOf(w.mikeKey));
  assert.deepEqual(c.principals, ['mike@example.com']);
  assert.ok(c.validBefore - now > 7.9 * 24 * 60 * 60_000 && c.validBefore - now <= 8 * 24 * 60 * 60_000 + 60_000);
  assert.deepEqual(currentCert(w.home), c);
  assert.equal(fs.statSync(delegatePaths(w.home).key).mode & 0o077, 0, 'the key is private');

  // A key that isn't in release-signers isn't certified.
  const stranger = key(w.root, 'stranger');
  await assert.rejects(renewDelegate({ home: w.home, signingKey: stranger.priv, signers, now, timeoutMs: 30_000 }), /not in release-signers/);
  assert.deepEqual(currentCert(w.home), c, 'the one in place stays');
});

test('a weekly key near its end that Touch ID never renewed starts one starred reminder', async () => {
  const w = world();
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  // A Secure Enclave key's handle, which can't really sign here.
  const handle = path.join(w.root, 'id_ecdsa_sk_rk');
  fs.writeFileSync(handle, 'handle\n');
  fs.writeFileSync(`${handle}.pub`, 'sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNh threadbear-release\n');
  const started: { title: string; text: string }[] = [];
  let open = true;
  let atMacAsked = 0;
  const up = upstreamFor(w.mike, w.home, new FakeClock(committed), {
    publish: { publish: true, signingKey: handle, delegate: true },
    runningMainSettled: () => false,
    atMac: async () => (atMacAsked++, false),
    remind: (r: { title: string; text: string }) => (started.push(r), `t${started.length}`),
    isOpen: () => open,
  });
  await up.publishOnce();
  assert.equal(started.length, 1);
  assert.match(started[0]!.title, /Renew the release signing key/);
  assert.match(started[0]!.text, /tb updates publish/);
  assert.equal(readDelegateState(w.home).remindThread, 't1');
  assert.equal(atMacAsked, 1, 'renewing waits for Mike at the Mac');
  await up.publishOnce();
  assert.equal(started.length, 1, 'not again while that thread is open');
  open = false;
  await up.publishOnce();
  assert.equal(started.length, 2, 'again once he archived it unrenewed');
});

test("not a certificate for a kind of key the check can't read the dates of", async () => {
  const w = world();
  const priv = path.join(w.root, 'ecdsa-week');
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ecdsa', '-N', '', '-f', priv]).status, 0);
  assert.equal(spawnSync('ssh-keygen', ['-q', '-s', w.mikeKey.priv, '-I', 'e', '-n', 'mike@example.com', '-V', '-1d:+8d', `${priv}.pub`]).status, 0);
  commit(w.mike, 'b.txt', 'An ecdsa weekly key');
  certTag(w.mike, 'release/2026-10-30', `${priv}-cert.pub`, '2026-10-30T10:00:00Z');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  assert.equal((await upstreamFor(w.theirs, w.home).check()).release?.tag, 'release/2026-10-01');
});

// Gemini's and Codex's reviews, 25 Nov 2026.
test('certVerifyArgs: only a real day, and never ahead of now', () => {
  const now = Date.parse('2026-12-30T00:00:00Z');
  assert.equal(certVerifyArgs('release/2027-00-05', '2026-12-05T12:00:00Z', now), undefined, 'month 00 is not December');
  assert.equal(certVerifyArgs('release/2026-12-00', '2026-11-29T10:30:00Z', now), undefined, 'day 00 is not 30 Nov');
  assert.equal(certVerifyArgs('release/2026-02-30', '2026-03-02T00:00:00Z', now), undefined);
  assert.ok(certVerifyArgs('release/2026-12-29', '2026-12-29T09:00:00Z', now));
  assert.equal(certVerifyArgs('release/2027-01-01', '2027-01-01T00:00:00Z', now), undefined, 'dated two days ahead');
});

test("a weekly key's release can only revoke weekly keys, never announce or revoke a pinned one", () => {
  const w = world();
  const signers = path.join(w.root, 'pinned');
  fs.copyFileSync(w.mikeKey.signers, signers);
  const mike = pubOf(w.mikeKey);
  const attacker = key(w.root, 'attacker');
  const otherWeek = weekly(w, 'other-week', '-1d:+8d');
  const r = applyKeyChanges({ home: w.home, signers, signer: mike, announced: [mike, pubOf(attacker)], revoke: [mike, otherWeek.pub], tag: 't', now: 0, viaCert: true });
  assert.deepEqual(r.revoked, [otherWeek.pub]);
  assert.deepEqual(readRevoked(w.home), [], 'the pinned key stands');
  assert.deepEqual(readWeeklyRevoked(w.home), [otherWeek.pub]);
  assert.ok(fs.readFileSync(signers, 'utf8').includes(mike));
  assert.equal(fs.existsSync(keyStatePath(w.home)) ? fs.readFileSync(keyStatePath(w.home), 'utf8').includes('attacker') : false, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(keyStatePath(w.home), 'utf8')).pending, [], 'nothing announced');

  // The release key's own release revoking a key it doesn't know puts it
  // with the weekly keys only, so it can still be pinned if announced.
  const future = key(w.root, 'future');
  applyKeyChanges({ home: w.home, signers, signer: mike, announced: [], revoke: [pubOf(future)], tag: 't2', now: 0 });
  assert.deepEqual(readRevoked(w.home), []);
  assert.ok(readWeeklyRevoked(w.home).includes(pubOf(future)));
  applyKeyChanges({ home: w.home, signers, signer: mike, announced: [pubOf(future)], revoke: [], tag: 't3', now: 0 });
  assert.equal(JSON.parse(fs.readFileSync(keyStatePath(w.home), 'utf8')).pending.length, 1, 'it can still be announced');
  assert.ok(fs.existsSync(weeklyRevokedPath(w.home)));
});

test("Mike's runner doesn't sign with a weekly key that's revoked, isn't the key's, or for a release that changes keys", async () => {
  for (const how of ['revoked', 'mismatched', 'key change'] as const) {
    const w = world();
    const k = readyToDelegate(w);
    if (how === 'revoked') {
      fs.writeFileSync(path.join(w.mike, 'scripts', 'release-keys-revoked'), `${k.pub}\n`);
      git(w.mike, 'add', 'scripts/release-keys-revoked');
      git(w.mike, 'commit', '-q', '-m', 'Revoke the weekly key');
    } else if (how === 'mismatched') {
      const other = weekly(w, 'other', '-1d:+8d');
      fs.copyFileSync(other.priv, delegatePaths(w.home).key);
      fs.copyFileSync(`${other.priv}.pub`, `${delegatePaths(w.home).key}.pub`);
      assert.equal(usableCert(w.home, w.mikeKey.priv, ''), undefined);
    } else {
      const next = key(w.root, 'next');
      fs.appendFileSync(path.join(w.mike, 'scripts', 'release-signers'), fs.readFileSync(next.signers, 'utf8'));
      git(w.mike, 'add', 'scripts/release-signers');
      git(w.mike, 'commit', '-q', '-m', 'Announce a new key');
    }
    commit(w.mike, 'b.txt', 'Newer work');
    git(w.mike, 'push', '-q', 'origin', 'main');
    const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
    const up = upstreamFor(w.mike, w.home, new FakeClock(committed + 2 * SETTLE_MS), { publish: { publish: true, signingKey: w.mikeKey.priv, delegate: true }, runningMainSettled: () => true });
    const tag = await up.publishOnce();
    assert.ok(tag, `${how}: ${up.status().held?.why ?? ''}`);
    assert.equal(signatureCert(armorOf(git(w.mike, 'cat-file', 'tag', tag))), undefined, how);
  }
});
