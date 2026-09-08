/**
 * src/server/auth/plugin.test.ts
 *
 * WHAT THIS IS. Sign in driven over HTTP, through a real Fastify instance, the
 * way a browser and a stranger with the URL drive it.
 *
 * WHY IT EXISTS. ./owner.test.ts proves the flow. This proves the wiring, which
 * is where the failures that reach a founder actually live: a form body Fastify
 * cannot parse, a cookie that is never sent back, a route that forgot to ask
 * who was calling.
 *
 * THE TEST THAT MATTERS MOST IS "THE DOOR IS SHUT FOR A ROUTE THAT NEVER ASKED
 * FOR ONE". The harness registers a route that reads like every route somebody
 * will add in a hurry in the next nine days: it answers with founder content
 * and it never calls requireFounder. A stranger holding nothing must still be
 * refused. If that test goes green because the hook was removed, the app is
 * open on a public web address and nothing else in this file would notice.
 *
 * IT BUILDS ITS OWN FASTIFY INSTANCE rather than using ../routes/test-fixtures.ts.
 * The point of this module is that it works when the rest of the app does not,
 * and a harness that pulls in the whole route table cannot show that.
 *
 * WHAT IT CALLS. The auth routes, against the in memory store.
 * WHAT IT READS AND WRITES. Nothing outside the process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';

import { API_TOKEN_PREFIX, API_TOKEN_TTL_DAYS, mintApiToken } from './api-token.ts';
import { bearerFrom, createAuth, crossSiteWrite, MCP_API_PREFIX, type AuthContext } from './plugin.ts';
import { DEFAULT_ATTEMPT_LIMIT } from './rate-limit.ts';
import {
  MemoryAuthStore,
  RecordingSleep,
  TEST_PASSPHRASE,
  TestClock,
  TestLogger,
} from './test-fixtures.ts';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const BROWSER = { accept: 'text/html,application/xhtml+xml' };
const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

/** The founder content a route would answer with. Nothing may reach it without a session. */
const PRIVATE_BODY = 'the founder own customer list';

interface Harness {
  readonly app: FastifyInstance;
  readonly store: MemoryAuthStore;
  readonly auth: AuthContext;
  readonly clock: TestClock;
  readonly sleep: RecordingSleep;
  readonly log: TestLogger;
}

async function harness(
  opts: { passphrase?: string; embedded?: boolean } = {},
): Promise<Harness> {
  const store = new MemoryAuthStore();
  const clock = new TestClock();
  const sleep = new RecordingSleep();
  const log = new TestLogger();
  const app = Fastify({ logger: false });

  const { register, context } = createAuth({
    store,
    clock,
    log,
    passphrase: opts.passphrase ?? TEST_PASSPHRASE,
    // secure false, because a laptop on http would never be sent a Secure
    // cookie back and the developer would conclude sign in is broken.
    cookie: {
      name: 'lh_session',
      ttlDays: 90,
      // The preview is always https, and None and Partitioned are both refused
      // by browsers without Secure, so the embedded harness has to be honest
      // about that or it proves a combination nobody can actually receive.
      secure: opts.embedded === true,
      // The workspace preview, where Lax cannot be used and the Origin guard is
      // therefore the only thing standing in for it.
      sameSite: opts.embedded === true ? 'none' : 'lax',
      partitioned: opts.embedded === true,
    },
    sleep: sleep.fn,
    cookieSecret: 'c'.repeat(32),
  });
  await register(app);

  /**
   * A route that FORGOT to call requireFounder, written on purpose.
   *
   * This is what a route added in a hurry looks like. The guard hook is what
   * makes it safe anyway, and this is the only way to prove the hook is doing
   * that rather than the route being polite.
   */
  app.get('/api/files/notes.md', async (_request, reply) => reply.send({ body: PRIVATE_BODY }));

  /**
   * A route under the prefix where a bearer token is accepted, and it forgot to
   * call requireFounder too.
   *
   * The same trick as the route above, on the other credential. Nothing may
   * reach it without a founder, and the hook is what makes that true rather than
   * the route being careful.
   */
  app.get('/api/mcp/notes.md', async (_request, reply) => reply.send({ body: PRIVATE_BODY }));

  // The health check, which has to answer even on a deployment nobody can sign
  // in to, or the container is never promoted far enough to show the screen
  // saying what to set.
  app.get('/healthz', async (_request, reply) => reply.send({ ok: true }));

  await app.ready();
  return { app, store, auth: context, clock, sleep, log };
}

async function signIn(h: Harness, passphrase = TEST_PASSPHRASE): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/auth/signin',
    headers: FORM,
    payload: form({ passphrase }),
  });
  assert.equal(res.statusCode, 303, 'sign in should have succeeded');
  const cookie = res.cookies.find((c) => c.name === 'lh_session');
  assert.ok(cookie !== undefined, 'no session cookie was set');
  return cookie.value;
}

