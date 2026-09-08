/**
 * src/server/routes/mcp.ts
 *
 * WHAT THIS IS. `GET /api/mcp/whoami`. The one address under the MCP prefix
 * today, and the thing to curl to find out whether a token works.
 *
 * WHY IT EXISTS, AND WHY IT IS THE FIRST THING BUILT RATHER THAN THE LAST.
 * Everything between a founder's token and their files is now written: the
 * table, the hash, the bearer path in the door, the prefix. None of it has ever
 * run against a real Postgres or a real socket. If the first thing to exercise
 * that seam were also the first real MCP tool, a failure could be either, and
 * the two are debugged by different people looking at different files.
 *
 * So this answers one question and no others: did this token resolve, and to
 * whom. It is the smallest thing that can tell the difference between a broken
 * credential and a broken tool.
 *
 * IT RETURNS THE SAME BODY AS `/api/me`, ON PURPOSE. A route answering
 * `{ ok: true }` would answer exactly the same way if the token resolved to the
 * WRONG founder, which is the one failure in this area that would matter most
 * and the one a smoke test must be able to see. Naming the founder means a
 * person reading curl output can tell.
 *
 * IT IS NOT AN MCP ENDPOINT AND DOES NOT SPEAK MCP. Claude Desktop talks to a
 * remote server over streamable HTTP, which is one address speaking JSON-RPC
 * with the tools dispatched inside it, not one address per tool. That endpoint
 * comes later and will live at `/api/mcp/rpc`, with a trailing path segment
 * rather than at the bare prefix, because MCP_API_PREFIX ends in a slash and a
 * bare `/api/mcp` would not match it. This file will still be here afterwards,
 * because "is my token alive" stays worth asking on its own.
 *
 * IT CALLS requireFounder EVEN THOUGH THE HOOK ALREADY REFUSED. Every route in
 * this app does. The hook is what makes a route that forgot safe; the call is
 * what makes this route safe if the hook is ever changed. Two belts, and this
 * one costs a line.
 *
 * NOTHING IN THE BROWSER CALLS THIS, and that is the point of it. ./contract.test.ts
 * fails a route with no caller in src/web/lib/api.ts, so this address is named
 * in that file's explicit list of addresses reached from outside the browser.
 * See the list there for why an exemption is the right answer and a deleted
 * check is not.
 *
 * WHAT CALLS IT. ./index.ts registers it. A person with curl, and later the
 * founder's own Claude Desktop.
 * WHAT IT READS. Nothing of its own. The founder is already on the request.
 * WHAT IT WRITES. Nothing. `api_tokens.last_used_at` is written by the door
 * before this handler runs, not here.
 */

import type { FastifyInstance } from 'fastify';

import type { RouteDeps } from './deps.ts';

export async function registerMcpRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get('/api/mcp/whoami', async (request, reply) => {
    if (!(await deps.auth.requireFounder(request, reply))) return reply;
    const founder = deps.auth.founderOf(request);

    /**
     * The same four fields `/api/me` answers with, and no more.
     *
     * NOT THE TOKEN'S OWN ROW, which was the first version and is worse. Saying
     * which label was used would help somebody with three tokens work out which
     * laptop is talking, and it would also put a founder's own naming into a
     * response that exists to be pasted into a terminal and a chat window while
     * debugging. The label is in the database and in the mint output, which are
     * both places the founder already looks.
     */
    return reply.send({
      id: founder.id,
      displayName: founder.displayName,
      timezone: founder.timezone,
      track: founder.track,
    });
  });
}
