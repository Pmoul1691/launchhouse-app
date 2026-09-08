/**
 * src/server/auth/plugin.ts
 *
 * WHAT THIS IS. The HTTP surface of sign in, and the door every other route in
 * this app sits behind.
 *
 * WHY IT EXISTS. It is the one place a request becomes the founder. The session
 * cookie is read here and nowhere else, and no handler anywhere reads a founder
 * id from a body, a query string or a path.
 *
 * THE DOOR IS SHUT BY DEFAULT, AND THAT IS THE CHANGE THAT MATTERS MOST IN THIS
 * FILE. There used to be one `requireFounder` that each route had to remember to
 * call. That is a design where a new route is open until somebody notices, and
 * the thing on the other side of it is one founder's customer list, their
 * credentials and their files, on a public web address. So there is an
 * onRequest hook now: every path under `/api/` is refused unless a session
 * resolves, whatever the route does or does not call. `requireFounder` still
 * exists and still works, and it now reuses what the hook already looked up
 * rather than reading the session twice.
 *
 * The other failures it prevents:
 *
 *   AN UNCONFIGURED DEPLOYMENT SERVING THE APP. With no usable
 *   OWNER_PASSPHRASE, every request is answered with the screen that says which
 *   Replit Secret to set. Not the app, not an empty sign in box that can never
 *   succeed. It refuses whether or not anybody called the boot guard in
 *   ./owner.ts, because a guard that depends on a caller remembering is one
 *   refactor from being decorative.
 *
 *   A FORM POST FASTIFY CANNOT PARSE. Fastify parses JSON out of the box and
 *   nothing else. The sign in screen is a plain HTML form on purpose, so it
 *   works with JavaScript switched off and before dist/web exists, and a form
 *   posts urlencoded. Without the parser registered here the founder would
 *   press a button that did nothing.
 *
 *   THE BINDING SECRET BEING PASSED IN BY HAND. `SessionConfig.bindingSecret`
 *   is what makes changing the passphrase sign every device out. It is built
 *   HERE, from the passphrase, rather than accepted from the caller, so there
 *   is no way for src/server/index.ts to wire a value that is merely plausible
 *   and quietly lose the property.
 *
 * THERE ARE TWO CREDENTIALS NOW, AND ONLY ONE DOOR. A session cookie, and a
 * bearer token for a client that has no cookie jar. Both are read in `resolve`
 * below and both end at the same founder row, so a route cannot tell them apart
 * and does not have to. The token is accepted under ONE prefix rather than
 * everywhere: see MCP_API_PREFIX.
 *
 * WHAT CALLS IT. src/server/index.ts registers it once, before the API routes.
 * WHAT IT READS. The cookie on the request, the Authorization header, and the
 * AuthStore.
 * WHAT IT WRITES. The owner row on first claim, `sessions`, `api_tokens.last_used_at`
 * and `ge_event` through the store, and one Set-Cookie header.
 */

import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { API_TOKEN_TTL_DAYS, readApiToken, touchApiToken, type ApiTokenConfig } from './api-token.ts';
import { MIN_PASSPHRASE_LENGTH, OwnerAuth, type OwnerAuthConfig } from './owner.ts';
import { asSignInNotice, notSetUpPage, signInPage, tooManyTriesPage } from './pages.ts';
import { DEFAULT_ATTEMPT_LIMIT, SigninAttempts, type AttemptLimitConfig } from './rate-limit.ts';
import {
  cookieOptionsFor,
  endSession,
  readSession,
  slideSession,
  type SessionConfig,
} from './session.ts';
import { realSleep, type AuthStore, type Clock, type FounderRow, type Logger, type SessionRow, type Sleep } from './types.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by the guard hook below, and by requireFounder. By nothing else.
     * Present only on a request that presented a live session cookie belonging
     * to a founder row that is not disabled or deleted.
     */
    founder?: FounderRow;
    lhSession?: SessionRow;
  }
}