/**
 * A live token for the owner of this harness, and the value that presents it.
 *
 * It signs in first, because a token hangs off a founder row and a harness that
 * has never been claimed has none. That is the same order the real thing runs
 * in: scripts/mint-token.ts refuses on a deployment nobody has signed in to.
 */
async function mint(h: Harness, label = 'claude desktop, mac'): Promise<string> {
  await signIn(h);
  const owner = await h.store.findOwner();
  assert.ok(owner !== null, 'signing in should have claimed the deployment');
  const minted = mintApiToken(owner.id, label, { ttlDays: API_TOKEN_TTL_DAYS, bindingSecret: TEST_PASSPHRASE }, h.clock);
  await h.store.insertApiToken(minted.row);
  return minted.value;
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

// ------------------------------------------------------------- the screen

test('THE SIGN IN SCREEN ANSWERS THE QUESTION SOMEBODY IS ABOUT TO ASK A MENTOR', async () => {
  const h = await harness();
  const res = await h.app.inject({ method: 'GET', url: '/auth/signin', headers: BROWSER });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/html/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.body, /There is no account to make/);
  assert.match(res.body, /OWNER_PASSPHRASE/);
  assert.match(res.body, /<form method="POST" action="\/auth\/signin">/);
  // No stylesheet, no font, no script from another host. A venue network with a
  // captive portal serves a founder an unstyled page they do not trust.
  assert.doesNotMatch(res.body, /https?:\/\//);
  await h.app.close();
});

test('THE MAGIC LINK ROUTES ARE GONE, NOT LEFT ANSWERING', async () => {
  const h = await harness();
  for (const [method, url] of [
    ['GET', '/auth/verify?t=anything'],
    ['POST', '/auth/verify'],
    ['GET', '/auth/code'],
    ['POST', '/auth/code'],
    ['POST', '/auth/request'],
    ['POST', '/auth/help'],
  ] as const) {
    const res = await h.app.inject({ method, url, headers: FORM, payload: '' });
    assert.equal(res.statusCode, 404, `${method} ${url} still answers`);
  }
  await h.app.close();
});

// -------------------------------------------------------------- signing in

test('THE RIGHT PASSPHRASE SETS A COOKIE THE BROWSER WILL KEEP, AND THE COOKIE IS NOT THE ROW', async () => {
  const h = await harness();
  const res = await h.app.inject({
    method: 'POST',
    url: '/auth/signin',
    headers: FORM,
    payload: form({ passphrase: TEST_PASSPHRASE }),
  });

  // 303, so the browser follows with a GET. A 302 after a POST leaves some
  // clients repeating the POST.
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, '/');

  const cookie = res.cookies.find((c) => c.name === 'lh_session');
  assert.ok(cookie !== undefined);
  assert.equal(cookie.httpOnly, true, 'script on the page must not be able to read it');
  assert.equal(cookie.sameSite?.toLowerCase(), 'lax');
  assert.equal(cookie.path, '/');

  const rows = [...h.store.sessions.keys()];
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0], cookie.value, 'the row is a hash, so a leaked row is not a live session');
  await h.app.close();
});

