/**
 * src/server/routes/mcp-rpc.test.ts
 *
 * WHAT THIS IS. The protocol and the three read only tools, tested by calling
 * handleRpcMessage with an object, plus two cases driven over real HTTP to prove
 * the route is wired to it.
 *
 * WHY MOST OF IT IS NOT OVER HTTP. Almost everything that can go wrong at this
 * seam is a shape: a notification answered when it should not be, an id dropped,
 * a tool failure sent as a protocol error when the spec says it is a result. All
 * of those are visible from a function call, and a test that spells out an HTTP
 * request to check them buries the assertion in scaffolding. The two cases that
 * ARE over HTTP are the two that could only fail there: is the route registered
 * at the path the config will name, and does GET answer 405 rather than 404.
 *
 * WHAT IT CALLS. handleRpcMessage and the harness from ./test-fixtures.ts.
 * WHAT IT READS. The gate table, to find a file belonging to the other track.
 * WHAT IT WRITES. Nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FOUNDER_A } from '../auth/test-fixtures.ts';
import { ROUTES } from '../../../app/content/routes.ts';
import { gatesSource } from '../rules/gates-source.ts';
import { fileFilterFor } from '../rules/index.ts';
import { handleRpcMessage, PROTOCOL_VERSION, RPC, TOOLS, type ToolContext } from './mcp-rpc.ts';
import { mayStart } from './threads.ts';
import { buildHarness, type Harness } from './test-fixtures.ts';

/** The founder every test here is, matching the row buildHarness seeds. */
const FOUNDER = { id: FOUNDER_A, track: 'b2b' as const };

const contextOf = (h: Harness): ToolContext => ({ deps: h.deps, founder: FOUNDER });

/** A request, with an id, because a message without one is a notification. */
const ask = (method: string, params?: unknown): unknown => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  ...(params === undefined ? {} : { params }),
});

/** The body of a successful answer, asserting it was not an error first. */
function resultOf(outcome: { status: number; body: unknown }): Record<string, unknown> {
  assert.equal(outcome.status, 200);
  const body = outcome.body as { result?: Record<string, unknown>; error?: { message: string } };
  assert.equal(body.error, undefined, `expected a result, got an error: ${body.error?.message ?? ''}`);
  assert.ok(body.result !== undefined, 'there was no result');
  return body.result;
}

/** The text of a tools/call result, and whether the tool refused. */
function toolText(result: Record<string, unknown>): { text: string; isError: boolean } {
  const content = result['content'] as { type: string; text: string }[];
  assert.equal(content.length, 1);
  assert.equal(content[0]?.type, 'text');
  return { text: content[0]?.text ?? '', isError: result['isError'] === true };
}

test('initialize agrees to a version the client knows, and falls back to ours when it does not', async (t) => {
  const h = await buildHarness({ track: 'b2b' });
  t.after(async () => {
    await h.app.close();
  });

  // A for loop rather than it.each, so a failure still names the case. There is
  // one test runner here and it has no table helper.
  const cases: { asked: string | undefined; answered: string; why: string }[] = [
    { asked: '2024-11-05', answered: '2024-11-05', why: 'an older revision this server can speak' },
    { asked: PROTOCOL_VERSION, answered: PROTOCOL_VERSION, why: 'the current one' },
    { asked: '1999-01-01', answered: PROTOCOL_VERSION, why: 'a version nobody has heard of' },
    { asked: undefined, answered: PROTOCOL_VERSION, why: 'a client that named no version at all' },
  ];

  for (const c of cases) {
    const out = await handleRpcMessage(contextOf(h), ask('initialize', { protocolVersion: c.asked }));
    const result = resultOf(out);
    assert.equal(result['protocolVersion'], c.answered, c.why);
    assert.deepEqual(result['capabilities'], { tools: {} }, c.why);
  }
});

