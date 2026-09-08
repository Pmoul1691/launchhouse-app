/**
 * scripts/clear-scratch-master-key.ts
 *
 * WHAT THIS IS. Deletes the one row in `app_master_key`, so that a scratch
 * database will adopt the GE_MASTER_KEY set in the environment instead of the
 * key it generated for itself on some earlier boot.
 * `npm run scratch:clear-key -- --confirm`.
 *
 * ON THE WRONG DATABASE THIS IS UNRECOVERABLE, AND THAT IS THE FIRST THING TO
 * SAY. `app_master_key` holds the key every founder blob is encrypted under.
 * Delete it on a database with files in it and those files cannot be opened
 * again by anybody, including us. There is no recovery path, no backup of the
 * key inside the app, and no way to derive it from anything else. src/server/
 * boot/master-key.ts says the same in its own words: "a different key cannot
 * open what is already there".
 *
 * WHY IT IS SAFE ON THE ONE DATABASE IT IS FOR, AND THIS IS A FACT ABOUT THAT
 * DATABASE ON ONE DAY RATHER THAN A GENERAL RULE. The Repl `launchhouse-app (1)`
 * has one `app_master_key` row, version 1, written when it first booted on
 * 8 September 2026. Its `ge_file`, `ge_file_version`, `threads` and `messages`
 * counts are all zero, checked rather than assumed, and `ge_blob` is empty, so
 * nothing was ever encrypted under that key and there is nothing to orphan.
 * Running this on the original `launchhouse-app`, which holds 1 founder, 20
 * files and 35 file versions, would destroy all of it.
 *
 * THE PARAGRAPH ABOVE IS NOT THE GUARD. `refuseIfItHoldsAnything` below counts
 * five tables before touching anything and stops if it finds a single row. A
 * rule that lives only in a comment is a rule somebody breaks while reading a
 * different file.
 *
 * WHY THE ROW IS CLEARED RATHER THAN GE_MASTER_KEY UNSET, which is the other way
 * to make the mismatch go away and is worse. tests/db/setup.ts checks
 * DATABASE_URL and GE_MASTER_KEY separately and on purpose, so a run with no
 * GE_MASTER_KEY skips the three database suites: turn.db.test.ts,
 * turn.concurrency.test.ts and tests/db/setup.test.ts. Those hold the only proof
 * that a refused turn leaves the founder record untouched. Unsetting the
 * variable would fix `prove:token` and quietly switch off the twenty assertions
 * that matter most. Clearing the row fixes both and keeps one .env driving both
 * jobs.
 *
 * WHAT CALLS IT. A person, by hand, once per scratch database.
 * WHAT IT READS. DATABASE_URL, through src/server/env.ts, and five row counts.
 * WHAT IT WRITES. It deletes at most one row from `app_master_key`. Nothing else.
 */

import { loadEnv } from '../src/server/env.ts';

const env = loadEnv();

import { sql } from 'drizzle-orm';

import { closeDb, getDb } from '../src/server/db/client.ts';

/**
 * The five tables that must all be empty.
 *
 * `ge_blob` is the one that actually answers the question, because it holds the
 * ciphertext. The other four are there because they are what a person recognises
 * as somebody's work, and a refusal that says "20 files" is understood
 * immediately where one saying "48 blobs" is not.
 */
const MUST_BE_EMPTY = ['ge_blob', 'ge_file', 'ge_file_version', 'threads', 'messages'] as const;

async function refuseIfItHoldsAnything(): Promise<void> {
  const db = getDb();
  const counted: Array<{ table: string; n: number }> = [];
  for (const table of MUST_BE_EMPTY) {
    const res = await db.execute(sql.raw(`select count(*)::int as n from "${table}"`));
    counted.push({ table, n: (res as unknown as Array<{ n: number }>)[0]?.n ?? 0 });
  }

  const populated = counted.filter((c) => c.n > 0);
  if (populated.length > 0) {
    throw new Error(
      [
        'REFUSING. This database holds founder work, and deleting the master key would',
        'make every one of these rows permanently unreadable. There is no recovery.',
        '',
        ...populated.map((c) => `  ${c.table}: ${String(c.n)} rows`),
        '',
        'That is the original launchhouse-app Repl, not the scratch one. Nothing has been',
        'changed. Point DATABASE_URL at launchhouse-app (1) instead.',
      ].join('\n'),
    );
  }

  process.stdout.write(`${MUST_BE_EMPTY.join(', ')}: all empty, so no ciphertext depends on the current key\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  if (env.DATABASE_URL === undefined || env.DATABASE_URL === '') {
    throw new Error('DATABASE_URL is not set, so there is no database to look at.');
  }
  process.stdout.write(`database tagged ${env.DATABASE_ENV_TAG ?? '(untagged)'}, environment ${env.APP_ENV}\n`);

  const db = getDb();

  // The table is made by boot/master-key.ts rather than by a migration, so on a
  // database the app has never booted it does not exist at all. That is not an
  // error: it is the state this script is trying to reach.
  const exists = await db.execute(
    sql`select to_regclass('public.app_master_key') is not null as present`,
  );
  if ((exists as unknown as Array<{ present: boolean }>)[0]?.present !== true) {
    process.stdout.write('app_master_key does not exist, so there is nothing to clear. Nothing was changed.\n');
    return 0;
  }

  await refuseIfItHoldsAnything();

  // Shown before it goes, so the thing being deleted is on the screen rather than
  // taken on trust. key_b64 is NOT selected: it is the key.
  const rows = await db.execute(
    sql`select key_version, fingerprint, source, created_at from app_master_key`,
  );
  const before = rows as unknown as Array<{
    key_version: number;
    fingerprint: string;
    source: string;
    created_at: Date;
  }>;
  if (before.length === 0) {
    process.stdout.write('app_master_key is already empty. Nothing was changed.\n');
    return 0;
  }
  for (const r of before) {
    process.stdout.write(
      `  version ${String(r.key_version)}, source ${r.source}, fingerprint ${r.fingerprint}, created ${new Date(r.created_at).toISOString()}\n`,
    );
  }

  if (!argv.includes('--confirm')) {
    process.stdout.write(
      '\nNothing was changed. This is the row that would be deleted. Run again with --confirm to delete it.\n',
    );
    return 0;
  }

  await db.execute(sql`delete from app_master_key`);
  process.stdout.write(
    '\nDeleted. The next boot adopts GE_MASTER_KEY from the environment and records it as the source.\n',
  );
  return 0;
}

const code = await main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
});
await closeDb();
process.exit(code);