test('A WRONG PASSPHRASE SETS NOTHING AND SAYS SO WITHOUT SAYING WHICH PART WAS WRONG', async () => {
  const h = await harness();
  const res = await h.app.inject({
    method: 'POST',
    url: '/auth/signin',
    headers: { ...FORM, ...BROWSER },
    payload: form({ passphrase: 'not the passphrase' }),
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.cookies.length, 0, 'nothing is set on a refusal');
  assert.match(res.body, /That passphrase is not right/);
  assert.equal(h.store.founders.size, 0, 'and a wrong guess does not claim the deployment');
  await h.app.close();
});

test('A FORM WITH NO PASSPHRASE FIELD AT ALL IS A REFUSAL, NOT A CRASH', async () => {
  const h = await harness();
  for (const payload of ['', form({}), form({ passphrase: '' }), form({ something: 'else' })]) {
    const res = await h.app.inject({ method: 'POST', url: '/auth/signin', headers: FORM, payload });
    assert.equal(res.statusCode, 401, JSON.stringify(payload));
  }
  await h.app.close();
});

test('THE COOKIE IS ACCEPTED ON THE NEXT REQUEST, AND SAYS WHO IT IS', async () => {
  const h = await harness();
  const cookie = await signIn(h);
  const me = await h.app.inject({ method: 'GET', url: '/api/me', cookies: { lh_session: cookie } });
  assert.equal(me.statusCode, 200);
  const body = me.json<{ id: string; displayName: string | null; timezone: string }>();
  assert.match(body.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(body.displayName, null, 'so the browser sends them to the first run screen');
  await h.app.close();
});

// ------------------------------------------------------------------ the door

test('A ROUTE THAT FORGOT TO ASK WHO WAS CALLING IS STILL SHUT TO A STRANGER', async () => {
  const h = await harness();

  // Nothing at all.
  const bare = await h.app.inject({ method: 'GET', url: '/api/files/notes.md' });
  assert.equal(bare.statusCode, 401);
  assert.doesNotMatch(bare.body, new RegExp(PRIVATE_BODY));

  // A guessed cookie.
  const guessed = await h.app.inject({
    method: 'GET',
    url: '/api/files/notes.md',
    cookies: { lh_session: 'a'.repeat(43) },
  });
  assert.equal(guessed.statusCode, 401);
  assert.doesNotMatch(guessed.body, new RegExp(PRIVATE_BODY));

  // A cookie under the wrong name.
  const wrongName = await h.app.inject({
    method: 'GET',
    url: '/api/files/notes.md',
    cookies: { session: 'anything' },
  });
  assert.equal(wrongName.statusCode, 401);

  // And the founder gets in, so the guard is refusing rather than broken.
  const cookie = await signIn(h);
  const allowed = await h.app.inject({
    method: 'GET',
    url: '/api/files/notes.md',
    cookies: { lh_session: cookie },
  });
  assert.equal(allowed.statusCode, 200);
  assert.match(allowed.body, new RegExp(PRIVATE_BODY));
  await h.app.close();
});

test('A PROBE FOR A ROUTE THAT DOES NOT EXIST LEARNS NOTHING ABOUT WHAT THIS APP HAS', async () => {
  const h = await harness();
  const real = await h.app.inject({ method: 'GET', url: '/api/files/notes.md' });
  const invented = await h.app.inject({ method: 'GET', url: '/api/there-is-no-such-thing' });
  assert.equal(real.statusCode, invented.statusCode);
  assert.equal(real.body, invented.body);
  await h.app.close();
});

test('THE SIGN IN SURFACE ITSELF IS REACHABLE WITHOUT A SESSION, BECAUSE NOBODY HAS ONE YET', async () => {
  const h = await harness();
  assert.equal((await h.app.inject({ method: 'GET', url: '/auth/signin' })).statusCode, 200);
  assert.equal(
    (await h.app.inject({ method: 'POST', url: '/auth/signin', headers: FORM, payload: form({ passphrase: 'x' }) }))
      .statusCode,
    401,
    'the form route answers rather than being refused by the guard',
  );
  await h.app.close();
});

test('THERE IS NO PUBLIC JSON SIGN IN SURFACE LEFT UNDER /api/', async () => {
  // /api/auth/ used to be exempt from the guard as a whole namespace, because
  // signing in was a JSON call. It is a form post now, so the exemption is gone
  // and nothing under /api/ is reachable without a session.
  const h = await harness();
  for (const url of ['/api/auth/sign-in', '/api/auth/request-link', '/api/auth/mentor-note', '/api/auth/sign-out']) {
    const res = await h.app.inject({ method: 'POST', url, payload: {} });
    assert.equal(res.statusCode, 401, url);
  }
  await h.app.close();
});

test('THE BUNDLE CAN SIGN OUT WITH JSON, AND IT ENDS THE SAME SESSION THE FORM WOULD', async () => {
  const h = await harness();
  const cookie = await signIn(h);

  const out = await h.app.inject({
    method: 'POST',
    url: '/api/auth/sign-out',
    payload: {},
    cookies: { lh_session: cookie },
  });
  assert.equal(out.statusCode, 204);

  const after = await h.app.inject({ method: 'GET', url: '/api/me', cookies: { lh_session: cookie } });
  assert.equal(after.statusCode, 401, 'the row is revoked, not only the cookie cleared');

  // The other device is untouched, because sessions are per device.
  const phone = await signIn(h);
  await h.app.inject({ method: 'POST', url: '/api/auth/sign-out', payload: {}, cookies: { lh_session: phone } });
  assert.equal(h.store.sessions.size, 2, 'both rows are still there, one of them revoked');
  await h.app.close();
});

// ----------------------------------------------------------------- signing out

test('SIGNING OUT ENDS THE SESSION ON THE SERVER, NOT ONLY IN THE BROWSER', async () => {
  const h = await harness();
  const cookie = await signIn(h);

  const out = await h.app.inject({ method: 'POST', url: '/auth/signout', cookies: { lh_session: cookie } });
  assert.equal(out.statusCode, 303);
  assert.equal(out.headers.location, '/auth/signin?notice=signed_out');

  // The row is what matters. Clearing the cookie is tidiness on top of it.
  const after = await h.app.inject({ method: 'GET', url: '/api/me', cookies: { lh_session: cookie } });
  assert.equal(after.statusCode, 401, 'the cookie is dead even if the browser kept it');
  await h.app.close();
});

test('SIGNING OUT WITH NO SESSION IS HARMLESS, SO NOBODY IS EVER STUCK HOLDING A DEAD COOKIE', async () => {
  const h = await harness();
  const res = await h.app.inject({ method: 'POST', url: '/auth/signout' });
  assert.equal(res.statusCode, 303);
  await h.app.close();
});

// ------------------------------------------------------- the unconfigured state

test('WITH NO PASSPHRASE SET, NOTHING IS SERVED EXCEPT THE SCREEN SAYING WHAT TO SET', async () => {
  const h = await harness({ passphrase: '' });

  // A browser gets the screen, on every address it might have landed on,
  // including the ones the single page app owns.
  for (const url of ['/', '/auth/signin', '/some/spa/route']) {
    const res = await h.app.inject({ method: 'GET', url, headers: BROWSER });
    assert.equal(res.statusCode, 503, url);
    assert.match(res.body, /This app has no passphrase yet/, url);
    assert.match(res.body, /OWNER_PASSPHRASE/, url);
  }

  // Everything under /api is JSON whatever it asks for, because the browser
  // bundle fetches it and a page of HTML arriving where JSON was expected is
  // reported as a parse error that has nothing to do with the real cause.
  for (const url of ['/api/me', '/api/files/notes.md']) {
    const res = await h.app.inject({ method: 'GET', url, headers: BROWSER });
    assert.equal(res.statusCode, 503, url);
    assert.equal(res.json<{ error: string }>().error, 'not_set_up', url);
    assert.doesNotMatch(res.body, new RegExp(PRIVATE_BODY), url);
  }

  // And the correct passphrase does not get in either, because there is not one.
  const tried = await h.app.inject({
    method: 'POST',
    url: '/auth/signin',
    headers: { ...FORM, ...BROWSER },
    payload: form({ passphrase: TEST_PASSPHRASE }),
  });
  assert.equal(tried.statusCode, 503);
  assert.equal(h.store.sessions.size, 0);

  // The health check still answers, or the container is never promoted far
  // enough for anybody to read the screen above.
  const health = await h.app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(health.statusCode, 200);
  await h.app.close();
});

test('A PASSPHRASE THAT IS TOO SHORT IS THE SAME REFUSAL, WITH ITS OWN SENTENCE', async () => {
  const h = await harness({ passphrase: 'atlanta' });
  const res = await h.app.inject({ method: 'GET', url: '/auth/signin', headers: BROWSER });
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /The passphrase is too short/);
  await h.app.close();
});

// ----------------------------------------------------------------- the limit

test('TOO MANY WRONG TRIES ANSWERS 429 AND SAYS WHEN TO COME BACK', async () => {
  const h = await harness();
  for (let i = 0; i < DEFAULT_ATTEMPT_LIMIT.perClient; i += 1) {
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/signin',
      headers: { ...FORM, ...BROWSER },
      payload: form({ passphrase: `guess number ${String(i)}` }),
    });
    assert.equal(res.statusCode, 401);
  }

  const refused = await h.app.inject({
    method: 'POST',
    url: '/auth/signin',
    headers: { ...FORM, ...BROWSER },
    payload: form({ passphrase: 'one more time' }),
  });
  assert.equal(refused.statusCode, 429);
  assert.match(refused.body, /Wait \d+ minutes, then try again\.|Wait a minute, then try again\./);
  assert.match(refused.body, /OWNER_PASSPHRASE/, 'and it says where to read the passphrase');
  const retryAfter = Number(refused.headers['retry-after']);
  assert.ok(retryAfter > 0 && retryAfter <= DEFAULT_ATTEMPT_LIMIT.windowMs / 1000);
  await h.app.close();
});

