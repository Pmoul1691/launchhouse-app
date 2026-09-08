/**
 * src/server/auth/api-token.test.ts
 *
 * WHAT THIS IS. The bearer token, proved on the four properties that decide
 * whether it is safe to have one at all.
 *
 * WHY IT EXISTS. This credential is reachable without a browser, which means
 * every defence the cookie gets from the browser is one this does not have. So
 * the four are asserted rather than reasoned about:
 *
 *   The token is not in the row. If it were, a database dump would be a set of
 *   live credentials, and the whole argument for adding this surface falls over.
 *
 *   Changing the passphrase ends every token. That is the recovery story
 *   ./session.ts describes, and a bearer token that survived it would be a hole
 *   in exactly that sentence on the one surface reachable without a browser.
 *
 *   A token and a cookie cannot be handed to each other's reader and work. They
 *   are two credentials with two lifetimes, and the day they collide is the day
 *   one of them stops meaning what it says.
 *
 *   A token does not slide. `touchApiToken` records a use and must never move an
 *   expiry, because a token in a config file is presented by software whether or
 *   not anybody is there.
 *
 * WHAT IT CALLS. ./api-token.ts against the Maps in ./test-fixtures.ts. No
 * database, no network, no clock that moves on its own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_TOKEN_PREFIX,
  API_TOKEN_TTL_DAYS,
  looksLikeApiToken,
  mintApiToken,
  readApiToken,
  tokenIdFor,
  touchApiToken,
  type ApiTokenConfig,
} from './api-token.ts';
import { sessionIdFor } from './session.ts';
import { FOUNDER_A, MemoryAuthStore, seededStore, TestClock, TEST_PASSPHRASE } from './test-fixtures.ts';
import { OWNER_ROW_KEY } from './types.ts';

const CFG: ApiTokenConfig = { ttlDays: API_TOKEN_TTL_DAYS, bindingSecret: TEST_PASSPHRASE };
const OTHER_CFG: ApiTokenConfig = { ttlDays: API_TOKEN_TTL_DAYS, bindingSecret: 'a different passphrase entirely' };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A store with the deployment claimed, one token in it, and the value that opens it. */
async function withToken(clock: TestClock, cfg: ApiTokenConfig = CFG) {
  const store = seededStore();
  const minted = mintApiToken(FOUNDER_A, 'claude desktop, mac', cfg, clock);
  await store.insertApiToken(minted.row);
  return { store, minted };
}

// ---------------------------------------------------------------------------
// The token is not in the row
// ---------------------------------------------------------------------------

test('THE TOKEN ITSELF IS IN NO COLUMN OF THE ROW', () => {
  const minted = mintApiToken(FOUNDER_A, 'claude desktop, mac', CFG, new TestClock());

  // Every value on the row, flattened, must contain no part of the token. Not
  // just the id: a label somebody later decided to prefill, or a stray copy in a
  // new column, would be caught here too.
  const flat = JSON.stringify(minted.row);
  assert.ok(!flat.includes(minted.value), 'the whole token is somewhere on the row');

  // The random half on its own, in case a prefix is ever stripped before storing.
  const secretHalf = minted.value.slice(API_TOKEN_PREFIX.length);
  assert.ok(!flat.includes(secretHalf), 'the random half of the token is somewhere on the row');

  // And the id is a sha256 in hex, which is the shape that cannot be reversed.
  assert.match(minted.row.id, /^[0-9a-f]{64}$/);
});

test('two mints are two different tokens and two different rows', () => {
  const clock = new TestClock();
  const a = mintApiToken(FOUNDER_A, 'one', CFG, clock);
  const b = mintApiToken(FOUNDER_A, 'two', CFG, clock);
  assert.notEqual(a.value, b.value);
  assert.notEqual(a.row.id, b.row.id);
});

test('the same token hashes to the same id every time, or nothing would ever resolve', () => {
  const value = `${API_TOKEN_PREFIX}${'x'.repeat(43)}`;
  assert.equal(tokenIdFor(value, TEST_PASSPHRASE), tokenIdFor(value, TEST_PASSPHRASE));
});

// ---------------------------------------------------------------------------
// Changing the passphrase ends every token
// ---------------------------------------------------------------------------

test('CHANGING THE PASSPHRASE MAKES EVERY TOKEN UNREACHABLE, which is the point of binding it', async () => {
  const clock = new TestClock();
  const { store, minted } = await withToken(clock);

  // Still the founder under the passphrase it was minted with.
  const before = await readApiToken(store, minted.value, CFG, clock);
  assert.equal(before.ok, true);

  // The Replit Secret is edited. The row is untouched and the token is unchanged,
  // and it now hashes to an id that is in no row.
  const after = await readApiToken(store, minted.value, OTHER_CFG, clock);
  assert.equal(after.ok, false);
  assert.equal(after.ok === false ? after.reason : '', 'unknown');

  // The row is still sitting there. Nothing swept it, and nothing needed to:
  // it is unreachable rather than deleted.
  assert.equal(store.apiTokens.size, 1);
});

