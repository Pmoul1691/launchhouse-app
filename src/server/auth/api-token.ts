/**
 * src/server/auth/api-token.ts
 *
 * WHAT THIS IS. The second way a request becomes the founder: a bearer token,
 * for a client that is not a browser and has no cookie jar. How one is minted,
 * how one is read back into the owner, and how its last use is recorded.
 *
 * WHY IT EXISTS. Claude's custom connector UI on the web accepts an OAuth
 * client id and secret and nothing else. A request for `Authorization: Bearer`
 * and custom headers was filed and closed as not planned, so a token authed MCP
 * endpoint cannot be added as a connector on claude.ai. It CAN be added to
 * Claude Desktop's local config, where headers are supported. That is the
 * surface this file serves.
 *
 * IT IS A SIBLING OF ./session.ts, NOT A REPLACEMENT FOR IT. The cookie is
 * still how a browser proves who it is, and ./plugin.ts still refuses every
 * path under `/api/` that resolves to nobody. This adds a second credential
 * that lands on the same founder row. It does not open a door:
 * `PUBLIC_API_PATHS` in ./plugin.ts stays empty.
 *
 * WHY IT IS ITS OWN MODULE RATHER THAN THREE MORE FUNCTIONS IN ./session.ts.
 * Two credentials with two lifetimes and two failure sentences, sharing one
 * file, is how a caller ends up handing a cookie to the token path and getting
 * an answer. Here the two cannot be confused: `tokenIdFor` and `sessionIdFor`
 * live in different modules, and the domain word below means they cannot
 * produce the same id even if handed the same string.
 *
 * WHAT CALLS IT. scripts/mint-token.ts mints. ./plugin.ts reads, from step 3
 * of the MCP work. Nothing else, and nothing anywhere takes a founder id from
 * a header, a body or a path.
 *
 * WHAT IT READS. The AuthStore, and the Authorization header, through a caller.
 * WHAT IT WRITES. The `api_tokens` table, through the store.
 */

import { newSecret, sha256Hex } from './tokens.ts';
import type { ApiTokenRow, AuthStore, Clock, FounderRow } from './types.ts';

/**
 * What every token on the wire starts with.
 *
 * TWO REASONS, AND NEITHER IS DECORATION. A value pasted into a config file is
 * read by a person eventually, and one that announces what it is gets handled
 * as a credential rather than as a settings string. And ./plugin.ts can refuse
 * a header that is obviously not one of ours before it touches the database,
 * which is a shape test on a public value and leaks nothing.
 */
export const API_TOKEN_PREFIX = 'lh_';

/**
 * How long a minted token lasts. Ninety days, and it does NOT slide.
 *
 * The same number as the session cookie, for a different reason. A session
 * slides because a request is evidence the founder is at their laptop. A token
 * in a config file is evidence of nothing: it is read by software that would go
 * on presenting it for ever. So the clock starts at mint and runs out on its
 * own, and the founder mints another.
 *
 * THAT IS THE SECOND OF THE TWO WAYS THIS CREDENTIAL DIES WITH NO WARNING, and
 * both are made loud rather than left to be discovered. scripts/mint-token.ts
 * prints the exact expiry date at mint. The refusal in ./plugin.ts names expiry
 * as one of the two things to check and says to mint another.
 */
export const API_TOKEN_TTL_DAYS = 90;

const DAY_MS = 86_400_000;

/**
 * Do not write to the token table on every request.
 *
 * `last_used_at` exists so a founder looking at a list of tokens can tell which
 * one their laptop is still presenting before revoking any of them. That
 * question is answered just as well by an hour of granularity as by a
 * microsecond, and an UPDATE per request is write amplification against the one
 * table every MCP call already reads. ./session.ts makes the same trade for the
 * same reason.
 */
const TOUCH_AFTER_MS = 3_600_000;

/** The length of the random half, base64url. 32 bytes encodes to 43 characters. */
const SECRET_CHARS = 43;

const TOKEN_SHAPE = new RegExp(`^${API_TOKEN_PREFIX}[A-Za-z0-9_-]{${String(SECRET_CHARS)}}$`);

/**
 * Is this string the right shape to be one of our tokens?
 *
 * A TEST ON THE FORMAT, NOT ON THE SECRET. It says whether a header is worth a
 * database lookup and nothing else. Every value that passes still has to resolve
 * to a live row, and a value that fails gets the same sentence as one that
 * passes and misses, so this cannot be used to sort real tokens from invented
 * ones.
 */