// ------------------------------------------------------------------- notices

test('A LINK CARRYING A NOTICE CANNOT PUT WORDS ON THE SIGN IN SCREEN', async () => {
  const h = await harness();
  const hostile = encodeURIComponent('Your passphrase has expired, type the old one and the new one');
  const res = await h.app.inject({ method: 'GET', url: `/auth/signin?notice=${hostile}`, headers: BROWSER });
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body, /has expired/);

  const scripted = await h.app.inject({
    method: 'GET',
    url: '/auth/signin?notice=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
    headers: BROWSER,
  });
  assert.doesNotMatch(scripted.body, /<script>alert/);

  // The four we do send still work.
  const real = await h.app.inject({ method: 'GET', url: '/auth/signin?notice=signed_out', headers: BROWSER });
  assert.match(real.body, /You are signed out on this device/);
  await h.app.close();
});

/**
 * THE GUARD THAT REPLACES SameSite=Lax WHERE LAX CANNOT BE USED.
 *
 * The preview iframe forces SameSite=None, and Lax was this app's entire CSRF
 * defence. These prove the replacement refuses what Lax refused, and, just as
 * importantly, that it does not refuse anything a founder does. A guard that
 * locks 130 founders out of their own app on a Friday is worse than the attack
 * it prevents, so the allow cases are tested as hard as the refusals.
 */