test('the derived id itself differs under a different binding secret', () => {
  const value = `${API_TOKEN_PREFIX}${'x'.repeat(43)}`;
  assert.notEqual(tokenIdFor(value, TEST_PASSPHRASE), tokenIdFor(value, 'something else'));
});

// ---------------------------------------------------------------------------
// A token and a cookie cannot be swapped
// ---------------------------------------------------------------------------

test('A TOKEN AND A COOKIE NEVER HASH TO THE SAME ID, even handed the same string', () => {
  // The domain word in tokenIdFor is what makes this true by construction rather
  // than by the prefix, which somebody could later decide to drop.
  for (const value of [`${API_TOKEN_PREFIX}${'x'.repeat(43)}`, 'a bare cookie value', '']) {
    assert.notEqual(
      tokenIdFor(value, TEST_PASSPHRASE),
      sessionIdFor(value, TEST_PASSPHRASE),
      `a token id and a session id agree for ${JSON.stringify(value)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The shape test, which decides what is worth a database lookup
// ---------------------------------------------------------------------------

test('looksLikeApiToken accepts what mintApiToken makes', () => {
  const minted = mintApiToken(FOUNDER_A, 'claude desktop, mac', CFG, new TestClock());
  assert.ok(looksLikeApiToken(minted.value));
  assert.ok(minted.value.startsWith(API_TOKEN_PREFIX));
});

test('looksLikeApiToken refuses everything that is not one', () => {
  const good = `${API_TOKEN_PREFIX}${'x'.repeat(43)}`;
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['', 'empty'],
    ['x'.repeat(43), 'no prefix'],
    [`${API_TOKEN_PREFIX}${'x'.repeat(42)}`, 'one character short'],
    [`${API_TOKEN_PREFIX}${'x'.repeat(44)}`, 'one character long'],
    [`${API_TOKEN_PREFIX}${'x'.repeat(42)}+`, 'base64 rather than base64url'],
    [`${API_TOKEN_PREFIX}${'x'.repeat(42)}/`, 'a slash, which base64url does not use'],
    [`Bearer ${good}`, 'the header word left on the front'],
    [`${good} `, 'a trailing space from a copy and paste'],
    [` ${good}`, 'a leading space from a copy and paste'],
    [good.toUpperCase(), 'the prefix upper cased'],
  ];
  // A for loop rather than a table runner, because node:test has no it.each and a
  // failure still has to name which case it was.
  for (const [value, why] of cases) {
    assert.equal(looksLikeApiToken(value), false, `accepted ${JSON.stringify(value)}, which is ${why}`);
  }
});

// ---------------------------------------------------------------------------
// Reading one back
// ---------------------------------------------------------------------------

test('a live token resolves to the founder it was minted for', async () => {
  const clock = new TestClock();
  const { store, minted } = await withToken(clock);

  const lookup = await readApiToken(store, minted.value, CFG, clock);
  assert.equal(lookup.ok, true);
  if (lookup.ok) {
    assert.equal(lookup.founder.id, FOUNDER_A);
    assert.equal(lookup.founder.email, OWNER_ROW_KEY);
    assert.equal(lookup.token.label, 'claude desktop, mac');
  }
});

test('EVERY WAY A TOKEN FAILS IS NAMED, and none of them is an exception', async () => {
  const clock = new TestClock();

  // Each case builds its own store, so one case cannot leave state that makes the
  // next one pass for the wrong reason.
  const cases: ReadonlyArray<readonly [string, () => Promise<{ presented: string | undefined; store: MemoryAuthStore }>]> = [
    [
      'absent',
      async () => ({ presented: undefined, store: (await withToken(clock)).store }),
    ],
    [
      'absent',
      async () => ({ presented: '', store: (await withToken(clock)).store }),
    ],
    [
      'malformed',
      async () => ({ presented: 'not-a-token-at-all', store: (await withToken(clock)).store }),
    ],
    [
      'unknown',
      async () => ({ presented: `${API_TOKEN_PREFIX}${'x'.repeat(43)}`, store: (await withToken(clock)).store }),
    ],
    [
      'revoked',
      async () => {
        const { store, minted } = await withToken(clock);
        await store.revokeApiToken(minted.row.id, clock.now());
        return { presented: minted.value, store };
      },
    ],
    [
      // Minted on the clock every other case uses. The read below is the half
      // that moves: it happens one millisecond past the expiry, which is the
      // boundary the comparison in readApiToken is written on.
      'expired',
      async () => {
        const { store, minted } = await withToken(clock);
        return { presented: minted.value, store };
      },
    ],
    [
      'no_founder',
      async () => {
        const store = new MemoryAuthStore();
        store.addFounder({ id: FOUNDER_A, email: OWNER_ROW_KEY, disabledAt: clock.now() });
        const minted = mintApiToken(FOUNDER_A, 'disabled founder', CFG, clock);
        await store.insertApiToken(minted.row);
        return { presented: minted.value, store };
      },
    ],
    [
      'no_founder',
      async () => {
        const store = new MemoryAuthStore();
        store.addFounder({ id: FOUNDER_A, email: OWNER_ROW_KEY, deletedAt: clock.now() });
        const minted = mintApiToken(FOUNDER_A, 'deleted founder', CFG, clock);
        await store.insertApiToken(minted.row);
        return { presented: minted.value, store };
      },
    ],
  ];

  for (const [expected, build] of cases) {
    const { presented, store } = await build();
    // The expiry case winds its own clock forward, so read with a clock that is
    // past the expiry for that one and at the start for the rest.
    const at = expected === 'expired' ? new TestClock(new Date(clock.now().getTime() + API_TOKEN_TTL_DAYS * DAY_MS + 1)) : clock;
    const lookup = await readApiToken(store, presented, CFG, at);
    assert.equal(lookup.ok, false, `${expected} resolved to a founder`);
    assert.equal(lookup.ok === false ? lookup.reason : '', expected);
  }
});

test('a token minted for one founder does not resolve on a deployment whose owner is somebody else', async () => {
  const clock = new TestClock();
  const store = new MemoryAuthStore();
  // The row survives, the founder it points at does not exist. `founder_id`
  // references the founder table with ON DELETE cascade, so Postgres would have
  // taken this row with it. The fixture proves the reader refuses anyway, which
  // is what holds if that constraint is ever relaxed.
  const minted = mintApiToken(FOUNDER_A, 'orphan', CFG, clock);
  await store.insertApiToken(minted.row);

  const lookup = await readApiToken(store, minted.value, CFG, clock);
  assert.equal(lookup.ok, false);
  assert.equal(lookup.ok === false ? lookup.reason : '', 'no_founder');
});

// ---------------------------------------------------------------------------
// Recording a use, and never sliding
// ---------------------------------------------------------------------------

test('THE FIRST USE IS ALWAYS RECORDED, because "never used" is what decides a revoke', async () => {
  const clock = new TestClock();
  const { store, minted } = await withToken(clock);
  assert.equal(minted.row.lastUsedAt, null);

  assert.equal(await touchApiToken(store, minted.row, clock), true);
  assert.deepEqual(store.apiTokens.get(minted.row.id)?.lastUsedAt, clock.now());
});

test('a use inside the hour is not written, and one after it is', async () => {
  const clock = new TestClock();
  const { store, minted } = await withToken(clock);
  await touchApiToken(store, minted.row, clock);

  const afterFirst = store.apiTokens.get(minted.row.id);
  assert.ok(afterFirst !== undefined);

  clock.advance(HOUR_MS - 1);
  assert.equal(await touchApiToken(store, afterFirst, clock), false);

  clock.advance(2);
  assert.equal(await touchApiToken(store, afterFirst, clock), true);
});

test('A USE NEVER MOVES THE EXPIRY. A token does not slide the way a session does', async () => {
  const clock = new TestClock();
  const { store, minted } = await withToken(clock);
  const expiry = minted.row.expiresAt.getTime();

  // Used every hour for the whole of its life, and it still runs out on the day
  // the mint script printed.
  for (let hour = 0; hour < API_TOKEN_TTL_DAYS * 24; hour += 1) {
    const row = store.apiTokens.get(minted.row.id);
    assert.ok(row !== undefined);
    await touchApiToken(store, row, clock);
    clock.advance(HOUR_MS);
  }

  assert.equal(store.apiTokens.get(minted.row.id)?.expiresAt.getTime(), expiry);
  const lookup = await readApiToken(store, minted.value, CFG, clock);
  assert.equal(lookup.ok, false);
  assert.equal(lookup.ok === false ? lookup.reason : '', 'expired');
});

test('the expiry is the ttl away from the mint, which is the number the script prints', () => {
  const clock = new TestClock();
  const minted = mintApiToken(FOUNDER_A, 'claude desktop, mac', CFG, clock);
  assert.equal(
    minted.row.expiresAt.getTime() - minted.row.createdAt.getTime(),
    API_TOKEN_TTL_DAYS * DAY_MS,
  );
});

// ---------------------------------------------------------------------------
// The store keeps the promises the schema makes
// ---------------------------------------------------------------------------

test('a token id cannot be written twice, because it is a primary key', async () => {
  const clock = new TestClock();
  const { store, minted } = await withToken(clock);
  await assert.rejects(() => store.insertApiToken(minted.row));
});

test('revoking is permanent for that row, and takes no other token with it', async () => {
  const clock = new TestClock();
  const { store, minted } = await withToken(clock);
  const other = mintApiToken(FOUNDER_A, 'second machine', CFG, clock);
  await store.insertApiToken(other.row);

  await store.revokeApiToken(minted.row.id, clock.now());

  const revoked = await readApiToken(store, minted.value, CFG, clock);
  assert.equal(revoked.ok, false);
  const survivor = await readApiToken(store, other.value, CFG, clock);
  assert.equal(survivor.ok, true);
});