export interface AuthPluginOptions {
  readonly store: AuthStore;
  readonly clock: Clock;
  readonly log: Logger;
  /** OWNER_PASSPHRASE, read through src/server/env.ts. Never process.env. */
  readonly passphrase: string;
  /** The cookie's own settings. The binding secret is NOT here: see below. */
  readonly cookie: {
    readonly name: string;
    readonly ttlDays: number;
    /** True when APP_BASE_URL is https. A Secure cookie over http is never sent back. */
    readonly secure: boolean;
    /**
     * 'none' on the Replit workspace preview, 'lax' everywhere else. Both this
     * and `partitioned` come from `sessionCookiePolicyFor` in ./session.ts, which
     * is the only thing allowed to decide them, because the three attributes are
     * only valid in certain combinations.
     */
    readonly sameSite: 'lax' | 'none';
    readonly partitioned: boolean;
  };
  readonly limits?: AttemptLimitConfig;
  /** Injected so a test can prove the slow down happened without waiting for it. */
  readonly sleep?: Sleep;
  /**
   * Signs cookies. Not the session secret: the session id is derived from 32
   * random bytes and the passphrase already. It is here because
   * @fastify/cookie requires one before any cookie can be signed.
   */
  readonly cookieSecret: string;
}

/**
 * Everything the app needs from auth, handed to the routes so they do not reach
 * into this module's internals.
 */
export interface AuthContext {
  readonly owner: OwnerAuth;
  /** The name the session cookie is written under, for any route that has to clear it. */
  readonly cookieName: string;
  /** Throws nothing. Replies 401 and returns false when there is no founder. */
  requireFounder(request: FastifyRequest, reply: FastifyReply): Promise<boolean>;
  /** The founder on a request that has already passed requireFounder. */
  founderOf(request: FastifyRequest): FounderRow;
  /**
   * End the session this request arrived on, and clear its cookie.
   *
   * WHY THE ROUTES LAYER CANNOT DO THIS ITSELF ANY MORE, and it is a good
   * change. It used to find the cookie by hashing every cookie on the request
   * and comparing against the session id. The session id is derived from the
   * cookie AND the passphrase now, so that comparison cannot be made outside
   * this module without handing the passphrase to the routes layer. One method
   * here instead, and the passphrase stays in one folder.
   */
  endSessionOn(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}

export class NotSignedIn extends Error {
  constructor() {
    super('This request has no founder on it. requireFounder did not run, or it refused.');
    this.name = 'NotSignedIn';
  }
}

/** The sentence a browser or the bundle is given when there is no session. */
/**
 * The only page a refused cross site write ever produces.
 *
 * Deliberately says nothing about what this app is or whether the address
 * exists. Whoever is reading it is not the founder.
 */
const CROSS_SITE_PAGE = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8">',
  '<title>Not carried out</title></head><body>',
  '<h1>Not carried out</h1>',
  '<p>That request came from another site.</p>',
  '</body></html>',
].join('');

const NOT_SIGNED_IN = {
  error: 'not_signed_in',
  message: 'Sign in again to carry on. Nothing you have made is affected.',
} as const;

/**
 * The answer to a bearer token that did not resolve, at an address that accepts
 * bearer tokens.
 *
 * ONE SENTENCE FOR ALL FIVE REASONS. `readApiToken` can tell malformed from
 * unknown from expired from revoked from a founder who is disabled, and every
 * one of them arrives here as the same bytes. Saying "expired" rather than
 * "unknown" tells whoever sent it that they guessed a real token, which is the
 * difference between a wrong value and a value worth attacking. The reasons go
 * to the log, where the founder can read them and a stranger cannot.
 *
 * IT NAMES THE FIX, because both ways this credential dies are silent. A token
 * expires on a date nothing reminds you of, and changing OWNER_PASSPHRASE ends
 * every token on purpose. The founder reading this is at a terminal with the
 * repository in front of them, so the command is the most useful thing to say.
 */
const TOKEN_NOT_ACCEPTED = {
  error: 'token_not_accepted',
  message:
    'That token is expired or unknown. Mint another with npm run token:mint and paste it into your Claude Desktop config. Changing OWNER_PASSPHRASE also ends every token.',
} as const;