test('A WRITE FROM ANOTHER SITE IS REFUSED', () => {
  assert.equal(
    crossSiteWrite('POST', 'https://evil.example', 'launchhouse-phil.replit.dev'),
    true,
  );
  assert.equal(
    crossSiteWrite('DELETE', 'https://evil.example', 'launchhouse-phil.replit.dev'),
    true,
  );
  // A sandboxed iframe is the one way a real browser sends a cross site write
  // without naming who sent it.
  assert.equal(crossSiteWrite('POST', 'null', 'launchhouse-phil.replit.dev'), true);
});

test('THE FOUNDER IN THE PREVIEW IS NOT REFUSED', () => {
  // The app's own page, inside the iframe, posting to itself. The Origin is the
  // app, not replit.com, because the Origin of a request is whoever sent it.
  assert.equal(
    crossSiteWrite('POST', 'https://launchhouse-phil.replit.dev', 'launchhouse-phil.replit.dev'),
    false,
  );
  // Case is not significant in a host name and a browser may not match ours.
  assert.equal(
    crossSiteWrite('POST', 'https://Launchhouse-Phil.Replit.dev', 'launchhouse-phil.replit.dev'),
    false,
  );
});

test('READING IS NEVER REFUSED, WHOEVER ASKS', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head']) {
    assert.equal(crossSiteWrite(method, 'https://evil.example', 'app.replit.dev'), false, method);
  }
});

test('A REQUEST WITH NO ORIGIN IS ALLOWED, BECAUSE CSRF NEEDS A BROWSER', () => {
  // Browsers send Origin on every POST. No Origin means a script, a probe, a
  // health check or the test client, and none of those is a founder's browser
  // being used against them. Refusing here buys nothing and breaks tooling.
  assert.equal(crossSiteWrite('POST', undefined, 'app.replit.dev'), false);
  assert.equal(crossSiteWrite('POST', '', 'app.replit.dev'), false);
});

test('AN UNREADABLE HOST OR ORIGIN FAILS OPEN RATHER THAN LOCKING ANYBODY OUT', () => {
  assert.equal(crossSiteWrite('POST', 'http://[', 'app.replit.dev'), false, 'unparseable origin');
  assert.equal(crossSiteWrite('POST', 'https://app.replit.dev', undefined), false, 'no host header');
  assert.equal(crossSiteWrite('POST', 'https://app.replit.dev', ''), false, 'empty host header');
});

/**
 * The guard, through the whole stack rather than as arithmetic.
 *
 * The function above is pure and easy to get right. The wiring is where this
 * would actually fail: a guard placed below the /auth/ exemption protects
 * everything except the two routes most worth attacking.
 */
test('THE ORIGIN GUARD RUNS, AND IT COVERS SIGN IN AND SIGN OUT TOO', async () => {
  const h = await harness({ embedded: true });

  for (const url of ['/auth/signin', '/auth/signout']) {
    const res = await h.app.inject({
      method: 'POST',
      url,
      headers: { ...FORM, origin: 'https://evil.example', host: 'app.replit.dev' },
      payload: form({ passphrase: TEST_PASSPHRASE }),
    });
    assert.equal(res.statusCode, 403, `${url} was reachable from another site`);
    assert.equal(
      res.cookies.find((c) => c.name === 'lh_session' && c.value !== ''),
      undefined,
      `${url} handed a session to another site`,
    );
  }
});