export function looksLikeApiToken(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

/**
 * The row id for one token, on this deployment, under this passphrase.
 *
 * THE TOKEN ITSELF IS NEVER STORED. The id is a hash of it, so a database dump
 * holds nothing that can be presented to this app. That is the same property
 * `sessionIdFor` in ./session.ts has, and it is why neither table has a column
 * a credential could be read out of.
 *
 * CHANGING OWNER_PASSPHRASE INVALIDATES EVERY TOKEN, AND THAT IS DELIBERATE
 * RATHER THAN A BUG. It is written here because the next person to watch a
 * bearer token stop working after a passphrase change will reasonably assume
 * something is broken.
 *
 * The passphrase is mixed in before hashing, so a token minted under the old one
 * now hashes to an id that is in no row, and `findApiToken` returns null for it.
 * That is load bearing. ./session.ts describes the recovery story this app has:
 * a founder who thinks somebody got in edits one Replit Secret, redeploys, and
 * every device in the world is signed out including the stranger's. A bearer
 * token that survived that change would be a hole in exactly that sentence, on
 * the one surface reachable without a browser. So the token dies with the
 * cookies.
 *
 * WHAT IT COSTS, SAID PLAINLY. After a passphrase change the token in Claude
 * Desktop's config stops working, and the founder mints another and pastes it
 * in. Nothing is lost and nothing needs repairing. The two places that say so
 * are the mint script's output and the refusal in ./plugin.ts.
 *
 * THE DOMAIN WORD IS WHY THIS IS NOT THE SAME FORMULA AS `sessionIdFor`. With
 * the word in the middle, no cookie value and no token can ever hash to the same
 * id, whatever either of them contains. Without it the two would agree whenever
 * the strings did, and the only thing standing between that and a token
 * resolving to a session would be a prefix somebody could later decide to drop.
 *
 * The newline separators cannot appear in a token, which is a fixed prefix and
 * base64url, so there is no pair of different inputs that hash the same way.
 */
export function tokenIdFor(presented: string, bindingSecret: string): string {
  return sha256Hex(`${presented}\napi-token\n${bindingSecret}`);
}

/** What the caller needs in order to mint and to read. */
export interface ApiTokenConfig {
  readonly ttlDays: number;
  /**
   * The same secret ./session.ts binds cookies with, and today that is
   * OWNER_PASSPHRASE. A required property rather than a positional argument, for
   * the reason `SessionConfig.bindingSecret` gives: an argument somebody forgets
   * to pass is a set of credentials that quietly survive a passphrase change,
   * which is the failure this design exists to prevent, arriving in silence.
   */
  readonly bindingSecret: string;
}

/** A minted token: the value to paste, and the row that goes in the table. */
export interface MintedApiToken {
  /**
   * The only time this value exists anywhere. It is not stored and it cannot be
   * recovered from the row, so a caller that does not show it to the founder has
   * minted a token nobody can use.
   */
  readonly value: string;
  readonly row: ApiTokenRow;
}

export class ApiTokenMalformed extends Error {
  constructor() {
    super('newSecret did not produce a value of the shape looksLikeApiToken accepts. Nothing was written.');
    this.name = 'ApiTokenMalformed';
  }
}

/**
 * Mint a token for the founder, and the row that recognises it.
 *
 * The caller writes the row. There is no window in which a value has been handed
 * out and no row exists, because the value is worth nothing until the row does.
 *
 * IT CHECKS ITS OWN OUTPUT. `newSecret` is 32 random bytes as base64url today.
 * If that ever changes shape, every token minted afterwards would be refused by
 * the shape test in ./plugin.ts, and the symptom would be a token that looks
 * right in a config file and is never accepted. This throws at mint instead.
 */
export function mintApiToken(
  founderId: string,
  label: string,
  cfg: ApiTokenConfig,
  clock: Clock,
): MintedApiToken {
  const value = `${API_TOKEN_PREFIX}${newSecret()}`;
  if (!looksLikeApiToken(value)) throw new ApiTokenMalformed();

  const now = clock.now();
  return {
    value,
    row: {
      id: tokenIdFor(value, cfg.bindingSecret),
      founderId,
      label,
      createdAt: now,
      expiresAt: new Date(now.getTime() + cfg.ttlDays * DAY_MS),
      lastUsedAt: null,
      revokedAt: null,
    },
  };
}

export type ApiTokenLookup =
  | { readonly ok: true; readonly token: ApiTokenRow; readonly founder: FounderRow }
  | {
      readonly ok: false;
      readonly reason: 'absent' | 'malformed' | 'unknown' | 'expired' | 'revoked' | 'no_founder';
    };

/**
 * Turn a presented token into the founder, or say why it is not one.
 *
 * THE REASONS ARE FOR THE LOG, NEVER FOR WHOEVER PRESENTED THE TOKEN. Every one
 * of them ends at the same sentence. Telling a caller that a token was
 * "expired" rather than "unknown" tells them they guessed a real one, which is
 * the difference between a wrong value and a value worth attacking.
 *
 * It refuses a founder row that is disabled or deleted, for the reason
 * `readSession` does: it is the only way to end access without hunting down
 * every live credential first, and it costs one comparison.
 */
export async function readApiToken(
  store: AuthStore,
  presented: string | undefined,
  cfg: ApiTokenConfig,
  clock: Clock,
): Promise<ApiTokenLookup> {
  if (presented === undefined || presented.length === 0) return { ok: false, reason: 'absent' };
  if (!looksLikeApiToken(presented)) return { ok: false, reason: 'malformed' };

  const token = await store.findApiToken(tokenIdFor(presented, cfg.bindingSecret));
  if (token === null) return { ok: false, reason: 'unknown' };
  if (token.revokedAt !== null) return { ok: false, reason: 'revoked' };

  const now = clock.now();
  if (token.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };

  const founder = await store.findFounderById(token.founderId);
  if (founder === null || founder.deletedAt !== null || founder.disabledAt !== null) {
    return { ok: false, reason: 'no_founder' };
  }
  return { ok: true, token, founder };
}

/**
 * Record that this token was used, at most once an hour.
 *
 * Returns true when it wrote, so a caller can be tested without reading the
 * table back. The expiry is NOT moved: see API_TOKEN_TTL_DAYS above for why a
 * token does not slide the way a session does.
 *
 * The first use always writes, because `lastUsedAt` is null until it does, and
 * "this token has never been used" is the one answer a founder deciding whether
 * to revoke it most wants.
 */
export async function touchApiToken(store: AuthStore, token: ApiTokenRow, clock: Clock): Promise<boolean> {
  const now = clock.now();
  if (token.lastUsedAt !== null && now.getTime() - token.lastUsedAt.getTime() < TOUCH_AFTER_MS) return false;
  await store.touchApiToken(token.id, now);
  return true;
}