/**
 * The answer to a bearer token at an address that does not take one.
 *
 * WHY THIS IS NOT THE SAME SENTENCE AS THE ONE ABOVE, which was the first
 * version. "Expired or unknown, mint another" sends the founder to re mint a
 * token that was never the problem, and the new one fails in exactly the same
 * way. A refusal that prescribes a fix that cannot work is worse than one that
 * says nothing.
 *
 * IT LEAKS THE PREFIX, AND THE PREFIX IS NOT A SECRET. It is written in the
 * config file this token was pasted into. What must not leak is whether a token
 * VALUE was ever real, and this sentence is returned for a live token and a
 * made up one alike, so it cannot answer that question.
 *
 * THIS IS A DELIBERATE DEPARTURE FROM THE RULE THE REST OF THIS FILE FOLLOWS, and
 * it is named here so the next reader sees a tension that was weighed rather than
 * an inconsistency that was missed. The guard hook below refuses `/api/files` and
 * a route that does not exist with the same 401 on purpose, so that a probe
 * "tells them nothing about what this app has". This sentence tells them one
 * thing: that addresses under `/api/mcp/` take a token. That was traded, on
 * purpose, for a founder at a terminal being able to tell "wrong address" from
 * "dead token" without reading this file. The disclosure is one path prefix
 * already sitting in a config file on their laptop. The thing bought is that the
 * refusal never prescribes a fix that cannot work. If the two ever have to be
 * reconciled, reconcile them by making the prefix less guessable, not by making
 * this sentence vaguer, because a vaguer sentence costs the debuggability and
 * saves nothing a probe could not learn in two requests anyway.
 */
const TOKEN_WRONG_ADDRESS = {
  error: 'token_wrong_address',
  message: 'Tokens are not accepted at that address. They work under /api/mcp/ only. A browser signs in with the passphrase instead.',
} as const;

/**
 * Is this a browser looking at a page, or code reading JSON.
 *
 * ../routes/errors.ts has the same rule and this is four lines rather than an
 * import of it. This module has to work when the rest of the app is broken:
 * index.ts registers auth before the API routes exist, and a sign in screen
 * that cannot render because a module in the routes layer failed to load is the
 * one screen that must never have that dependency.
 */
function wantsHtml(request: FastifyRequest): boolean {
  if (request.url.startsWith('/api/')) return false;
  const accept = request.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

/** The path with any query string removed, for prefix tests. */
function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Methods that do not change anything, so no Origin check applies to them. */
const SAFE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Is this a state changing request that arrived from another site?
 *
 * WHY THIS EXISTS AT ALL. `SameSite=Lax` was this app's whole CSRF defence, and
 * the workspace preview cannot use Lax: see ./session.ts. So on the surface
 * where Lax is given up, the defence is replaced here rather than dropped.
 *
 * WHAT IT COMPARES. The `Origin` header against the host the request was
 * actually sent to. Not against APP_BASE_URL. If APP_BASE_URL is ever derived
 * to something other than the address the founder is on, comparing against it
 * would refuse every request that founder makes and lock them out of their own
 * app. Comparing the request against itself cannot do that.
 *
 * WHERE IT DELIBERATELY DOES NOT REFUSE. A request with no `Origin` at all is
 * allowed. Browsers send `Origin` on every POST, so a missing one means a
 * script, a probe or the test client, none of which is a founder's browser
 * being used against them. That is the whole trick CSRF depends on and it needs
 * a browser. Refusing here would buy nothing and would break tooling.
 *
 * `Origin: null` IS refused, because a sandboxed iframe is the one way an
 * attacker can make a real browser send a cross site write without naming
 * itself, and nothing in this app produces it.
 */
export function crossSiteWrite(
  method: string,
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (SAFE_METHODS.includes(method.toUpperCase())) return false;
  if (typeof origin !== 'string' || origin === '') return false;
  if (origin === 'null') return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    // A browser cannot produce this. Something that is not a browser can, and
    // it is not the thing this guard is for.
    return false;
  }
  if (typeof host !== 'string' || host === '') return false;
  return originHost !== host.toLowerCase();
}