test('AND THE SAME REQUEST FROM THE APP ITSELF STILL SIGNS SOMEBODY IN', async () => {
  const h = await harness({ embedded: true });
  const res = await h.app.inject({
    method: 'POST',
    url: '/auth/signin',
    headers: { ...FORM, origin: 'https://app.replit.dev', host: 'app.replit.dev' },
    payload: form({ passphrase: TEST_PASSPHRASE }),
  });
  assert.equal(res.statusCode, 303, 'a founder in the preview was refused by our own guard');

  const cookie = res.cookies.find((c) => c.name === 'lh_session');
  assert.ok(cookie !== undefined, 'no session cookie was set');

  /**
   * THE RAW HEADER, not the parsed object.
   *
   * These three attributes are only accepted together, and a browser that
   * dislikes the combination drops the cookie without saying anything. There is
   * no error to catch and no log line to find. There is only a founder who
   * cannot stay signed in, which is the bug this whole change exists to fix, so
   * the wire format is asserted rather than assumed.
   */
  const header = res.headers['set-cookie'];
  const raw = Array.isArray(header) ? header.join('\n') : String(header);
  assert.match(raw, /SameSite=None/i, 'the preview iframe cannot send a Lax cookie');
  assert.match(raw, /Partitioned/i, 'without this, any site could embed the app and use the session');
  assert.match(raw, /Secure/i, 'None and Partitioned are both refused without Secure');
  assert.match(raw, /HttpOnly/i, 'still unreachable from a script');
});

test('ON EVERY OTHER DEPLOYMENT THE GUARD IS INERT, BECAUSE LAX ALREADY REFUSED', async () => {
  const h = await harness();
  const res = await h.app.inject({
    method: 'POST',
    url: '/auth/signin',
    headers: { ...FORM, origin: 'https://evil.example', host: 'app.replit.app' },
    payload: form({ passphrase: TEST_PASSPHRASE }),
  });
  // Not 403. The browser never sent the cookie in the first place, and adding a
  // second refusal here would change behaviour nobody asked to change.
  assert.equal(res.statusCode, 303);
});

// --------------------------------------------------------- the second credential

/**
 * The mirror of "A ROUTE THAT FORGOT TO ASK WHO WAS CALLING IS STILL SHUT", on
 * the other credential. If this goes green because the bearer path was removed,
 * the MCP endpoint is unreachable. If the one below it goes green because the
 * prefix test was removed, a leaked token reaches the whole API.
 */
test('A LIVE TOKEN IS THE FOUNDER UNDER THE MCP PREFIX, AND NOTHING ELSE IS', async () => {
  const h = await harness();
  const token = await mint(h);

  const allowed = await h.app.inject({ method: 'GET', url: '/api/mcp/notes.md', headers: bearer(token) });
  assert.equal(allowed.statusCode, 200);
  assert.match(allowed.body, new RegExp(PRIVATE_BODY));

  // Nothing at all, at the same address.
  const bare = await h.app.inject({ method: 'GET', url: '/api/mcp/notes.md' });
  assert.equal(bare.statusCode, 401);
  assert.doesNotMatch(bare.body, new RegExp(PRIVATE_BODY));
  await h.app.close();
});

test('THE SAME LIVE TOKEN IS REFUSED OUTSIDE THE PREFIX, WHICH IS THE WHOLE POINT OF HAVING ONE', async () => {
  const h = await harness();
  const token = await mint(h);

  const outside = await h.app.inject({ method: 'GET', url: '/api/files/notes.md', headers: bearer(token) });
  assert.equal(outside.statusCode, 401);
  assert.doesNotMatch(outside.body, new RegExp(PRIVATE_BODY));
  assert.equal(JSON.parse(outside.body).error, 'token_wrong_address');

  // And it is refused for being at the wrong address rather than for being a bad
  // token, so a founder is not sent to mint another one that fails the same way.
  assert.doesNotMatch(outside.body, /token:mint/);
  await h.app.close();
});

test('A TOKEN AT THE WRONG ADDRESS READS THE SAME WHETHER IT IS REAL OR INVENTED', async () => {
  const h = await harness();
  const real = await mint(h);
  const invented = `${API_TOKEN_PREFIX}${'z'.repeat(43)}`;

  const a = await h.app.inject({ method: 'GET', url: '/api/files/notes.md', headers: bearer(real) });
  const b = await h.app.inject({ method: 'GET', url: '/api/files/notes.md', headers: bearer(invented) });
  assert.equal(a.statusCode, b.statusCode);
  assert.equal(a.body, b.body);
  await h.app.close();
});

