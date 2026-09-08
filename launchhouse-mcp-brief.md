# Adding an MCP endpoint to launchhouse-app

A handoff brief. Written after reading the codebase, before any code was changed.

Fork: https://github.com/Pmoul1691/launchhouse-app
Upstream: https://github.com/Philm-moxywolf/launchhouse-app

**Pete has stopped taking upstream changes.** The fork is his own line of development from
here. Do not merge or rebase onto upstream. Keeping `upstream` as a named remote is fine and
costs nothing, so a single fix can be cherry-picked later if it is ever wanted, but nothing is
pulled from it by default.

**Where the code lives.** Pete's 7 commits from the Replit app are now pushed to the fork as
the branch `replit-main` (HEAD `1725a13`). Work from `replit-main`, not `main`.

**Those 7 commits are Replit agent housekeeping, not feature work.** Three are "Published your
App" markers; the rest are .replit tidying and dependency bumps. Across all 7 they touch exactly
three files: `.replit`, `package.json`, `package-lock.json`. No source file changed.

**`main` and `replit-main` are effectively the same tree.** They differ by three lines in
`package-lock.json`, a transitive dev dependency (`ignore` 7.0.9 on main, 7.0.8 on
replit-main). Everything under `src/`, `app/` and `vendor/` is identical on both, and identical
to upstream at 7ee2b58. So the branch choice barely matters. Pick `replit-main` and move on.

**One real regression, present on BOTH branches.** Replit's agent stripped about 30 lines of
comments out of `.replit`, in both Repls independently. The settings survived. The reasoning
did not. Among the deleted lines was a Node 22 warning that carried its own history: "this
comment was deleted once and is back because the thing it warns about then happened." It has
now been deleted a third time. Restore that block from upstream `7ee2b58:.replit` early, before
Replit's agent runs again and it stops being obvious anything is missing.

**Pete's actual work is not in git at all.** It is in the Replit app's Postgres: 1 founder row,
20 files, 35 file versions, 3 threads, 30 messages. Git never carried any of it, and the app has
no restore path by design. That database is the thing to be careful with.

**Ignore `launchhouse-app (1)`.** A second Repl created from the fork. Empty database, no
`OWNER_PASSPHRASE`, never published. Its config commits are what sit on the fork's `main`. The
original Repl `launchhouse-app` holds the database, the passphrase and the Anthropic key.

**What is being declined.** Upstream moved 13 commits on 8 Sept, after the fork point. Basic
upload is already in the fork base. The 13 are refinements on top: owner-set storage limits,
a founder's own choice of folder, the Brain learning about voice-samples and uploads, and a
fix for screenshots and scanned PDFs bouncing off the upload button. That last one is a real
bug fix. If it ever bites, it is at `573f366` upstream and can be cherry-picked alone.

## What we are building and why

Pete wants to work with the app from Claude rather than from the app's own web screens.
Four things specifically: read his files and Brain, check state and progress, run a full
engine turn, and write files back.

The app has no external API surface today. Every route under `/api/` sits behind a session
cookie derived from `OWNER_PASSPHRASE`. That is deliberate and the reasoning is written into
`src/server/auth/plugin.ts`. We are adding a second way to prove identity, not opening a door.

## The auth finding that shapes everything

Claude's custom connector UI on the web only accepts OAuth client ID and secret. A request
for `Authorization: Bearer` and custom headers was filed and closed as not planned:

https://github.com/anthropics/claude-ai-mcp/issues/112

So a token-authed MCP endpoint cannot be added as a connector on claude.ai. Two stages:

**Stage one, now.** Token-authed MCP endpoint. Added to Claude Desktop's local MCP config,
where headers are supported. Works on the Mac with the desktop app running.

**Stage two, later.** Add OAuth so it becomes a real connector that works everywhere,
including the phone. The endpoint and tools carry over unchanged. Only the way it proves
identity changes. Roughly 90 percent of stage one is reused.

For stage two the two hard parts already exist. The sign in screen is the authorize step,
and `OwnerAuth` plus the session store is the identity. What is missing is the metadata
endpoints, client registration, a token endpoint, and one migration.