/**
 * Addresses under /api/ that anybody on the internet may reach.
 *
 * IT IS EMPTY, AND KEEPING IT EMPTY IS THE POINT.
 *
 * There used to be a blanket exemption for everything under `/api/auth/`,
 * because signing in was a JSON call and the person making it has no session
 * yet. Signing in is a plain form POST to `/auth/signin` now, which is not
 * under `/api/` at all, so nothing needs the exemption and a prefix that
 * exempts a whole namespace is a door somebody walks through later by naming a
 * route well.
 *
 * ADDING A LINE HERE OPENS THAT ADDRESS TO EVERYONE. Not to a founder, not to a
 * mentor: to whoever finds the URL. That is sometimes right, and it should
 * always be a decision somebody made on purpose in this file rather than a side
 * effect of where a route was filed.
 */
const PUBLIC_API_PATHS: readonly string[] = [];

/**
 * The one prefix under `/api/` where a bearer token is accepted.
 *
 * THIS IS THE OPPOSITE OF THE LIST ABOVE, AND THE TWO ARE EASY TO CONFUSE.
 * PUBLIC_API_PATHS opens an address to everybody who finds the URL. This opens
 * nothing. Every address under here still requires a founder, and all this
 * decides is WHICH credentials count as proving you are one. Outside it, the
 * session cookie is the only answer.
 *
 * WHY THE TOKEN IS NOT SIMPLY ACCEPTED EVERYWHERE, which is one line shorter and
 * was the first design. Two reasons, and the second is the one that settled it.
 *
 *   ../routes/index.ts says what is reachable is the first question in any
 *   conversation about a closed cohort's data, and the comment above warns
 *   against a door somebody walks through later by naming a route well. A
 *   credential that reaches routes nobody has written yet is that same problem
 *   wearing different clothes. A route added in a hurry in nine months is
 *   reachable by this token, and nobody decided that.
 *
 *   THE STORAGE IS WEAKER THAN THE COOKIE'S, SO THE SCOPE IS NARROWER. The
 *   session cookie is HttpOnly, scoped to this origin by the browser, and no
 *   script on the page can read it. This token sits in a plaintext JSON config
 *   file on a laptop, readable by anything running as that user. Weaker storage
 *   gets less reach. That is the whole trade, and it is why a leaked token costs
 *   the MCP tools rather than the founder's entire API.
 *
 * TRAILING SLASH ON PURPOSE. `/api/mcp/` and not `/api/mcp`, so a future
 * `/api/mcp-admin` cannot be swept in by a prefix test that was written for
 * something else.
 *
 * NOTHING IS REGISTERED UNDER IT YET. Step 4 of the MCP work adds the first
 * route, and the first thing it adds is a trivial authenticated one, so there is
 * something to curl before any real tool exists. Until then this prefix is a
 * rule with nothing behind it, which is the correct order: the door learns the
 * credential before the room exists.
 */
export const MCP_API_PREFIX = '/api/mcp/';

/**
 * The token out of an `Authorization` header, or undefined when there is not one.
 *
 * STRICT ON PURPOSE, AND EVERY REFUSAL HERE IS FREE. This runs before any
 * database call, on a header anybody can send. `Bearer` is compared without
 * regard to case because RFC 7235 says the scheme is case insensitive and real
 * clients vary. Everything else has to be exact: one space, then a value with no
 * space in it. That refuses `Bearer` alone, two spaces, a trailing space from a
 * copy and paste, and a second word, all of which are a malformed header rather
 * than a credential.
 */
export function bearerFrom(header: string | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const space = header.indexOf(' ');
  if (space === -1) return undefined;
  if (header.slice(0, space).toLowerCase() !== 'bearer') return undefined;
  const value = header.slice(space + 1);
  if (value === '' || value.includes(' ')) return undefined;
  return value;
}

/**
 * Which of the three refusals this request has earned.
 *
 * PURE, AND RE READS THE HEADER RATHER THAN BEING TOLD. It is a string parse on
 * a value already in memory, and the alternative is a fourth piece of state
 * hung on the request that `resolve` has to remember to set on every path out of
 * itself. One of those can be got wrong.
 *
 * The order matters. A request with no bearer at all is a browser and gets the
 * sentence the bundle knows how to paint. A bearer at the wrong address is told
 * so, because telling it to re mint would prescribe a fix that cannot work.
 * Everything else is the one sentence that covers all five ways a token fails.
 */