test('EVERY WAY A TOKEN FAILS READS IDENTICALLY, so nobody learns they guessed a real one', async () => {
  const h = await harness();

  // Three tokens, each broken a different way, all minted for the real owner so
  // the only difference between them is the reason they fail.
  const revoked = await mint(h, 'revoked');
  const expired = await mint(h, 'expired');
  const live = await mint(h, 'live');

  for (const [id, row] of h.store.apiTokens) {
    if (row.label === 'revoked') await h.store.revokeApiToken(id, h.clock.now());
  }

  // The live one works, so the refusals below are refusals rather than the whole
  // bearer path being broken.
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/mcp/notes.md', headers: bearer(live) })).statusCode, 200);

  const ask = async (token: string) =>
    h.app.inject({ method: 'GET', url: '/api/mcp/notes.md', headers: bearer(token) });

  // The shape every one of them must take, from a value that is certainly unknown.
  const reference = await ask(`${API_TOKEN_PREFIX}${'y'.repeat(43)}`);
  assert.equal(reference.statusCode, 401);
  assert.equal(JSON.parse(reference.body).error, 'token_not_accepted');

  // `malformed` is a value with no space in it, so the header parse hands it on
  // and the SHAPE test is what refuses it. A value containing a space never gets
  // this far: bearerFrom reads the header as malformed and the request reads as
  // carrying no credential at all, which is a different sentence and is right.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['not-a-token', 'malformed'],
    [`${API_TOKEN_PREFIX}${'z'.repeat(43)}`, 'unknown'],
    [revoked, 'revoked'],
  ];

  // A for loop rather than a table runner, because node:test has no it.each and
  // a failure still has to name which case it was.
  for (const [value, why] of cases) {
    const res = await ask(value);
    assert.equal(res.statusCode, 401, why);
    assert.equal(res.body, reference.body, `${why} does not read like every other refusal`);
  }

  // Expiry, which needs the clock moved rather than a different value.
  h.clock.advance(API_TOKEN_TTL_DAYS * 86_400_000 + 1);
  const stale = await ask(expired);
  assert.equal(stale.statusCode, 401);
  assert.equal(stale.body, reference.body, 'an expired token does not read like an unknown one');
  await h.app.close();
});

test('THE REFUSAL NAMES THE FIX, because both ways a token dies are silent', async () => {
  const h = await harness();
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/mcp/notes.md',
    headers: bearer(`${API_TOKEN_PREFIX}${'z'.repeat(43)}`),
  });
  const body = JSON.parse(res.body) as { message: string };
  assert.match(body.message, /expired or unknown/);
  assert.match(body.message, /token:mint/, 'a founder should not have to read code to know what to do');
  assert.match(body.message, /OWNER_PASSPHRASE/, 'the other silent death is not mentioned');
});

test('A REQUEST WITH NO CREDENTIAL AT ALL STILL GETS THE SENTENCE THE BUNDLE PAINTS', async () => {
  const h = await harness();
  for (const url of ['/api/files/notes.md', '/api/mcp/notes.md']) {
    const res = await h.app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'not_signed_in', url);
  }
  await h.app.close();
});

test('A CHANGED PASSPHRASE REFUSES THE TOKEN, THE WAY IT SIGNS EVERY DEVICE OUT', async () => {
  const h = await harness();
  const token = await mint(h);
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/mcp/notes.md', headers: bearer(token) })).statusCode, 200);

  // The Replit Secret is edited and the app redeployed. Same store, same rows.
  const after = await harness({ passphrase: 'a different passphrase entirely' });
  after.store.apiTokens.set([...h.store.apiTokens.keys()][0] ?? '', [...h.store.apiTokens.values()][0]!);
  for (const [id, row] of h.store.founders) after.store.founders.set(id, row);

  const res = await after.app.inject({ method: 'GET', url: '/api/mcp/notes.md', headers: bearer(token) });
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error, 'token_not_accepted');
  await h.app.close();
  await after.app.close();
});

// --------------------------------------------------- the header, and precedence

test('THE AUTHORIZATION HEADER IS READ STRICTLY, AND EVERY REFUSAL IS FREE', () => {
  const good = `${API_TOKEN_PREFIX}${'z'.repeat(43)}`;
  const cases: ReadonlyArray<readonly [string | undefined, string | undefined, string]> = [
    [`Bearer ${good}`, good, 'the ordinary shape'],
    [`bearer ${good}`, good, 'the scheme is case insensitive per RFC 7235'],
    [`BEARER ${good}`, good, 'upper case scheme'],
    [undefined, undefined, 'no header at all'],
    ['', undefined, 'an empty header'],
    [`Basic ${good}`, undefined, 'the wrong scheme'],
    [`Token ${good}`, undefined, 'a scheme this app does not use'],
    ['Bearer', undefined, 'the scheme with no value'],
    [`Bearer  ${good}`, undefined, 'two spaces'],
    [`Bearer ${good} `, undefined, 'a trailing space from a copy and paste'],
    [`Bearer ${good} extra`, undefined, 'a second word'],
    [good, undefined, 'the bare token with no scheme'],
  ];
  for (const [header, expected, why] of cases) {
    assert.equal(bearerFrom(header), expected, `${JSON.stringify(header)} is ${why}`);
  }
});

test('A LIVE COOKIE WINS OVER A RUBBISH HEADER, so a stale config cannot sign the founder out', async () => {
  const h = await harness();
  const cookie = await signIn(h);
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/files/notes.md',
    cookies: { lh_session: cookie },
    headers: bearer('not-a-token-at-all'),
  });
  assert.equal(res.statusCode, 200);
  await h.app.close();
});

