/**
 * src/server/routes/mcp-rpc.ts
 *
 * WHAT THIS IS. `POST /api/mcp/rpc`. The one address that speaks MCP, with the
 * tools dispatched inside it rather than one address per tool. ./mcp.ts said
 * this file was coming and named the path it would live at.
 *
 * WHY ONE ADDRESS. Claude Desktop talks to a remote server over streamable
 * HTTP, which is JSON-RPC 2.0 over a single endpoint. A tool is not a URL. It is
 * a name in a `tools/call` request, and the list of them is an answer to
 * `tools/list`. So adding a tool later touches TOOLS below and nothing else, and
 * in particular does not touch the door, the route list or the contract test.
 *
 * READ ONLY, AND THAT IS THE WHOLE OF STEP 4. Three tools, all of them reads.
 * They cover the first two of the four things the brief asks for: read files and
 * Brain, and check state and progress. Running a turn and writing files back are
 * steps 5 and 6 and are deliberately absent, because a write that came in here
 * would bypass the runtime rules gate, and that gate is one of the six rules the
 * app exists to enforce. A read cannot break a rule, which is why reads are the
 * ones that go first.
 *
 * IT REUSES THE SCREENS' OWN LOGIC RATHER THAN RE IMPLEMENTING IT. `listRowsFor`
 * is what the files screen renders. `progressOf` and `nextRouteId` are what the
 * home screen renders. A second copy of "how far along is this founder" would
 * drift from the first one, and the two would disagree in front of the founder.
 *
 * WHAT OF STREAMABLE HTTP IS IMPLEMENTED, SAID PLAINLY. Requests and
 * notifications over `POST`, answered as one JSON object. That is the half of
 * the transport a tools only server needs, because nothing here streams: every
 * tool below returns in one database round trip. The half that is NOT here is
 * the `GET` stream for server initiated messages, and there is nothing this
 * server would send down it today. `GET` therefore answers 405 with a sentence
 * rather than 404, so a client probing for that stream is told the address is
 * real and the method is not, which is the difference between "not built" and
 * "wrong URL".
 *
 * JSON-RPC BATCHES ARE REFUSED. They were removed from MCP in the 2025-06-18
 * revision. Accepting them would be writing code for a shape no current client
 * sends and no current spec allows.
 *
 * IT CALLS requireFounder EVEN THOUGH THE HOOK ALREADY REFUSED, like every other
 * route here. See ./mcp.ts for why two belts are worth one line.
 *
 * WHAT CALLS IT. ./index.ts registers it. The founder's own Claude Desktop, over
 * a bearer token minted by `npm run token:mint`.
 * WHAT IT READS. The founder's files, threads and route rows, through deps.store.
 * WHAT IT WRITES. Nothing. `api_tokens.last_used_at` is written by the door
 * before any of this runs.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ROUTES } from '../../../app/content/routes.ts';
import { fileFilterFor } from '../rules/index.ts';
import { kindOf, listRowsFor } from './files.ts';
import { presentFiles, trackOf } from './founder-state.ts';
import { nextRouteId, progressOf } from './home.ts';
import { mayStart } from './threads.ts';
import type { RouteDeps } from './deps.ts';
import type { ThreadRow } from './ports.ts';

/**
 * The revision this server implements, and the ones it will agree to speak.
 *
 * A client sends the version it wants in `initialize`. The rule in the spec is
 * to answer with the same version when it is one we know, and with our own when
 * it is not, leaving the client to decide whether it can live with that. All
 * three of these have the same tools shape, which is the only part this server
 * uses, so all three are safe to agree to.
 */
export const PROTOCOL_VERSION = '2025-06-18';
const KNOWN_PROTOCOL_VERSIONS: readonly string[] = ['2024-11-05', '2025-03-26', '2025-06-18'];

/** What this server calls itself in `initialize`. The founder sees this name in Claude. */
export const SERVER_INFO = { name: 'launchhouse', version: '0.1.0' } as const;

/** The JSON-RPC 2.0 codes, named, because a bare -32602 in a handler says nothing. */
export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** The founder fields these tools need, structurally, so a test needs no auth stack. */
export interface ToolFounder {
  readonly id: string;
  readonly track: string | null;
}

export interface ToolContext {
  readonly deps: RouteDeps;
  readonly founder: ToolFounder;
}

/**
 * One tool.
 *
 * `schema` is both the validator and the advertisement. `tools/list` publishes
 * `z.toJSONSchema(schema)` and `tools/call` parses with the same object, so the
 * shape a client is told to send and the shape this server accepts cannot drift
 * apart. Writing the JSON Schema by hand next to a zod object is two statements
 * of one fact, and the day they disagree the client is right and the server is
 * wrong for no reason anybody can see.
 */