test('a notification is accepted and never answered', async (t) => {
  const h = await buildHarness({ track: 'b2b' });
  t.after(async () => {
    await h.app.close();
  });

  // Every client sends this one straight after initialize. Answering it is a
  // protocol error, and the shape of that mistake is a body where none belongs.
  const out = await handleRpcMessage(contextOf(h), {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  assert.equal(out.status, 202);
  assert.equal(out.body, null);
});

test('tools/list publishes every tool with a schema a client can read', async (t) => {
  const h = await buildHarness({ track: 'b2b' });
  t.after(async () => {
    await h.app.close();
  });

  const result = resultOf(await handleRpcMessage(contextOf(h), ask('tools/list')));
  const tools = result['tools'] as { name: string; description: string; inputSchema: unknown }[];
  assert.equal(tools.length, TOOLS.length);

  for (const tool of tools) {
    assert.ok(tool.description.length > 0, `${tool.name} has no description`);
    const schema = tool.inputSchema as { type?: string };
    assert.equal(schema.type, 'object', `${tool.name} does not advertise an object schema`);
  }
  assert.deepEqual(
    tools.map((t2) => t2.name).sort(),
    ['add_voice_sample', 'check_progress', 'check_turn', 'list_files', 'read_file', 'start_turn'],
  );
});

test('the refusals a bad message earns', async (t) => {
  const h = await buildHarness({ track: 'b2b' });
  t.after(async () => {
    await h.app.close();
  });

  const cases: { name: string; message: unknown; code: number }[] = [
    { name: 'a batch, which MCP removed in 2025-06-18', message: [ask('tools/list')], code: RPC.invalidRequest },
    { name: 'not an object at all', message: 'tools/list', code: RPC.invalidRequest },
    { name: 'the wrong jsonrpc version', message: { jsonrpc: '1.0', id: 1, method: 'ping' }, code: RPC.invalidRequest },
    { name: 'a method that is not a string', message: { jsonrpc: '2.0', id: 1, method: 7 }, code: RPC.invalidRequest },
    { name: 'a method this server does not have', message: ask('resources/list'), code: RPC.methodNotFound },
    {
      name: 'a tool that does not exist',
      message: ask('tools/call', { name: 'delete_everything', arguments: {} }),
      code: RPC.invalidParams,
    },
    {
      name: 'read_file with no path',
      message: ask('tools/call', { name: 'read_file', arguments: {} }),
      code: RPC.invalidParams,
    },
  ];

  for (const c of cases) {
    const out = await handleRpcMessage(contextOf(h), c.message);
    assert.equal(out.status, 200, `${c.name}: a JSON-RPC error is still HTTP 200`);
    const body = out.body as { error?: { code: number; message: string } };
    assert.ok(body.error !== undefined, `${c.name}: expected an error`);
    assert.equal(body.error.code, c.code, c.name);
    assert.ok(body.error.message.length > 0, `${c.name}: an error with no sentence in it`);
  }
});

test('list_files reports what the founder has, and read_file reads one', async (t) => {
  const h = await buildHarness({ track: 'b2b' });
  t.after(async () => {
    await h.app.close();
  });

  h.store.putFile(FOUNDER_A, 'brain/brain.md', '# The Brain\n\nWhat this business is.\n');
  h.store.putFile(FOUNDER_A, 'content/posts.md', '# Posts\n');

  const listed = toolText(
    resultOf(await handleRpcMessage(contextOf(h), ask('tools/call', { name: 'list_files', arguments: {} }))),
  );
  assert.equal(listed.isError, false);
  const listing = JSON.parse(listed.text) as {
    files: { name: string; kind: string }[];
    stateFiles: { name: string }[];
  };
  const names = listing.files.map((r) => r.name);
  assert.ok(Array.isArray(listing.stateFiles), 'stateFiles was not a list of its own');
  assert.ok(names.includes('brain/brain.md'), `brain/brain.md was not listed. Got: ${names.join(', ')}`);
  assert.ok(names.includes('content/posts.md'));

  const read = toolText(
    resultOf(
      await handleRpcMessage(
        contextOf(h),
        ask('tools/call', { name: 'read_file', arguments: { path: 'brain/brain.md' } }),
      ),
    ),
  );
  assert.equal(read.isError, false);
  assert.match(read.text, /What this business is\./);
});

test('a tool that cannot do its job answers with isError rather than a protocol error', async (t) => {
  const h = await buildHarness({ track: 'b2b' });
  t.after(async () => {
    await h.app.close();
  });

  h.store.putFile(FOUNDER_A, 'uploads/deck.pdf', 'not really a pdf');

  const cases: { name: string; path: string; expect: RegExp }[] = [
    { name: 'a file that is not there', path: 'brain/brain.md', expect: /no file at brain\/brain\.md/ },
    { name: 'a file that is not text', path: 'uploads/deck.pdf', expect: /not a text file/ },
  ];

  for (const c of cases) {
    const out = await handleRpcMessage(
      contextOf(h),
      ask('tools/call', { name: 'read_file', arguments: { path: c.path } }),
    );
    // The point of this test. A refusal is a RESULT, so the model can read the
    // sentence and try something else, rather than the call failing under it.
    const answered = toolText(resultOf(out));
    assert.equal(answered.isError, true, c.name);
    assert.match(answered.text, c.expect, c.name);
  }
});

test('a file belonging to the other track is answered as though it is not there', async (t) => {
  const h = await buildHarness({ track: 'b2b' });
  t.after(async () => {
    await h.app.close();
  });

  // Derived from the gate table rather than written down, so this test does not
  // go stale the day a file moves between tracks.
  const mayShow = fileFilterFor('b2b');
  const otherTrack = gatesSource()
    .files.map((f) => f.file)
    .find((p) => !mayShow(p));
  assert.ok(otherTrack !== undefined, 'the gate table named no file this track cannot see');

  h.store.putFile(FOUNDER_A, otherTrack, 'the other track material');

  const answered = toolText(
    resultOf(
      await handleRpcMessage(
        contextOf(h),
        ask('tools/call', { name: 'read_file', arguments: { path: otherTrack } }),
      ),
    ),
  );
  assert.equal(answered.isError, true);
  // NOT "that belongs to the other track", which would confirm it exists.
  assert.match(answered.text, /no file at/);
  assert.doesNotMatch(answered.text, /track/i);
});

test('check_progress reports the same shape the home screen renders', async (t) => {
  const h = await buildHarness({ track: 'b2b' });
  t.after(async () => {
    await h.app.close();
  });

  const result = resultOf(
    await handleRpcMessage(contextOf(h), ask('tools/call', { name: 'check_progress', arguments: {} })),
  );
  const state = JSON.parse(toolText(result).text) as {
    routes: Record<string, { progress: string }>;
    nextRouteId: string | null;
    presentFiles: string[];
  };

  assert.ok(Object.keys(state.routes).length > 0, 'no routes were reported');
  for (const [id, row] of Object.entries(state.routes)) {
    assert.ok(
      ['done', 'in_progress', 'not_started'].includes(row.progress),
      `${id} had progress ${row.progress}`,
    );
  }
  // A founder with no files has done nothing yet, and there is something to do.
  assert.deepEqual(state.presentFiles, []);
  assert.ok(state.nextRouteId !== null, 'a founder with nothing done should have a next route');
});

test('the route is wired at the path a Claude Desktop config will name', async (t) => {
  const h = await buildHarness({ track: 'b2b' });
  t.after(async () => {
    await h.app.close();
  });
  const cookie = await h.signIn();

  const posted = await h.app.inject({
    method: 'POST',
    url: '/api/mcp/rpc',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { jsonrpc: '2.0', id: 9, method: 'tools/list' },
  });
  assert.equal(posted.statusCode, 200);
  const body = posted.json() as { id: number; result: { tools: unknown[] } };
  assert.equal(body.id, 9, 'the id a client sent did not come back');
  assert.equal(body.result.tools.length, TOOLS.length);

  // 405 and not 404, so a client probing for the server to client stream is told
  // the address is right and the method is not.
  const got = await h.app.inject({ method: 'GET', url: '/api/mcp/rpc', headers: { cookie } });
  assert.equal(got.statusCode, 405);
  assert.equal(got.headers['allow'], 'POST');
});

// =========================================================================================
// The two that run a turn. A turn takes 30 to 180 seconds, so the whole design is that
// neither of these waits for one.
// =========================================================================================

/** Call one tool and hand back the parsed JSON its text carries. */
async function callTool(h: Harness, name: string, args: unknown): Promise<Record<string, unknown>> {
  const out = await handleRpcMessage(contextOf(h), ask('tools/call', { name, arguments: args }));
  const answered = toolText(resultOf(out));
  assert.equal(answered.isError, false, `${name} refused: ${answered.text}`);
  return JSON.parse(answered.text) as Record<string, unknown>;
}

/** Call one tool expecting it to refuse, and hand back the sentence. */
async function refuseTool(h: Harness, name: string, args: unknown): Promise<string> {
  const out = await handleRpcMessage(contextOf(h), ask('tools/call', { name, arguments: args }));
  const answered = toolText(resultOf(out));
  assert.equal(answered.isError, true, `${name} was expected to refuse and did not`);
  return answered.text;
}

test('start_turn opens a conversation, stores the message once, and returns without waiting', async (t) => {
  let runs = 0;
  const h = await buildHarness({
    track: 'b2b',
    run: () => {
      runs += 1;
      return Promise.resolve();
    },
  });
  t.after(async () => {
    await h.app.close();
  });

  const started = await callTool(h, 'start_turn', {
    routeId: 'founder-brain',
    message: 'we sell to construction firms',
  });

  assert.equal(typeof started['turnId'], 'string');
  assert.equal(typeof started['threadId'], 'string');
  assert.equal(started['alreadyRunning'], false);
  assert.match(String(started['next']), /check_turn/, 'the answer does not say what to do next');

  assert.equal(h.store.messages.length, 1, 'one message row');
  assert.equal(h.store.turns.size, 1, 'one turn row');

  // The submit is on the next tick, exactly as routes/messages.ts does it, so
  // the tool returns before the engine is asked for anything.
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 1);
});

test('start_turn carries on the open conversation rather than opening a second one', async (t) => {
  const h = await buildHarness({ track: 'b2b', run: () => Promise.resolve() });
  t.after(async () => {
    await h.app.close();
  });

  const first = await callTool(h, 'start_turn', { routeId: 'founder-brain', message: 'one' });
  await new Promise((r) => setImmediate(r));
  const second = await callTool(h, 'start_turn', { routeId: 'founder-brain', message: 'two' });
  await new Promise((r) => setImmediate(r));

  assert.equal(second['threadId'], first['threadId'], 'a second thread would split the history in two');
  assert.notEqual(second['turnId'], first['turnId'], 'but they are separate turns');
});

test('an idempotencyKey makes a retry safe, so a blip does not run the engine twice', async (t) => {
  let runs = 0;
  const h = await buildHarness({
    track: 'b2b',
    run: () => {
      runs += 1;
      return Promise.resolve();
    },
  });
  t.after(async () => {
    await h.app.close();
  });

  const args = { routeId: 'founder-brain', message: 'we sell to construction firms', idempotencyKey: 'retry-me' };
  const first = await callTool(h, 'start_turn', args);
  const second = await callTool(h, 'start_turn', args);
  await new Promise((r) => setImmediate(r));

  assert.equal(second['turnId'], first['turnId'], 'the retry was handed the turn it already has');
  assert.equal(first['alreadyRunning'], false);
  assert.equal(second['alreadyRunning'], true);
  assert.equal(h.store.messages.length, 1, 'one message row');
  assert.equal(runs, 1, 'and the engine ran once, so the founder is not charged twice');
});

test('start_turn refuses a route that is not theirs to start', async (t) => {
  const h = await buildHarness({ track: 'b2b', run: () => Promise.resolve() });
  t.after(async () => {
    await h.app.close();
  });

  const unknown = await refuseTool(h, 'start_turn', { routeId: 'no-such-engine', message: 'hello' });
  assert.match(unknown, /no engine called no-such-engine/);
  assert.match(unknown, /check_progress/, 'the refusal does not say how to find the real ones');

  // Derived rather than written down, so it does not go stale when a route moves.
  const otherTrack = ROUTES.find((r) => mayStart(r.id, 'b2b') === 'wrong_track');
  if (otherTrack !== undefined) {
    const refused = await refuseTool(h, 'start_turn', { routeId: otherTrack.id, message: 'hello' });
    assert.match(refused, /other track/);
  }

  assert.equal(h.store.turns.size, 0, 'a refused start wrote nothing');
});

test('start_turn refuses an empty message with the composer\'s own sentence', async (t) => {
  const h = await buildHarness({ track: 'b2b', run: () => Promise.resolve() });
  t.after(async () => {
    await h.app.close();
  });

  const refused = await refuseTool(h, 'start_turn', { routeId: 'founder-brain', message: '   ' });
  assert.match(refused, /nothing in that message/i);
  assert.equal(h.store.turns.size, 0);
});

test('check_turn reports a turn in flight, then hands back the reply once it is done', async (t) => {
  const h = await buildHarness({ track: 'b2b', run: () => Promise.resolve() });
  t.after(async () => {
    await h.app.close();
  });

  const started = await callTool(h, 'start_turn', {
    routeId: 'founder-brain',
    message: 'we sell to construction firms',
  });
  const turnId = String(started['turnId']);
  const threadId = String(started['threadId']);

  const running = await callTool(h, 'check_turn', { turnId });
  assert.equal(running['reply'], null, 'a turn in flight has no reply');
  assert.match(String(running['note']), /again/, 'it does not say to call back');

  // The engine finishing, as the executor would leave it.
  await h.store.setTurnStatus(turnId, 'done', h.clock.now());
  h.store.messages.push({
    id: 'msg-assistant-1',
    threadId,
    founderId: FOUNDER_A,
    role: 'assistant',
    text: 'Here is the Brain.',
    clientMsgId: null,
    createdAt: new Date(h.clock.now().getTime() + 1000),
  });

  const done = await callTool(h, 'check_turn', { turnId });
  assert.equal(done['status'], 'done');
  assert.equal(done['reply'], 'Here is the Brain.');
});

test('a turn that ended badly says so rather than reporting an empty reply', async (t) => {
  const h = await buildHarness({ track: 'b2b', run: () => Promise.resolve() });
  t.after(async () => {
    await h.app.close();
  });

  const started = await callTool(h, 'start_turn', { routeId: 'founder-brain', message: 'hello' });
  const turnId = String(started['turnId']);

  for (const status of ['failed', 'refused', 'interrupted'] as const) {
    await h.store.setTurnStatus(turnId, status, h.clock.now());
    const answered = await callTool(h, 'check_turn', { turnId });
    assert.equal(answered['status'], status);
    assert.equal(answered['reply'], null, status);
    assert.ok(String(answered['note']).length > 0, `${status} came back with no sentence in it`);
  }
});

test('check_turn refuses a turn id it does not have', async (t) => {
  const h = await buildHarness({ track: 'b2b', run: () => Promise.resolve() });
  t.after(async () => {
    await h.app.close();
  });

  const refused = await refuseTool(h, 'check_turn', { turnId: 'not-a-real-turn' });
  assert.match(refused, /no turn with the id not-a-real-turn/);
});

// =========================================================================================
// The one write. saveUpload is the only write to ge_file that is not a harvest, so this is
// the only file this connector can put there.
// =========================================================================================

test('add_voice_sample writes a file the read tools can then see', async (t) => {
  const h = await buildHarness({ track: 'b2b', run: () => Promise.resolve() });
  t.after(async () => {
    await h.app.close();
  });

  const written = await callTool(h, 'add_voice_sample', {
    name: 'linkedin-post-january.md',
    text: 'We turned up on site at six and the client was already there.',
  });
  const path = String(written['path']);
  assert.match(path, /linkedin-post-january/);
  assert.ok(Number(written['sizeBytes']) > 0);

  /**
   * The round trip is the point. A write the read tools cannot see afterwards is
   * a write into somewhere that is not the founder's app. read_file answers with
   * the file itself rather than with JSON, so it is read here as text.
   */
  const listed = await callTool(h, 'list_files', {});
  const names = (listed['files'] as { name: string }[]).map((r) => r.name);
  assert.ok(names.includes(path), `${path} was written but not listed. Got: ${names.join(', ')}`);

  const read = await handleRpcMessage(
    contextOf(h),
    ask('tools/call', { name: 'read_file', arguments: { path } }),
  );
  const body = toolText(resultOf(read));
  assert.equal(body.isError, false);
  assert.match(body.text, /six and the client/);
});

test('add_voice_sample refuses a type this transport cannot carry', async (t) => {
  const h = await buildHarness({ track: 'b2b', run: () => Promise.resolve() });
  t.after(async () => {
    await h.app.close();
  });

  const refused = await refuseTool(h, 'add_voice_sample', { name: 'deck.pdf', text: 'not really a pdf' });
  assert.match(refused, /\.md, \.txt, \.csv/);
  assert.match(refused, /bytes cannot travel as text/);
});

test('add_voice_sample waits for a turn rather than racing the folder it rebuilds', async (t) => {
  // A run that never settles, so the turn stays in flight for the whole test.
  const h = await buildHarness({ track: 'b2b', run: () => new Promise<void>(() => undefined) });
  t.after(async () => {
    await h.app.close();
  });

  await callTool(h, 'start_turn', { routeId: 'founder-brain', message: 'hello' });
  await new Promise((r) => setImmediate(r));

  const refused = await refuseTool(h, 'add_voice_sample', { name: 'sample.md', text: 'anything' });
  assert.match(refused, /turn is running/);
  // Not permanent, and the sentence has to say so or a model gives up on it.
  assert.match(refused, /again/);
});