test('A LIVE TOKEN STILL WORKS ALONGSIDE A DEAD COOKIE', async () => {
  const h = await harness();
  const token = await mint(h);
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/mcp/notes.md',
    cookies: { lh_session: 'a'.repeat(43) },
    headers: bearer(token),
  });
  assert.equal(res.statusCode, 200);
  await h.app.close();
});

test('A TOKEN REQUEST CARRIES NO SESSION ROW, AND NOTHING ASKS IT TO', async () => {
  const h = await harness();
  const token = await mint(h);
  const before = h.store.sessions.size;
  await h.app.inject({ method: 'GET', url: '/api/mcp/notes.md', headers: bearer(token) });
  assert.equal(h.store.sessions.size, before, 'a bearer request minted a session, which nothing should do');
  await h.app.close();
});

test('THE FIRST USE OF A TOKEN IS RECORDED, AND THE SECOND WITHIN THE HOUR IS NOT', async () => {
  const h = await harness();
  const token = await mint(h);
  const id = [...h.store.apiTokens.keys()][0];
  assert.ok(id !== undefined);
  assert.equal(h.store.apiTokens.get(id)?.lastUsedAt, null);

  await h.app.inject({ method: 'GET', url: '/api/mcp/notes.md', headers: bearer(token) });
  const first = h.store.apiTokens.get(id)?.lastUsedAt;
  assert.ok(first instanceof Date, 'the first use was not recorded');

  h.clock.advance(60_000);
  await h.app.inject({ method: 'GET', url: '/api/mcp/notes.md', headers: bearer(token) });
  assert.equal(h.store.apiTokens.get(id)?.lastUsedAt?.getTime(), first.getTime(), 'a use inside the hour was written');

  h.clock.advance(3_600_000);
  await h.app.inject({ method: 'GET', url: '/api/mcp/notes.md', headers: bearer(token) });
  assert.notEqual(h.store.apiTokens.get(id)?.lastUsedAt?.getTime(), first.getTime(), 'a use after the hour was not written');
  await h.app.close();
});

test('A TOKEN OPENS NOTHING ON A DEPLOYMENT WITH NO PASSPHRASE SET', async () => {
  // The readiness refusal is above everything, so a token cannot get in front of
  // the screen saying which Replit Secret to set.
  const h = await harness({ passphrase: '' });
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/mcp/notes.md',
    headers: bearer(`${API_TOKEN_PREFIX}${'z'.repeat(43)}`),
  });
  assert.equal(res.statusCode, 503);
  await h.app.close();
});

// ------------------------------------------------------------- the door itself

test('PUBLIC_API_PATHS IS STILL EMPTY, and this test is what makes that a decision', async () => {
  // The constant is protected by a comment saying a line added there opens that
  // address to whoever finds the URL. A comment is advice. This is the thing that
  // turns adding one into a failing build, so the decision has to be made twice.
  const h = await harness();
  const source = readFileSync(new URL('./plugin.ts', import.meta.url), 'utf8');
  const declared = /const PUBLIC_API_PATHS: readonly string\[\] = \[\];/.test(source);
  assert.ok(declared, 'PUBLIC_API_PATHS is no longer an empty literal. Was that on purpose?');
  await h.app.close();
});

test('THE MCP PREFIX ENDS IN A SLASH, so a route named next to it is not swept in', () => {
  assert.ok(MCP_API_PREFIX.endsWith('/'));
  assert.ok('/api/mcp-admin/anything'.startsWith(MCP_API_PREFIX) === false);
});

/**
 * The seam between the two refusals, which is easy to get wrong in either
 * direction and was got wrong once while writing these tests.
 *
 * A header whose value contains a space is a MALFORMED HEADER, not a bad token.
 * bearerFrom refuses it before any token is read, so the request carries no
 * credential at all and gets the sentence the browser bundle paints. That is
 * right: we cannot tell a mangled Authorization header from a client that never
 * meant to send one, and "sign in" is the safer of the two things to say.
 */
test('A HEADER VALUE WITH A SPACE IN IT IS NO CREDENTIAL, NOT A BAD TOKEN', async () => {
  const h = await harness();
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/mcp/notes.md',
    headers: { authorization: 'Bearer not a token at all' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error, 'not_signed_in');

  // And the same value with the spaces taken out reaches the token path, so the
  // line above is about the header rather than about the value being rubbish.
  const joined = await h.app.inject({
    method: 'GET',
    url: '/api/mcp/notes.md',
    headers: { authorization: 'Bearer notatokenatall' },
  });
  assert.equal(JSON.parse(joined.body).error, 'token_not_accepted');
  await h.app.close();
});