interface Tool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType;
  run(ctx: ToolContext, args: unknown): Promise<string>;
}

/** The track filter, without a reply to write a refusal into. */
function filterFor(founder: ToolFounder): (path: string) => boolean {
  return fileFilterFor(trackOf(founder));
}

/**
 * A tool that failed for a reason the founder should read.
 *
 * Thrown rather than returned so a tool body reads as the happy path. The
 * dispatcher turns it into a `tools/call` result with `isError` true, which is
 * what the spec asks for: a tool that could not do its job is a result the model
 * can read and react to, not a protocol error that ends the conversation.
 */
class ToolRefusal extends Error {}

export const TOOLS: readonly Tool[] = [
  {
    name: 'list_files',
    description:
      'List the files this founder has in the app, with size, kind and when each one last changed. ' +
      'Use it before read_file to find out what is there. Paths are relative, for example ' +
      'brain/brain.md. Files belonging to the other track are not listed. The app\'s own ' +
      'bookkeeping files are listed separately under stateFiles.',
    schema: z.object({}),
    async run({ deps, founder }) {
      const mayShow = filterFor(founder);
      const held = await deps.store.listFiles(founder.id);

      /**
       * THE TWO LISTS ARE KEPT APART, exactly as the files screen keeps them.
       * `.state/` is the toolkit's own bookkeeping. It is the founder's too, so
       * it is not hidden, but a model handed one flat list would treat
       * `.state/index.md` as work the founder made. The screen puts it behind a
       * disclosure for the same reason.
       */
      const { rows, stateRows } = listRowsFor(held, mayShow);
      return JSON.stringify({ files: rows, stateFiles: stateRows }, null, 2);
    },
  },
  {
    name: 'read_file',
    description:
      'Read one of this founder\'s files as text, by its relative path. ' +
      'Use list_files first to get the path. The Brain is a file like any other.',
    schema: z.object({
      path: z
        .string()
        .min(1)
        .describe('Relative path of the file, as list_files reports it, for example brain/brain.md'),
    }),
    async run({ deps, founder }, args) {
      const { path } = args as { path: string };
      const mayShow = filterFor(founder);

      /**
       * THE TRACK CHECK ANSWERS THE SAME WAY AS A MISSING FILE, on purpose and
       * exactly as routes/files.ts does. Saying "that belongs to the other
       * track" would confirm the file exists to somebody who may not see it.
       */
      if (!mayShow(path)) throw new ToolRefusal(`There is no file at ${path}.`);

      /**
       * NOT EVERY FILE IS TEXT. A tool result is text, so a PDF read through
       * here would arrive as mojibake that looks like a corrupted file rather
       * than like the wrong tool for the job. The founder can download it from
       * the app, and the sentence says so.
       */
      const kind = kindOf(path);
      if (kind === 'other') {
        throw new ToolRefusal(
          `${path} is not a text file, so it cannot be read here. Download it from the app instead.`,
        );
      }

      const found = await deps.store.readFile(founder.id, path);
      if (found === null) throw new ToolRefusal(`There is no file at ${path}.`);
      return found.bytes.toString('utf8');
    },
  },
  {
    name: 'check_progress',
    description:
      'Report how far this founder has got. Returns each route with its progress, the route to do ' +
      'next, and the files that exist so far. This is what the app\'s own home screen shows.',
    schema: z.object({}),
    async run({ deps, founder }) {
      const mayShow = filterFor(founder);
      const [files, threads] = await Promise.all([
        deps.store.listFiles(founder.id),
        deps.store.listThreads(founder.id),
      ]);
      const present = presentFiles(files, mayShow);
      const visible = ROUTES.filter((r) => !r.hidden && mayStart(r.id, founder.track) === 'ok');

      // The newest thread per row, for the same reason home.ts takes the newest:
      // a founder who started the Brain twice is carrying on in the later one.
      const newest = new Map<string, ThreadRow>();
      for (const thread of threads) {
        const held = newest.get(thread.routeId);
        if (held === undefined || thread.createdAt.getTime() > held.createdAt.getTime()) {
          newest.set(thread.routeId, thread);
        }
      }

      const routes: Record<string, ReturnType<typeof progressOf>> = {};
      for (const row of visible) routes[row.id] = progressOf(row, present, newest.get(row.id));

      return JSON.stringify(
        { routes, nextRouteId: nextRouteId(visible, present, routes), presentFiles: present },
        null,
        2,
      );
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** What `tools/list` publishes. Exported so a test can read it without HTTP. */
export function toolListing(): unknown {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.schema),
    })),
  };
}

