/**
 * scripts/mint-token.ts
 *
 * WHAT THIS IS. Mints one bearer token for the owner of this deployment and
 * prints it once. `npm run token:mint -- --label="claude desktop, mac"`.
 *
 * WHY IT EXISTS, AND WHY IT IS A SCRIPT RATHER THAN A SCREEN. The token goes
 * into Claude Desktop's local MCP config, on the founder's own Mac, pasted in by
 * hand. There is no browser step in that job, so there is nothing for a screen
 * to do that this does not. A screen belongs with stage two, when the endpoint
 * has earned OAuth and a connector can be added from a phone.
 *
 * IT IS ALSO WHAT MAKES THE TABLE TESTABLE. A table with no way to get a row
 * into it cannot be proved to work end to end, and the first thing that would
 * exercise it otherwise is the MCP endpoint that does not exist yet.
 *
 * THE VALUE IS PRINTED ONCE AND CANNOT BE PRINTED AGAIN. Only its hash is
 * stored, so a founder who loses it mints another and revokes this one. That is
 * the same trade every credential in this app makes and it is stated in the
 * output rather than left to be discovered.
 *
 * IT PRINTS THE EXPIRY DATE, LOUDLY, BECAUSE THAT IS ONE OF THE TWO WAYS THIS
 * CREDENTIAL DIES WITH NO MESSAGE. The other is a change to OWNER_PASSPHRASE,
 * which invalidates every token on purpose. Both are named in the output, and
 * the reasoning for the second lives next to `tokenIdFor` in
 * src/server/auth/api-token.ts.
 *
 * WHAT CALLS IT. `npm run token:mint`, by hand. Nothing imports it.
 *
 * WHAT IT READS. The environment, through src/server/env.ts, and the founder
 * table.
 * WHAT IT WRITES. One row in `api_tokens`, and one audit line in `ge_event`.
 */

import { loadEnv } from '../src/server/env.ts';

const env = loadEnv();

import { API_TOKEN_TTL_DAYS, mintApiToken } from '../src/server/auth/api-token.ts';
import { PgAuthStore } from '../src/server/auth/store-pg.ts';
import { systemClock, type Logger } from '../src/server/auth/types.ts';
import { closeDb } from '../src/server/db/client.ts';

/** The verb this mint is recorded under. Read by nothing yet, kept by ge_event for ever. */
const MINT_VERB = 'api-token-mint';

/** The longest a label may be. Long enough for "claude desktop, mac", short enough to list. */
const MAX_LABEL = 80;

/**
 * A logger that writes to stderr, so the token on stdout can be piped or copied
 * without a log line landing in the middle of it.
 */
const log: Logger = {
  info: (obj, msg) => process.stderr.write(`${msg} ${JSON.stringify(obj)}\n`),
  warn: (obj, msg) => process.stderr.write(`${msg} ${JSON.stringify(obj)}\n`),
  error: (obj, msg) => process.stderr.write(`${msg} ${JSON.stringify(obj)}\n`),
};

function labelFrom(argv: readonly string[]): string {
  const flag = argv.find((a) => a.startsWith('--label='));
  if (flag === undefined) {
    throw new Error(
      'This needs a label, so that a list of tokens can say which is which later.\n' +
        '  npm run token:mint -- --label="claude desktop, mac"',
    );
  }
  const value = flag.slice('--label='.length).trim();
  if (value === '') throw new Error('--label is empty. Give it a few words naming where this token will live.');
  if (value.length > MAX_LABEL) {
    throw new Error(`--label is ${String(value.length)} characters and the most it may be is ${String(MAX_LABEL)}.`);
  }
  return value;
}

/** The expiry as a date a person reads, in UTC, because the process clock is pinned to UTC. */
function readableDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

async function main(argv: readonly string[]): Promise<number> {
  const label = labelFrom(argv);

  const passphrase = env.OWNER_PASSPHRASE;
  if (passphrase === '') {
    throw new Error(
      'OWNER_PASSPHRASE is not set, so there is nothing to bind a token to and nobody to mint one for.\n' +
        'Set it in Replit Secrets first.',
    );
  }

  const store = new PgAuthStore(log);
  const owner = await store.findOwner();
  if (owner === null) {
    throw new Error(
      'This deployment has never been signed in to, so there is no founder row to mint a token for.\n' +
        'Open the app, sign in once with the passphrase, then run this again.',
    );
  }

  const minted = mintApiToken(
    owner.id,
    label,
    { ttlDays: API_TOKEN_TTL_DAYS, bindingSecret: passphrase },
    systemClock,
  );
  await store.insertApiToken(minted.row);
  await store.recordAuthEvent(owner.id, 'founder', MINT_VERB, null, minted.row.createdAt);

  process.stdout.write(
    [
      '',
      `A token was minted, labelled "${label}".`,
      '',
      minted.value,
      '',
      'Copy it now. Only its hash is stored, so this is the one time it can be shown.',
      'Paste it into Claude Desktop\'s MCP config as the Authorization header, as "Bearer" and then the value.',
      '',
      'TWO THINGS STOP THIS TOKEN WORKING, AND NEITHER SENDS YOU A MESSAGE.',
      `  It expires on ${readableDate(minted.row.expiresAt)}, which is ${String(API_TOKEN_TTL_DAYS)} days from today. It does not renew itself.`,
      '  Changing OWNER_PASSPHRASE ends every token, the same way it signs every device out.',
      '',
      'Either way the fix is the same. Run this again and paste the new value in.',
      `environment ${env.APP_ENV}, database tagged ${env.DATABASE_ENV_TAG}`,
      '',
    ].join('\n'),
  );
  return 0;
}

const code = await main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
});
await closeDb();
process.exit(code);