## What the codebase requires of you

Read these before writing anything. Each one will fail the build if ignored.

**`src/server/auth/plugin.ts`** is the door. An `onRequest` hook refuses every path under
`/api/` unless a session resolves, whatever the route does or does not call. New routes are
closed by default, which is the point.

**`PUBLIC_API_PATHS` in that file is empty and must stay empty.** The comment above it says
adding a line opens that address to everyone who finds the URL. The MCP endpoint does not go
there. Instead the `onRequest` hook learns a second credential: a bearer token that resolves
to the same founder row a cookie would.

**`src/server/auth/tokens.ts`** already has the crypto. `newSecret` for 32 bytes base64url,
`sha256Hex` for storage, `secretsMatch` for constant time comparison. Use these. Do not
write new ones and do not compare with `===`.

**`src/server/routes/contract.test.ts`** walks the route list against every path
`src/web/lib/api.ts` names, and fails in both directions. A route with nothing calling it
fails the build. The MCP routes are called by an external client, not the browser, so this
test needs an explicit allowance rather than a workaround.

**Four lint rules fail in the editor.** No `shell: true` anywhere. No `process.env` outside
`src/server/env.ts`. No `fetch` against a vendor outside one function. No date formatting in
the GoHighLevel modules outside one file. `eslint.config.js` explains each where it is defined.

**One test runner.** `node:test` with `node:assert/strict`. There is no `expect` and no
`it.each`. Write a `for` loop around the `it` so a failure still names the case.

**House style applies to every string a founder reads.** No em dashes or en dashes. Ranges
written as "11 to 13". Short sentences. No marketing language. Explain jargon inline.

## The four tools, and the one that needs care

**Read files and Brain.** Straightforward. `ge_file` and `ge_file_version` in Postgres are
the record. `src/server/routes/files.ts` already has the listing and the per file read.

**Check state and progress.** Also straightforward. `src/server/routes/home.ts` has
`progressOf` and `nextRouteId`. `founder-state.ts` has the gate status and the track filter.

**Run a full engine turn.** Needs design. A turn runs 30 to 180 seconds and the browser holds
an SSE stream open while an ordinary POST returns 202 immediately. An MCP tool call cannot sit
and wait that long. Split it: one tool posts the message and returns a run id, a second polls
for the result. `src/server/routes/turn-executor.ts` and `events.ts` are where the existing
queue and event bus live.

**Write files back.** This is the one to think hardest about. Inside the app a file that
invents a number not in the Brain gets held by the runtime rules gate before it saves. A write
that comes in through a new endpoint must go through that same gate. Otherwise the endpoint
becomes the way the rule stops applying, and that rule is one of the six the app exists to
enforce. Expect writes to be rejected sometimes. That is correct behaviour, not a bug.

## Things not to change

`replit.md` names three of these and it is right about all three.

`TZ` is pinned to UTC in `.replit` and the server refuses to start if it is anything else.

Reserved VM rather than Autoscale is load bearing. Turns run 30 to 180 seconds, SSE
connections idle for minutes, and Autoscale enforces request timeouts and scales to zero.
The queue and the live session map are in memory, so one VM means one place that state lives.

Do not set `ANTHROPIC_API_KEY` as an environment variable. The key is pasted into the app's
own Setup screen, which checks it against Anthropic for validity and credit before accepting.
An environment variable is checked by nobody.

## Suggested order

1. `npm ci && npm test` on a clean clone. Confirm green before changing anything.
2. Migration and a token table. Reuse the `tokens.ts` crypto.
3. Teach the `onRequest` hook the bearer path. Extend `plugin.test.ts` in the same commit.
4. The MCP endpoint, read-only tools first. Prove it from the desktop config.
5. The turn tools, post and poll.
6. The write tool, routed through the rules gate.
7. OAuth, once the surface has earned it.

## Settled

Pete is forking and is done taking upstream changes. Nothing goes back as a pull request and
nothing comes in by merge. Upstream stays the source other founders copy. This fork is his.
