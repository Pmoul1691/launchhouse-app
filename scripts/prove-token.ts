/**
 * scripts/prove-token.ts
 *
 * WHAT THIS IS. The bearer token seam, proved end to end against a real
 * Postgres, a real server process and a real socket.
 * `npm run prove:token`.
 *
 * WHY IT EXISTS. Everything between a founder's token and their files is
 * written and every test of it is green, and not one of those tests has touched
 * a database. The table, the hash, the bearer path in the door and the prefix
 * have only ever run against Maps in one process. scripts/prove-init.ts makes
 * this argument better than this header can: a fake that models something which
 * does not exist cannot catch a mismatch with the thing that does.
 *
 * So this uses no fake for the part that has never run. It applies the real
 * migration, spawns the real server, mints through the real mint script, and
 * drives it all over real HTTP. Two kinds of case, in the idiom prove-init.ts
 * set:
 *
 *   PASS   the token is accepted where it should be, and the row moves.
 *   PLANT  the token is refused everywhere it should be. A guard that has never
 *          been seen to fail is not known to work, and five of the six things
 *          this file asserts are refusals.
 *
 * WHAT IT PROVES THAT NOTHING ELSE DOES. That migration 0004 applies to a real
 * Postgres. That `insert into api_tokens` is a statement the app's role is
 * allowed to run. That `last_used_at` is really written. That a real
 * `Authorization` header survives a real HTTP stack, which is not the same
 * question as `app.inject`. And that changing OWNER_PASSPHRASE really does end a
 * token, which is the property this design was argued hardest for and which has
 * only ever been checked against a Map.
 *
 * WHAT IT DOES NOT PROVE. Anything about MCP itself. There is no MCP endpoint
 * yet and no tool. This is the credential and the door, and nothing above them.
 *
 * WHAT CALLS IT. A person, by hand, and anyone changing src/server/auth/.
 * WHAT IT READS. DATABASE_URL and OWNER_PASSPHRASE, through src/server/env.ts.
 * WHAT IT WRITES. One founder row on first run, one api_tokens row per run, and
 * whatever the server writes while answering six requests.
 */

import { loadEnv } from '../src/server/env.ts';

const env = loadEnv();

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';

import { API_TOKEN_PREFIX } from '../src/server/auth/api-token.ts';
import { closeDb, getDb } from '../src/server/db/client.ts';
import { apiTokens, founders } from '../src/server/db/schema.ts';
import { runMigrations } from '../src/server/db/migrate.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A port nothing else on this laptop is likely to want.
 *
 * Not 5000, which is what `npm run dev` binds. Running this while the app is up
 * would otherwise fail with EADDRINUSE and read like the proof failing rather
 * than like two servers wanting one socket.
 */
const PORT = 5099;
const BASE = `http://127.0.0.1:${String(PORT)}`;

/**
 * WHICH DATABASE THIS MAY POINT AT, AND IT IS NOT THE ONE WITH THE WORK IN IT.
 *
 * THE RULE. Never point this script at a database holding real founder data.
 * It signs in, claims the owner row on a fresh database, writes tokens, revokes
 * them, and restarts the server under a second passphrase. Every one of those is
 * harmless on a scratch database and none of them is something to do to somebody's
 * only copy of their work.
 *
 * WHAT A SCRATCH DATABASE IS. Real Postgres, real schema, and nothing in it to
 * lose. Either of these is one:
 *
 *   A local Postgres on the laptop, which is the simplest kind to get and the
 *   kind that costs nothing to throw away and make again. Postgres.app gives one
 *   on localhost with a database named after the Mac user and no password, so the
 *   connection string holds no credential.
 *
 *   The Repl `launchhouse-app (1)`. Its own checkout is several commits behind and
 *   never runs: `npm run db:migrate` and this script both execute from THIS
 *   checkout and only borrow its connection string.
 *
 * WHAT IS OFF LIMITS, for this and for every later step, is the Repl
 * `launchhouse-app`. It is the original. It holds 1 founder, 20 files, 35 file
 * versions, 3 threads and 30 messages, git has never carried any of it, and the
 * app has no restore path by design.
 *
 * THE COMMENT IS NOT THE GUARD. `refuseIfItHoldsWork` below counts rows before
 * anything is written, and stops if it finds founder content. A rule that lives
 * only in a comment is a rule somebody breaks at eleven at night while reading a
 * different file.
 */