export function refusalFor(request: FastifyRequest): { readonly error: string; readonly message: string } {
  if (bearerFrom(request.headers.authorization) === undefined) return NOT_SIGNED_IN;
  if (!pathOf(request.url).startsWith(MCP_API_PREFIX)) return TOKEN_WRONG_ADDRESS;
  return TOKEN_NOT_ACCEPTED;
}

/**
 * Build the sign in surface and the door that goes with it.
 *
 * `register` takes the root Fastify instance and adds to it directly, rather
 * than being handed to `app.register`. That is deliberate. `app.register`
 * encapsulates: the cookie decorator, the form body parser and the guard hook
 * would exist inside the plugin's own scope and NOT on the API routes, so every
 * authenticated route would read `request.cookies` as undefined, the guard
 * would never run, and every founder would be signed out of an app that was
 * also wide open. Adding to the root instance is the version of this that
 * works, and it needs no plugin wrapper to do it.
 */
export function createAuth(opts: AuthPluginOptions): {
  register: (app: FastifyInstance) => Promise<void>;
  context: AuthContext;
} {
  /**
   * The session config, built here so the binding secret cannot be wired wrong.
   *
   * `bindingSecret` is the passphrase. That is what makes every device sign out
   * when the passphrase changes, and it is the recovery story: a founder who
   * thinks somebody got in edits one Replit Secret and every cookie in the
   * world stops resolving, including their own.
   */
  const session: SessionConfig = {
    cookieName: opts.cookie.name,
    ttlDays: opts.cookie.ttlDays,
    secure: opts.cookie.secure,
    sameSite: opts.cookie.sameSite,
    partitioned: opts.cookie.partitioned,
    bindingSecret: opts.passphrase,
  };

  /**
   * The token config, built here for the reason the session config is.
   *
   * `bindingSecret` is the passphrase, so a token dies when the passphrase
   * changes, exactly as every cookie does. Built from `opts.passphrase` rather
   * than accepted from the caller, so src/server/index.ts cannot wire a value
   * that is merely plausible and quietly lose the property. See `tokenIdFor` in
   * ./api-token.ts for why that property is worth protecting this hard.
   *
   * `ttlDays` is only read at mint, which happens in scripts/mint-token.ts and
   * never in this file. It is here because one config type serves both halves,
   * and a second type differing by one field is a thing to keep in step.
   */
  const apiToken: ApiTokenConfig = {
    ttlDays: API_TOKEN_TTL_DAYS,
    bindingSecret: opts.passphrase,
  };

  const attempts = new SigninAttempts(opts.limits ?? DEFAULT_ATTEMPT_LIMIT, opts.clock);
  const ownerCfg: OwnerAuthConfig = { passphrase: opts.passphrase, session };
  const owner = new OwnerAuth(ownerCfg, opts.store, attempts, opts.clock, opts.sleep ?? realSleep, opts.log);

  /**
   * Resolve the session on a request, attach it, and slide the expiry.
   *
   * Returns false when there is nobody. Idempotent: a request the guard hook
   * already resolved is not read a second time, which is what keeps the hook
   * and `requireFounder` from costing two queries each.
   */
  async function resolve(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (request.founder !== undefined) return true;

    const raw = request.cookies[session.cookieName];
    const lookup = await readSession(opts.store, raw, session, opts.clock);
    if (lookup.ok) {
      request.founder = lookup.founder;
      request.lhSession = lookup.session;

      const moved = await slideSession(opts.store, lookup.session, session, opts.clock);
      if (moved !== null) {
        // The row and the cookie have to move together. A row saying 90 days
        // behind a cookie the browser dropped after 30 is a founder who is signed
        // in according to us and signed out according to their laptop.
        reply.setCookie(session.cookieName, raw ?? '', cookieOptionsFor(session));
      }
      return true;
    }

    return await resolveBearer(request);
  }

  /**
   * The second credential, tried only when the cookie did not answer.
   *
   * THE COOKIE IS TRIED FIRST AND THAT ORDER IS A DECISION. A request carrying
   * both is a browser, because the client this token exists for has no cookie
   * jar and sends none. Reading the cookie first means a stale Authorization
   * header left in a config file can never shadow a live session, and it keeps
   * the common path, which is every request the founder's own browser makes,
   * one lookup long.
   *
   * IT SETS NO `lhSession`, AND NOTHING NEEDS ONE. There is no session row
   * behind a token, so the field stays undefined. Checked rather than assumed:
   * nothing in src/ reads `request.lhSession`, and every route reaches the
   * founder through `founderOf`, which a bearer request satisfies identically.
   * `endSessionOn` reads the cookie, so signing out a token request is a no
   * operation, which is correct. A token is ended by revoking its row.
   *
   * THE PREFIX IS CHECKED BEFORE THE DATABASE IS, so an address that can never
   * accept a token never costs a lookup, and a live token gets the same answer
   * there as a made up one.
   *
   * THERE IS NO RATE LIMIT HERE, AND THAT IS DELIBERATE. ./rate-limit.ts slows
   * the passphrase down because a passphrase is chosen by a person and can be
   * guessed. A token is 32 random bytes, so guessing is not the threat model.
   * Worse, a per client limit on this path would hand a stranger a way to switch
   * the founder's Claude Desktop off: send rubbish until the limit trips, and
   * the real token starts being refused. The refusal is logged and nothing else.
   */
  async function resolveBearer(request: FastifyRequest): Promise<boolean> {
    const presented = bearerFrom(request.headers.authorization);
    if (presented === undefined) return false;

    const path = pathOf(request.url);
    if (!path.startsWith(MCP_API_PREFIX)) {
      opts.log.warn({ path }, 'refused a bearer token at an address that does not take one');
      return false;
    }

    const lookup = await readApiToken(opts.store, presented, apiToken, opts.clock);
    if (!lookup.ok) {
      // The reason is for whoever reads the log, never for whoever sent the
      // token. Every one of them answers with the same bytes: see
      // TOKEN_NOT_ACCEPTED above. The token itself is never logged.
      opts.log.warn({ path, reason: lookup.reason }, 'refused a bearer token');
      return false;
    }

    request.founder = lookup.founder;
    // At most one write an hour, and it never moves the expiry. A token does not
    // slide the way a session does: see API_TOKEN_TTL_DAYS in ./api-token.ts.
    await touchApiToken(opts.store, lookup.token, opts.clock);
    return true;
  }

  async function requireFounder(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (await resolve(request, reply)) return true;
    // Every reason WITHIN a credential ends at the same answer. Telling a caller
    // that a session id was unknown rather than expired tells them whether they
    // guessed one, and the same goes for a token. What `refusalFor` separates is
    // which credential was offered, which the caller already knows because they
    // sent it.
    reply.code(401);
    await reply.send(refusalFor(request));
    return false;
  }

  const context: AuthContext = {
    owner,
    cookieName: session.cookieName,
    requireFounder,
    founderOf(request: FastifyRequest): FounderRow {
      const founder = request.founder;
      if (founder === undefined) throw new NotSignedIn();
      return founder;
    },
    async endSessionOn(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      await endSession(opts.store, request.cookies[session.cookieName], session, opts.clock);
      reply.clearCookie(session.cookieName, { path: '/' });
    },
  };

  const register = async (app: FastifyInstance): Promise<void> => {
    await app.register(cookie, { secret: opts.cookieSecret });

    /**
     * Fastify parses JSON and nothing else. The sign in screen is a plain HTML
     * form so that it works with JavaScript off and before dist/web exists, and
     * a form posts urlencoded.
     */
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (err) {
          done(err instanceof Error ? err : new Error('form body could not be read'), undefined);
        }
      },
    );

    const html = (reply: FastifyReply, code: number, body: string): FastifyReply =>
      reply
        .code(code)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(body);

    /**
     * THE DOOR. Registered after the cookie plugin, so `request.cookies` is
     * parsed by the time it runs, and before any route, so it runs for all of
     * them including the ones that do not exist yet.
     *
     * The rules, in order, and each one is a decision:
     *
     *   /healthz always passes. A deployment with no passphrase set must still
     *   report its state to whatever is watching, and a deployment that fails
     *   its health check may never be promoted far enough for the founder to
     *   read the screen telling them what to set.
     *
     *   Nothing works while the passphrase is unusable. Not the app shell, not
     *   the API, not an empty sign in box. One screen, saying which Replit
     *   Secret to set.
     *
     *   /auth/ is the sign in surface itself and cannot require a session,
     *   because the person using it has not got one. It is the only prefix that
     *   is exempt, and PUBLIC_API_PATHS above is the only other way in.
     *
     *   Everything else under /api/ requires a founder. This is the line that
     *   makes a route that forgot to call requireFounder safe anyway. It also
     *   means a stranger probing for /api/files gets the same 401 as a stranger
     *   probing for a route that does not exist, which tells them nothing about
     *   what this app has.
     *
     *   A FOUNDER, NOT A SESSION, and the difference is one prefix wide.
     *   `resolve` accepts a session cookie anywhere and a bearer token only
     *   under MCP_API_PREFIX. Nothing else in this hook knows there are two
     *   credentials, which is the point: the rule below is still "prove you are
     *   the founder or you get nothing".
     *
     *   Everything else passes: the built browser bundle and its assets. They
     *   are our code, not the founder's work, and the bundle asks /api/me on
     *   load and paints the sign in screen when that answers 401.
     */
    app.addHook('onRequest', async (request, reply) => {
      const path = pathOf(request.url);
      if (path === '/healthz') return;

      const state = owner.readiness();
      if (!state.ready) {
        if (wantsHtml(request)) {
          return html(reply, 503, notSetUpPage(state.reason, MIN_PASSPHRASE_LENGTH));
        }
        reply.code(503);
        return await reply.send({
          error: 'not_set_up',
          message: 'This deployment has no usable OWNER_PASSPHRASE. Set it in Replit Secrets, then redeploy.',
        });
      }

      /**
       * Cross site writes, refused on the deployments that cannot use Lax.
       *
       * ABOVE the /auth/ exemption on purpose. Sign in and sign out are the two
       * routes most worth attacking and they live under that prefix, so a guard
       * placed below it would protect everything except them.
       *
       * Costs nothing and changes nothing where sameSite is 'lax', which is
       * every deployment and every laptop. There, the browser has already
       * withheld the cookie and this never fires.
       *
       * IT IS NOT EXTENDED TO THE BEARER TOKEN, AND THAT IS NOT AN OVERSIGHT.
       * Cross site request forgery is an attack on a credential the browser
       * attaches by itself: the whole trick is that the founder's own browser
       * sends the cookie to a page that asked it to. Nothing attaches an
       * Authorization header on anybody's behalf. A page that wanted to forge
       * one would have to already hold the token, and if it holds the token it
       * does not need a founder's browser to use it. So this guard has nothing
       * to say about the second credential, and a version of it that checked
       * Origin on token requests would refuse the desktop client, which sends
       * no Origin at all.
       */
      if (session.sameSite === 'none' && crossSiteWrite(request.method, request.headers.origin, request.headers.host)) {
        opts.log.warn(
          { path, method: request.method, origin: request.headers.origin },
          'refused a cross site write',
        );
        if (wantsHtml(request)) return html(reply, 403, CROSS_SITE_PAGE);
        reply.code(403);
        return await reply.send({
          error: 'cross_site',
          message: 'That request came from another site and was not carried out.',
        });
      }

      if (path.startsWith('/auth/')) return;
      if (!path.startsWith('/api/')) return;
      if (PUBLIC_API_PATHS.includes(path)) return;

      if (await resolve(request, reply)) return;

      // Always JSON. Everything that reaches this line is under /api/, which is
      // fetched by the browser bundle, and the bundle reads a 401 here as "not
      // signed in" and paints the sign in screen itself. A page of HTML arriving
      // where JSON was expected is reported as a parse error that has nothing to
      // do with the real cause.
      reply.code(401);
      return await reply.send(refusalFor(request));
    });

    /**
     * The sign in screen.
     *
     * IT TOUCHES THE DATABASE ON NO PATH, and that is deliberate rather than
     * incidental. This is the one page that has to render when everything else
     * is broken. Resolving the session here to redirect somebody who is already
     * signed in would be a small courtesy that turns a deployment with an
     * unreachable database into a 500 on the only screen anybody can reach.
     */
    app.get('/auth/signin', async (request, reply) => {
      const q = request.query as { notice?: unknown };
      const notice = asSignInNotice(q.notice);
      return html(reply, 200, notice === null ? signInPage() : signInPage({ notice }));
    });

    /**
     * The one button.
     *
     * `request.ip` is the client key for the per client limit, and it is used
     * and never stored: there is no column for a client address anywhere in the
     * schema. On this deployment it comes from X-Forwarded-For, which whoever
     * is calling gets to write, so ./rate-limit.ts treats it as the weaker half
     * of the defence and says so.
     */
    app.post('/auth/signin', async (request, reply) => {
      const body = request.body as { passphrase?: unknown } | undefined;
      const typed = typeof body?.passphrase === 'string' ? body.passphrase : '';
      const outcome = await owner.signIn(typed, request.ip);

      if (outcome.kind === 'refused') {
        switch (outcome.reason) {
          case 'too_many_tries':
            reply.header('retry-after', String(Math.ceil(outcome.retryAfterMs / 1000)));
            return html(reply, 429, tooManyTriesPage(outcome.retryAfterMs));
          case 'account_closed':
            return html(reply, 403, signInPage({ notice: 'account_closed' }));
          case 'not_set_up': {
            // The hook answers this first in practice. Handled anyway, because
            // "cannot happen" is how a blank screen gets shipped.
            const state = owner.readiness();
            const reason = state.ready ? 'missing' : state.reason;
            return html(reply, 503, notSetUpPage(reason, MIN_PASSPHRASE_LENGTH));
          }
          case 'wrong_passphrase':
            return html(reply, 401, signInPage({ notice: 'wrong_passphrase' }));
        }
      }

      reply.setCookie(session.cookieName, outcome.minted.cookieValue, outcome.minted.cookieOptions);
      // 303 so the browser follows with a GET. A 302 after a POST leaves some
      // clients repeating the POST.
      return reply.code(303).header('location', '/').send();
    });

    /**
     * Sign out, on this device only.
     *
     * Not guarded, on purpose: signing out without a session is harmless and
     * idempotent, and a 401 here would leave somebody holding a cookie we no
     * longer recognise with no way to throw it away. A cross site POST cannot
     * reach it in any case, because the cookie is SameSite=Lax and is not sent.
     */
    app.post('/auth/signout', async (request, reply) => {
      await context.endSessionOn(request, reply);
      return reply.code(303).header('location', '/auth/signin?notice=signed_out').send();
    });

    /**
     * Sign out, for the browser bundle, which cannot follow a 303 into a page.
     *
     * WHY IT LIVES HERE AND NOT IN ../routes/auth-api.ts. That file existed
     * because the bundle posted JSON at three addresses the form routes did not
     * have, and the two halves drifted until one of them answered 404 on a
     * founder's screen. Two of the three are gone with the magic link. Keeping
     * the last one next to the form route it mirrors, in the module that owns
     * the cookie, is what stops that happening again: they are eight lines
     * apart and they call the same method.
     *
     * IT COULD NOT LIVE THERE ANY MORE IN ANY CASE. The old version found the
     * cookie by hashing every cookie on the request and comparing it against
     * the session id. The session id is derived from the cookie AND the
     * passphrase now, so that comparison cannot be made outside this folder
     * without handing the passphrase to the routes layer.
     */
    app.post('/api/auth/sign-out', async (request, reply) => {
      if (!(await requireFounder(request, reply))) return reply;
      // The row is what matters. Revoking it is what makes the next request
      // 401, whatever the browser still holds. Clearing the cookie is tidiness
      // on top of that, and endSessionOn does them in that order.
      await context.endSessionOn(request, reply);
      return reply.code(204).send();
    });

    /** Who am I. The browser calls this on load to decide which screen to paint. */
    app.get('/api/me', async (request, reply) => {
      if (!(await requireFounder(request, reply))) return reply;
      const founder = context.founderOf(request);
      return reply.send({
        id: founder.id,
        displayName: founder.displayName,
        timezone: founder.timezone,
        track: founder.track,
      });
    });
  };

  return { register, context };
}