/** One answer: a body to send, or nothing at all when the message was a notification. */
export interface RpcOutcome {
  readonly status: number;
  readonly body: unknown | null;
}

const ok = (id: unknown, result: unknown): RpcOutcome => ({
  status: 200,
  body: { jsonrpc: '2.0', id, result },
});

const fail = (id: unknown, code: number, message: string): RpcOutcome => ({
  status: 200,
  body: { jsonrpc: '2.0', id, error: { code, message } },
});

/**
 * ONE JSON-RPC MESSAGE IN, ONE OUTCOME OUT, AND NO FASTIFY IN SIGHT.
 *
 * Separated from the route so the protocol can be tested by calling a function
 * with an object, which is most of what there is to get wrong here. The route
 * below is then four lines and has nothing in it worth a test of its own.
 *
 * A JSON-RPC error is still HTTP 200. That is the transport working correctly
 * and carrying a failure, and a client that reads the status instead of the
 * body would otherwise be told the wrong thing.
 */
export async function handleRpcMessage(ctx: ToolContext, message: unknown): Promise<RpcOutcome> {
  if (Array.isArray(message)) {
    return fail(null, RPC.invalidRequest, 'Batched requests are not supported. Send one message.');
  }
  if (typeof message !== 'object' || message === null) {
    return fail(null, RPC.invalidRequest, 'A JSON-RPC message must be an object.');
  }

  const { jsonrpc, id, method, params } = message as {
    jsonrpc?: unknown;
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  if (jsonrpc !== '2.0') return fail(id ?? null, RPC.invalidRequest, 'jsonrpc must be "2.0".');
  if (typeof method !== 'string') return fail(id ?? null, RPC.invalidRequest, 'method must be a string.');

  // A notification has no id and is never answered. `notifications/initialized`
  // is the one every client sends, and answering it is a protocol error.
  const isNotification = id === undefined || id === null;
  if (isNotification) return { status: 202, body: null };

  switch (method) {
    case 'initialize': {
      const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const version =
        typeof asked === 'string' && KNOWN_PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION;
      return ok(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, toolListing());

    case 'tools/call': {
      const call = params as { name?: unknown; arguments?: unknown } | undefined;
      const tool = typeof call?.name === 'string' ? BY_NAME.get(call.name) : undefined;
      if (tool === undefined) {
        return fail(id, RPC.invalidParams, `There is no tool called ${String(call?.name)}.`);
      }

      const parsed = tool.schema.safeParse(call?.arguments ?? {});
      if (!parsed.success) {
        return fail(id, RPC.invalidParams, `Those arguments are not right for ${tool.name}.`);
      }

      try {
        const text = await tool.run(ctx, parsed.data);
        return ok(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        /**
         * A REFUSAL IS A RESULT, NOT A PROTOCOL ERROR. The spec is explicit
         * about the split, and it matters: a model that asked for a file that
         * is not there should read that sentence and try another path, not have
         * the call fail underneath it.
         */
        if (err instanceof ToolRefusal) {
          return ok(id, { content: [{ type: 'text', text: err.message }], isError: true });
        }
        ctx.deps.log.error(
          { founderId: ctx.founder.id, tool: tool.name, detail: String(err) },
          'an MCP tool failed',
        );
        return fail(id, RPC.internalError, 'That tool failed. The server log has the detail.');
      }
    }

    default:
      return fail(id, RPC.methodNotFound, `This server does not implement ${method}.`);
  }
}

export async function registerMcpRpcRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.post('/api/mcp/rpc', async (request, reply) => {
    if (!(await deps.auth.requireFounder(request, reply))) return reply;
    const founder = deps.auth.founderOf(request);

    const outcome = await handleRpcMessage({ deps, founder }, request.body);
    if (outcome.body === null) return reply.code(outcome.status).send();
    return reply.code(outcome.status).send(outcome.body);
  });

  /**
   * The half of streamable HTTP this server does not implement, answered as
   * such. See the header: 405 tells a client the address is right and the method
   * is not, and 404 would send somebody looking for a typo in their config.
   */
  app.get('/api/mcp/rpc', async (request, reply) => {
    if (!(await deps.auth.requireFounder(request, reply))) return reply;
    return reply
      .code(405)
      .header('allow', 'POST')
      .send({
        error: 'method_not_allowed',
        message: 'This endpoint answers POST only. It does not open a server to client stream.',
      });
  });
}