const DATABASE_URL_RULE = 'never point prove:token at a database holding real founder work';

/** Postgres `undefined_table`. See isUndefinedTable, and the note in refuseIfItHoldsWork. */
const UNDEFINED_TABLE = '42P01';

/** One case and what it was. */
interface Case {
  readonly kind: 'PASS' | 'PLANT';
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const results: Case[] = [];

async function check(kind: Case['kind'], name: string, body: () => Promise<string>): Promise<void> {
  try {
    results.push({ kind, name, ok: true, detail: await body() });
  } catch (err) {
    results.push({ kind, name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Stop before writing anything if this database holds somebody's work.
 *
 * COUNTS CONTENT, NOT FOUNDERS. A founder row is not the signal: this script
 * creates one on its first run and finds it again on its second, so refusing on
 * `founder > 0` would make the proof runnable exactly once. What separates a
 * scratch database from the real one is what a founder has MADE, and the numbers
 * are not close. The scratch database has none of it. The original has 20 files,
 * 35 versions, 3 threads and 30 messages.
 *
 * A TABLE THAT DOES NOT EXIST COUNTS AS ZERO ROWS, AND THAT IS NOT A HOLE IN THE
 * GUARD. This runs before the migration, so on a database that has never been
 * migrated every one of these tables is absent and the count query itself errors
 * with 42P01. That used to end the run with `Failed query: select count(*) from
 * "ge_file"`, which reads like the proof failing rather than like a database with
 * no schema in it. A database with no schema has never had a founder write to it,
 * which is the strongest possible version of the thing this guard is checking for.
 * The refusal is unchanged where it matters: on the original, all four tables
 * exist, all four have rows, and every one of them is still counted.
 */
function isUndefinedTable(err: unknown): boolean {
  // The driver's error may arrive wrapped by drizzle, so walk the cause chain rather
  // than reading `.code` off the top. The depth limit is against a cyclic cause, which
  // would otherwise hang the guard rather than fail it.
  let e: unknown = err;
  for (let depth = 0; e !== null && e !== undefined && depth < 10; depth++) {
    if ((e as { code?: unknown }).code === UNDEFINED_TABLE) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

async function refuseIfItHoldsWork(): Promise<void> {
  const db = getDb();
  const counted: Array<{ table: string; n: number }> = [];
  const absent: string[] = [];
  for (const table of ['ge_file', 'ge_file_version', 'threads', 'messages'] as const) {
    try {
      const res = await db.execute(sql.raw(`select count(*)::int as n from "${table}"`));
      const n = (res as unknown as Array<{ n: number }>)[0]?.n ?? 0;
      counted.push({ table, n });
    } catch (err) {
      // A table that does not exist holds no rows, so it holds no founder work. Any
      // other error is a real one and is not this guard's to swallow.
      if (!isUndefinedTable(err)) throw err;
      absent.push(table);
    }
  }
  if (absent.length > 0) {
    process.stdout.write(
      `no table yet for ${absent.join(', ')}: this database has never been migrated, so there is nothing in it to lose\n`,
    );
  }
  const withWork = counted.filter((c) => c.n > 0);
  if (withWork.length > 0) {
    throw new Error(
      [
        'REFUSING TO RUN. This database holds founder work, and the rule is: ' + DATABASE_URL_RULE + '.',
        '',
        ...withWork.map((c) => `  ${c.table}: ${String(c.n)} rows`),
        '',
        'That looks like the original launchhouse-app Repl rather than a scratch database.',
        'Point DATABASE_URL at a scratch database, which has none of these rows, and run it again.',
        'Nothing has been written.',
      ].join('\n'),
    );
  }
}

/** Wait for the server to answer its own health check, or give up with a reason. */
async function waitForHealth(deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      // Not up yet. A connection refused here is the ordinary case for the first
      // second or so, and is not worth reporting.
    }
    if (Date.now() >= until) throw new Error(`the server did not answer ${BASE}/healthz within ${String(deadlineMs)}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Start the real server, on the real port, under a given passphrase.
 *
 * SPAWNED WITH AN ARGV ARRAY AND NEVER WITH `shell: true`. That is a lint rule in
 * this repository and it is the right one: a value that reaches a shell is a
 * value somebody can put a semicolon in.
 */
async function startServer(passphrase: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import=tsx', join(ROOT, 'src/server/index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      TZ: 'UTC',
      PORT: String(PORT),
      OWNER_PASSPHRASE: passphrase,
      // The server writes its own log to stderr. Quiet, because six requests of
      // pino output buries the verdict this script prints at the end.
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) process.stderr.write(`the server exited with ${String(code)}:\n${stderr}\n`);
  });

  try {
    await waitForHealth(30_000);
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(`${err instanceof Error ? err.message : String(err)}\nthe server said:\n${stderr}`, { cause: err });
  }
  return child;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(undefined);
    }, 5_000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

/** Sign in over HTTP, which is what claims the owner row on a fresh database. */
async function claimOwner(passphrase: string): Promise<void> {
  const res = await fetch(`${BASE}/auth/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ passphrase }).toString(),
    redirect: 'manual',
  });
  if (res.status !== 303) {
    throw new Error(`signing in answered ${String(res.status)} rather than 303, so the owner row was not claimed`);
  }
}

/**
 * Mint through the real script rather than by calling mintApiToken here.
 *
 * The point of this file is that nothing is stood in for. `npm run token:mint` is
 * what the founder actually types, so it is what gets run, and the token is read
 * off its stdout exactly as a person would copy it.
 */
async function mintThroughTheScript(passphrase: string): Promise<string> {
  const child = spawn(process.execPath, ['--import=tsx', join(ROOT, 'scripts/mint-token.ts'), '--label=prove-token'], {
    cwd: ROOT,
    env: { ...process.env, TZ: 'UTC', OWNER_PASSPHRASE: passphrase },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout?.on('data', (c: Buffer) => {
    out += c.toString();
  });
  child.stderr?.on('data', (c: Buffer) => {
    err += c.toString();
  });
  const code = await new Promise<number>((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
  if (code !== 0) throw new Error(`the mint script exited with ${String(code)}:\n${err}`);

  const found = new RegExp(`^${API_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`, 'm').exec(out);
  if (found === null) throw new Error(`no token was found on the mint script's stdout:\n${out}`);

  // The expiry line is the other half of what that script promises, and a person
  // reading this proof should see that it really printed one.
  if (!/It expires on \d{4}-\d{2}-\d{2}/.test(out)) {
    throw new Error(`the mint script did not print an expiry date:\n${out}`);
  }
  return found[0];
}

const ask = async (path: string, token?: string): Promise<{ status: number; body: string }> => {
  const res = await fetch(`${BASE}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.text() };
};

const errorOf = (body: string): string => (JSON.parse(body) as { error?: string }).error ?? '(no error field)';

async function main(): Promise<number> {
  if (env.DATABASE_URL === undefined || env.DATABASE_URL === '') {
    throw new Error(
      `DATABASE_URL is not set, and there is nothing to prove without a real one. The rule is: ${DATABASE_URL_RULE}.`,
    );
  }

  process.stdout.write(`database tagged ${env.DATABASE_ENV_TAG ?? '(untagged)'}, environment ${env.APP_ENV}\n`);

  // Before anything is written. See refuseIfItHoldsWork.
  await refuseIfItHoldsWork();

  // The migration this repository ships, applied from THIS checkout. On the
  // scratch database this is where 0004 lands for the first time.
  const run = await runMigrations();
  process.stdout.write(
    run.newlyApplied > 0
      ? `migrations: ${String(run.newlyApplied)} newly applied\n`
      : 'migrations: nothing was pending\n',
  );

  const passphrase = env.OWNER_PASSPHRASE;
  if (passphrase === '') throw new Error('OWNER_PASSPHRASE is not set, so nobody can sign in and nothing can be minted.');

  let child = await startServer(passphrase);
  const db = getDb();

  try {
    await claimOwner(passphrase);
    const owner = (await db.select({ id: founders.id }).from(founders).limit(1))[0];
    assert.ok(owner !== undefined, 'no founder row exists after signing in');

    const token = await mintThroughTheScript(passphrase);

    await check('PASS', 'a live token is the founder under the prefix', async () => {
      const res = await ask('/api/mcp/whoami', token);
      assert.equal(res.status, 200, `answered ${String(res.status)}: ${res.body}`);
      const body = JSON.parse(res.body) as { id: string };
      assert.equal(body.id, owner.id, 'the token resolved to a different founder than the row it was minted for');
      return `200, and it is founder ${body.id}`;
    });

    await check('PASS', 'last_used_at was written to real Postgres', async () => {
      const rows = await db
        .select({ id: apiTokens.id, lastUsedAt: apiTokens.lastUsedAt, label: apiTokens.label })
        .from(apiTokens)
        .where(eq(apiTokens.label, 'prove-token'));
      const live = rows.find((r) => r.lastUsedAt !== null);
      assert.ok(live !== undefined, `no api_tokens row has last_used_at set. Rows seen: ${String(rows.length)}`);
      return `last_used_at is ${live.lastUsedAt?.toISOString() ?? '(null)'}`;
    });

    await check('PLANT', 'the same live token is refused outside the prefix', async () => {
      const res = await ask('/api/me', token);
      assert.equal(res.status, 401, `answered ${String(res.status)}: ${res.body}`);
      assert.equal(errorOf(res.body), 'token_wrong_address');
      return '401 token_wrong_address';
    });

    await check('PLANT', 'one character changed is refused', async () => {
      const bent = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
      const res = await ask('/api/mcp/whoami', bent);
      assert.equal(res.status, 401, `answered ${String(res.status)}: ${res.body}`);
      assert.equal(errorOf(res.body), 'token_not_accepted');
      return '401 token_not_accepted';
    });

    await check('PLANT', 'no credential at all is refused', async () => {
      const res = await ask('/api/mcp/whoami');
      assert.equal(res.status, 401, `answered ${String(res.status)}: ${res.body}`);
      assert.equal(errorOf(res.body), 'not_signed_in');
      return '401 not_signed_in';
    });

    await check('PLANT', 'a revoked token is refused', async () => {
      await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.label, 'prove-token'));
      const res = await ask('/api/mcp/whoami', token);
      assert.equal(res.status, 401, `answered ${String(res.status)}: ${res.body}`);
      assert.equal(errorOf(res.body), 'token_not_accepted');
      return '401 token_not_accepted';
    });

    /**
     * The one this whole design was argued for, and the only case that needs a
     * second server.
     *
     * A token is bound to the passphrase, so editing one Replit Secret has to end
     * every token exactly as it signs every device out. Until this line ran, that
     * had only ever been true of a Map.
     */
    await check('PLANT', 'a changed OWNER_PASSPHRASE ends the token', async () => {
      const fresh = await mintThroughTheScript(passphrase);
      const before = await ask('/api/mcp/whoami', fresh);
      assert.equal(before.status, 200, 'the fresh token did not work before the passphrase changed');

      await stopServer(child);
      child = await startServer('a different passphrase entirely, and long enough');

      const after = await ask('/api/mcp/whoami', fresh);
      assert.equal(after.status, 401, `answered ${String(after.status)}: ${after.body}`);
      assert.equal(errorOf(after.body), 'token_not_accepted');
      return '200 before the change, 401 token_not_accepted after it';
    });
  } finally {
    await stopServer(child);
  }

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write('\n');
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.kind.padEnd(5)} ${r.name.padEnd(width)}  ${r.detail}\n`);
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    failed.length === 0
      ? `\nAll ${String(results.length)} cases held. The token seam works against real Postgres over real HTTP.\n`
      : `\n${String(failed.length)} of ${String(results.length)} cases failed.\n`,
  );
  return failed.length === 0 ? 0 : 1;
}

const code = await main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
});
await closeDb();
process.exit(code);
