// Releases signed by a weekly key the release key certified
// (release-keys.ts, "Releases signed by a weekly key"; release-delegate.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FakeClock } from '../../src/clock.ts';
import { certVerifyArgs, revokedPath, signatureCert, signerKey, withAuthorities } from '../../src/release-keys.ts';
import { currentCert, delegatePaths, readDelegateState, renewDelegate } from '../../src/release-delegate.ts';
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
  fs.copyFileSync(k.cert, p.cert);
  return k;
}

test("Mike's runner signs with the weekly key, and a fork takes it", async () => {
  const w = world();
  readyToDelegate(w);
  commit(w.mike, 'b.txt', 'Newer work');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  const clock = new FakeClock(committed + 2 * SETTLE_MS);
  const signs: string[][] = [];
  const up = upstreamFor(w.mike, w.home, clock, {
    publish: { publish: true, signingKey: w.mikeKey.priv, delegate: true },
    runningMainSettled: () => true,
    git: (cwd: string, args: string[], opts: GitOptions = {}) => {
      if (args.includes('-s') && args.includes('tag')) signs.push(args);
      return gitAsync(cwd, args, opts);
    },
  });
  const tag = await up.publishOnce();
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
