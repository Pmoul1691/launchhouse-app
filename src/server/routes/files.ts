/**
 * src/server/routes/files.ts
 *
 * WHAT THIS IS. Rule 4 as five HTTP routes: list what a founder has, open one
 * file, download one file, download the whole folder as a ZIP, and the one that
 * honestly refuses to save a pasted sample yet.
 *
 * WHY IT EXISTS. On a laptop this rule held itself. The files were in a folder
 * the founder could open, and if they could not find it that was their problem
 * and their fix. On a server it is our problem, and the ways to break it are
 * quiet ones.
 *
 *   SERVED FROM THE RECORD, NOT FROM THE SCRATCH FOLDER. `/tmp/ge/<id>/` is a
 *   cache and is not durable. A download that read it would hand a founder an
 *   empty folder after a container restart, or worse, half of one. Every byte
 *   here comes from `ge_blob`, decrypted with that founder's own data key.
 *
 *   NOTHING USER SUPPLIED IS EVER USED AS A PATH. The requested name is checked
 *   against the safe path rule and then against this founder's own `ge_file`
 *   rows. A name that is not in their own list does not resolve, whatever it
 *   looks like. That is what makes `../../etc/passwd` and somebody else's slug
 *   the same non answer.
 *
 *   THE ZIP HOLDS REAL PEOPLE. A founder's `people/` folder is 25 to 35 real
 *   names, companies, titles and email addresses, none of whom agreed to be in
 *   our database. Session authenticated, own id only, never an id from a query
 *   parameter. There is no route in this file that takes a founder id.
 *
 *   RULE 1 IS CHECKED HERE TOO, on every route. `ge index` forks on the Track
 *   line, so a founder's folder does not normally hold the other track's files
 *   at all, and the browser drops such a row if one arrives. That leaves this
 *   as the middle of the three, and it is the only one of them that a typed
 *   address cannot walk past. A file belonging to the other track is absent
 *   from the list, absent from the ZIP, and answers as a missing file when it
 *   is asked for by name.
 *
 *   THE LIST CARRIES FILES THAT DO NOT EXIST YET, on purpose. A founder in week
 *   one has almost nothing, and a list of what they have is a blank screen. A
 *   list of what they will have, with "Not made yet" against most of it, is the
 *   programme. So the rows are the gate table for their track, each carrying
 *   its real state, plus anything else of theirs the table does not name.
 *
 * WHAT CALLS IT. ./index.ts registers it. The files screen and every download
 * button call it.
 *
 * WHAT IT READS. `ge_file` and `ge_blob`, founder scoped, through the AppStore.
 * `schemas/gates.md`, through the rules gate, for which track sees which file
 * and which gate each one counts towards.
 * WHAT IT WRITES. Nothing.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { GATE_FILES } from '../../../app/content/gates.ts';
import { gateLabelForFile, trackForFile } from '../rules/index.ts';
import { assertSafeRelPath, GE_FOLDER, PathRefused } from '../storage/paths.ts';
import { trackFilter } from './founder-state.ts';
import type { FileStatus } from './founder-state.ts';
import { ERRORS, errorBody, type FounderError } from './errors.ts';
import { extensionOf, LIMIT_FILE_BYTES, UPLOAD_EXTENSIONS } from '../storage/paths.ts';
import { ZipTooLarge, buildZip, type ZipEntry } from './zip.ts';
import type { FileRow } from './ports.ts';
import type { RouteDeps } from './deps.ts';

/** What the files screen renders for one row. The browser's FileRow, exactly. */
export interface FileListRow {
  readonly name: string;
  readonly gateLabel: string;
  readonly status: FileStatus;
  readonly sizeBytes: number;
  readonly changedAt: string | null;
  readonly kind: 'markdown' | 'csv' | 'folder' | 'other';
  readonly track: 'both' | 'b2b' | 'b2c';
  /** Only for `people/`, where the row is a count that expands. */
  readonly count?: number;
}

/**
 * The most this route will read off the wire.
 *
 * The file limit plus a little, because a body is the file and nothing else and
 * the founder facing refusal should be the one in FILE_ERRORS rather than
 * Fastify's. The instance limit is 1 MB, which is BELOW the 2 MB a file may be,
 * so without this the first wall a founder meets is one nobody wrote a sentence
 * for.
 */
const UPLOAD_BODY_LIMIT = LIMIT_FILE_BYTES + 64 * 1024;

/**
 * The founder's own file name, out of the header the browser encoded it into.
 *
 * Encoded because it is theirs: an apostrophe or an accent in a file name is the
 * ordinary case, and a raw one in a header is where that goes wrong. A value that
 * will not decode is treated as no name at all rather than guessed at.
 */
function decodedName(header: string | undefined): string {
  try {
    return decodeURIComponent(header ?? '').trim();
  } catch {
    return '';
  }
}

/** One refusal, said once. Every upload refusal is a sentence, not a stack. */
function send(reply: FastifyReply, error: FounderError): FastifyReply {
  return reply.code(error.status).send(errorBody(error));
}

export const FILE_ERRORS = {
  /**
   * Saving a pasted sample as a file. Not built, and 501 says so.
   *
   * A single file written outside a turn would have to materialise the folder,
   * write into it and harvest it, which is the turn machinery, without the
   * advisory lock that stops two of those racing. Doing that here would mean a
   * founder's sample landing in a folder another turn is about to roll back.
   * That is storage's decision to make and not this layer's, so the route says
   * what is true and gives the founder something that works today.
   */
  /**
   * A format the model cannot open. The list is measured, not chosen: see
   * UPLOAD_EXTENSIONS in ../storage/paths.ts.
   *
   * The message names the fix rather than the rule, because "unsupported file
   * type" leaves a founder holding a Word document with nowhere to go, and the
   * answer is eight seconds of work they already know how to do.
   */
  uploadWrongType: {
    status: 415,
    code: 'upload_wrong_type',
    message:
      'We can read plain text, Markdown, CSV, PDF and photos saved as PNG, JPG, GIF or WEBP. Word documents cannot be read, and neither can the HEIC photos an iPhone saves by default. For a Word file, open it, choose File then Save As, and pick PDF. For a photo, send it to yourself by email or message first, which converts it.',
  },
  uploadTooLarge: {
    status: 413,
    code: 'upload_too_large',
    message:
      'That file is bigger than 2 MB, which is the most one file can be. Nothing else is affected. A long document saved as a PDF is usually well under it, and a photo can be made smaller by sending it to yourself at a smaller size.',
  },
  uploadNoRoom: {
    status: 413,
    code: 'upload_no_room',
    message:
      'Your folder is full, so this was not saved and nothing else has changed. Delete something you no longer need, or ask in Slack.',
  },
  /**
   * The one refusal that is about timing rather than the file.
   *
   * It says wait, because waiting works. A founder who uploads while an engine
   * is mid run is doing something reasonable, and the answer is thirty seconds
   * rather than a fault.
   */
  uploadBusy: {
    status: 409,
    code: 'upload_busy',
    message:
      'One of your engines is running, so this was not saved. Nothing is lost and nothing is broken. Wait for it to finish, then add the file again.',
  },
  uploadEmpty: {
    status: 400,
    code: 'upload_empty',
    message: 'That file is empty, so there was nothing to save. Check you picked the right one and try again.',
  },
  uploadNoName: {
    status: 400,
    code: 'upload_no_name',
    message: 'That file arrived without a name, so we could not save it. Try again, and if it happens twice say so in Slack.',
  },
} as const satisfies Record<string, FounderError>;

/**
 * What a browser should do with each kind of file.
 *
 * Markdown is served as text/markdown and not text/html, deliberately. A
 * founder's own file rendered as HTML in their own origin is a stored cross
 * site scripting hole with the founder as both author and victim, and the
 * markdown in these files is written by a model.
 */
export function contentTypeFor(path: string): string {
  if (path.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (path.endsWith('.csv')) return 'text/csv; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/** The file name a founder sees when they save one. Slashes become dashes. */
export function downloadNameFor(path: string): string {
  return path.replace(/\//g, '-');
}

/** How the screen renders a row. A trailing slash is a folder, and only `people/` is one. */
export function kindOf(path: string): FileListRow['kind'] {
  if (path.endsWith('/')) return 'folder';
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.csv')) return 'csv';
  return 'other';
}

/**
 * Which track a file belongs to.
 *
 * `both` for anything the gate table does not name, and that is rule 4 winning
 * the tie: hiding a founder's own file because no table happens to list it is a
 * worse failure than showing it. What rule 1 guards against is the other
 * track's material, which the table does name.
 */
function trackOfFile(path: string): FileListRow['track'] {
  const known = trackForFile(path);
  return known === 'b2b' || known === 'b2c' ? known : 'both';
}

/**
 * Decode a path segment, whether or not the router already decoded it.
 *
 * find-my-way decodes a `:param` and hands a wildcard back as it arrived, and
 * both forms reach the handlers below. Decoding an already decoded name would
 * turn a legitimate `%` in a file name into a broken escape and throw, so this
 * decodes only when there is an escape to decode, and it refuses rather than
 * guesses when that escape is malformed.
 */
export function safeDecode(value: string): string {
  return value.includes('%') ? decodeURIComponent(value) : value;
}

/**
 * The one file the laptop version never had.
 *
 * It is here rather than in a content file because it describes the download
 * itself, and because the sentence about the folder being theirs to keep is the
 * point of rule 4 written where the founder will actually read it.
 */
export function readmeFor(files: readonly FileRow[], today: string): string {
  const lines = [
    '# Your files',
    '',
    'This folder is yours. Keep it, copy it, edit it. Nothing here needs the app to open it.',
    '',
    'Every file is plain text. Markdown opens in any text editor and in most note apps.',
    'CSV opens in a spreadsheet.',
    '',
    `Downloaded ${today}.`,
    '',
    '## What is in here',
    '',
  ];
  for (const f of files) {
    lines.push(`- growth-engine/${f.path}, ${String(f.sizeBytes)} bytes`);
  }
  lines.push('');
  lines.push('The `.state` folder is the toolkit\'s own bookkeeping. It is included because it is');
  lines.push('yours too, and because it is what lets somebody put a file back the way it was.');
  lines.push('');
  lines.push('If a file you expected is missing, open the files screen in the app and check it is');
  lines.push('there. If it is there and not here, tell a mentor.');
  return lines.join('\n');
}

/**
 * The rows the files screen shows, in build order.
 *
 * The gate table first, because that is the order `ge index` already builds and
 * the order the programme runs in, then everything else of theirs the table
 * does not name. A row that has not been made yet still appears, with its real
 * state, because the list is also the map of what is coming.
 */
export function listRowsFor(
  held: readonly FileRow[],
  mayShow: (path: string) => boolean,
): { rows: readonly FileListRow[]; stateRows: readonly FileListRow[] } {
  const visible = held.filter((r) => mayShow(r.path));
  const byPath = new Map(visible.map((r) => [r.path, r]));
  const named = new Set<string>();

  const rows: FileListRow[] = [];
  for (const entry of GATE_FILES) {
    if (!mayShow(entry.file)) continue;

    if (entry.file.endsWith('/')) {
      // A folder is one row with a count, rather than 25 to 35 rows of real
      // people's names filling the screen between two files.
      const inside = visible.filter((r) => r.path.startsWith(entry.file));
      for (const r of inside) named.add(r.path);
      const newest = inside.reduce<Date | null>(
        (latest, r) => (latest === null || r.mtime > latest ? r.mtime : latest),
        null,
      );
      rows.push({
        name: entry.file,
        gateLabel: entry.gateLabel,
        status: inside.length === 0 ? 'missing' : inside.some((r) => r.sizeBytes > 0) ? 'ok' : 'empty',
        sizeBytes: inside.reduce((n, r) => n + r.sizeBytes, 0),
        changedAt: newest?.toISOString() ?? null,
        kind: 'folder',
        track: trackOfFile(entry.file),
        count: inside.length,
      });
      continue;
    }

    const found = byPath.get(entry.file);
    if (found !== undefined) named.add(entry.file);
    rows.push({
      name: entry.file,
      gateLabel: entry.gateLabel,
      status: found === undefined ? 'missing' : found.sizeBytes > 0 ? 'ok' : 'empty',
      sizeBytes: found?.sizeBytes ?? 0,
      changedAt: found?.mtime.toISOString() ?? null,
      kind: kindOf(entry.file),
      track: trackOfFile(entry.file),
    });
  }

  const stateRows: FileListRow[] = [];
  for (const r of visible) {
    if (named.has(r.path)) continue;
    const row: FileListRow = {
      name: r.path,
      gateLabel: gateLabelForFile(r.path) ?? '-',
      status: r.sizeBytes > 0 ? 'ok' : 'empty',
      sizeBytes: r.sizeBytes,
      changedAt: r.mtime.toISOString(),
      kind: kindOf(r.path),
      track: trackOfFile(r.path),
    };
    // `.state/` is the toolkit's own bookkeeping. Shown rather than hidden,
    // behind a disclosure, because a folder we hide is a folder they do not own.
    if (r.path.startsWith('.state/')) stateRows.push(row);
    else rows.push(row);
  }

  return { rows, stateRows };
}

export async function registerFileRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  /**
   * The list.
   *
   * A row held back is logged, because it means either the fork upstream is
   * wrong or a file arrived that should not exist, and both are worth knowing
   * about before the Saturday.
   */
  app.get('/api/files', async (request, reply) => {
    if (!(await deps.auth.requireFounder(request, reply))) return reply;
    const founder = deps.auth.founderOf(request);
    const mayShow = trackFilter(deps, founder, reply);
    if (mayShow === null) return reply;

    const held = await deps.store.listFiles(founder.id);
    const kept = held.filter((r) => mayShow(r.path)).length;
    if (kept !== held.length) {
      deps.log.warn(
        { founderId: founder.id, count: held.length - kept },
        'files were kept out of the list because they belong to the other track',
      );
    }
    return reply.send(listRowsFor(held, mayShow));
  });

  /**
   * RAW BYTES, NOT MULTIPART, and that is a decision rather than a shortcut.
   *
   * @fastify/multipart is the obvious answer and it costs a dependency. This
   * app is forked and `npm ci`'d by 130 non technical people, and 32 of the 476
   * entries already in package-lock.json resolve to Replit's own package
   * firewall, so regenerating that lock is a real risk taken in a room with no
   * time in it. One file per request needs no envelope: the body IS the file and
   * the name rides in a header.
   *
   * `parseAs: 'buffer'` because the bytes are a PDF as often as they are text,
   * and anything that decodes them as UTF-8 on the way in has already lost them.
   */
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: UPLOAD_BODY_LIMIT },
    (_req, body, done) => { done(null, body); },
  );

  /**
   * One file a founder uploaded, into voice-samples/.
   *
   * WHAT THIS ROUTE DOES NOT DO, because the 501 that used to live here was
   * right about the danger and wrong about the shape. It never materialises the
   * folder, never writes to disk and never harvests, so it never races ge for
   * the folder. It writes the record, and the version bump invalidates the
   * epoch, so the next turn rebuilds and the file is simply there.
   *
   * The route's own bodyLimit is above the instance's 1 MB, which is smaller
   * than the 2 MB a file may be. Without it the wall a founder hits first is
   * Fastify's, which answers with a message nobody wrote.
   */
  app.post(
    '/api/files/voice-samples',
    { bodyLimit: UPLOAD_BODY_LIMIT },
    async (request, reply) => {
      if (!(await deps.auth.requireFounder(request, reply))) return reply;
      const founder = deps.auth.founderOf(request);

      const raw = request.headers['x-upload-name'];
      const name = decodedName(Array.isArray(raw) ? raw[0] : raw);
      if (name === '') return send(reply, FILE_ERRORS.uploadNoName);

      if (!UPLOAD_EXTENSIONS.includes(extensionOf(name))) {
        deps.log.info({ founderId: founder.id, ext: extensionOf(name) }, 'upload refused on type');
        return send(reply, FILE_ERRORS.uploadWrongType);
      }

      const bytes = request.body;
      if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
        return send(reply, FILE_ERRORS.uploadEmpty);
      }

      const outcome = await deps.store.saveUpload(founder.id, { name, bytes });
      if (outcome.ok) {
        deps.log.info(
          { founderId: founder.id, path: outcome.path, sizeBytes: outcome.sizeBytes },
          'a founder added a file of their own',
        );
        return reply.code(201).send({ path: outcome.path, sizeBytes: outcome.sizeBytes });
      }

      // Every one of these is an ordinary answer rather than a fault, so each
      // gets the sentence written for it rather than a generic failure.
      if (outcome.reason === 'turn_in_flight') return send(reply, FILE_ERRORS.uploadBusy);
      if (outcome.reason === 'too_large') return send(reply, FILE_ERRORS.uploadTooLarge);
      return send(reply, FILE_ERRORS.uploadNoRoom);
    },
  );

  /**
   * Everything, as one ZIP, built from the database in one pass.
   *
   * Snapshots are excluded by default. They are the `ge` undo ring, they are
   * ten deep, and a founder opening their download wants the twelve files they
   * made rather than a hundred and twenty. `?snapshots=1` includes them.
   *
   * The track filter runs first, and it runs on the snapshots too. A snapshot's
   * name carries the file it is a copy of, so `?snapshots=1` is not a way for
   * the other track's material to arrive inside a ZIP with a timestamp on the
   * end. The README lists what is actually in the archive, because it is built
   * from the same filtered set.
   *
   * `download.zip` is a static two segment path, so the router matches it ahead
   * of `/api/files/*`. The contract test asserts that rather than trusting a
   * precedence rule to stay the same across a router upgrade.
   */
  app.get('/api/files/download.zip', async (request, reply) => {
    if (!(await deps.auth.requireFounder(request, reply))) return reply;
    const founder = deps.auth.founderOf(request);
    const mayShow = trackFilter(deps, founder, reply);
    if (mayShow === null) return reply;
    const q = request.query as { snapshots?: string };
    const withSnapshots = q.snapshots !== undefined;

    const held = await deps.store.readAllFiles(founder.id);
    const all = held.filter((f) => mayShow(f.row.path));
    if (all.length !== held.length) {
      deps.log.warn(
        { founderId: founder.id, count: held.length - all.length },
        'files were kept out of the download because they belong to the other track',
      );
    }
    const wanted = all.filter((f) => withSnapshots || !f.row.path.startsWith('.state/snapshots/'));

    const entries: ZipEntry[] = wanted.map((f) => ({
      name: `${GE_FOLDER}/${f.row.path}`,
      bytes: f.bytes,
    }));
    entries.push({
      name: `${GE_FOLDER}/README-your-files.md`,
      bytes: Buffer.from(
        readmeFor(
          wanted.map((f) => f.row),
          deps.clock.now().toISOString().slice(0, 10),
        ),
        'utf8',
      ),
    });

    let archive: Buffer;
    try {
      archive = buildZip(entries);
    } catch (err) {
      if (err instanceof ZipTooLarge) {
        deps.log.error({ founderId: founder.id }, 'a download was refused for size');
        return reply.code(ERRORS.tooLarge.status).send(errorBody(ERRORS.tooLarge));
      }
      throw err;
    }

    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', 'attachment; filename="growth-engine.zip"');
    reply.header('cache-control', 'private, no-store');
    return reply.send(archive);
  });

  /**
   * One file, saved rather than read.
   *
   * The name is one URL segment, because the browser encodes the slash in
   * `people/ada.md`. A folder name, which is only ever `people/`, is answered
   * as a ZIP of that folder: the list shows it as one row with a count and a
   * download button beside it, and a button that answers 404 is worse than no
   * button.
   */
  app.get('/api/files/:name/download', async (request, reply) => {
    if (!(await deps.auth.requireFounder(request, reply))) return reply;
    const founder = deps.auth.founderOf(request);
    const mayShow = trackFilter(deps, founder, reply);
    if (mayShow === null) return reply;

    let path: string;
    try {
      path = assertSafeRelPath(safeDecode((request.params as { name: string }).name));
    } catch (err) {
      if (err instanceof PathRefused || err instanceof URIError) {
        return reply.code(ERRORS.badPath.status).send(errorBody(ERRORS.badPath));
      }
      throw err;
    }

    if (!mayShow(path)) {
      deps.log.warn({ founderId: founder.id, path }, 'a download was refused because it belongs to the other track');
      return reply.code(ERRORS.noSuchFile.status).send(errorBody(ERRORS.noSuchFile));
    }

    if (path.endsWith('/')) {
      const inside = (await deps.store.readAllFiles(founder.id)).filter(
        (f) => f.row.path.startsWith(path) && mayShow(f.row.path),
      );
      if (inside.length === 0) return reply.code(ERRORS.noSuchFile.status).send(errorBody(ERRORS.noSuchFile));
      let archive: Buffer;
      try {
        archive = buildZip(inside.map((f) => ({ name: `${GE_FOLDER}/${f.row.path}`, bytes: f.bytes })));
      } catch (err) {
        if (err instanceof ZipTooLarge) return reply.code(ERRORS.tooLarge.status).send(errorBody(ERRORS.tooLarge));
        throw err;
      }
      reply.header('content-type', 'application/zip');
      reply.header('content-disposition', `attachment; filename="${downloadNameFor(path)}.zip"`);
      reply.header('cache-control', 'private, no-store');
      return reply.send(archive);
    }

    const found = await deps.store.readFile(founder.id, path);
    if (found === null) return reply.code(ERRORS.noSuchFile.status).send(errorBody(ERRORS.noSuchFile));

    reply.header('content-type', contentTypeFor(path));
    reply.header('content-disposition', `attachment; filename="${downloadNameFor(path)}"`);
    // Their own business data, and some of it is other people's contact
    // details. It must not sit in a shared cache anywhere between us and them.
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(found.bytes);
  });

  /**
   * One file, read on screen.
   *
   * The wildcard is the path inside `growth-engine/`. It is checked three
   * times: against the safe path rule, which refuses absolute paths, `..` and
   * control characters; against this founder's track; and against this
   * founder's own rows, which is the check that decides whether it exists.
   *
   * The track check comes before the read, so the other track's file is never
   * decrypted, and it answers as a missing file rather than as a refusal. That
   * is the same shape rule 1 takes everywhere else: the other track's material
   * is absent, not greyed out with a note saying what it is.
   */
  app.get('/api/files/*', async (request, reply) => {
    if (!(await deps.auth.requireFounder(request, reply))) return reply;
    const founder = deps.auth.founderOf(request);
    const mayShow = trackFilter(deps, founder, reply);
    if (mayShow === null) return reply;
    const wildcard = (request.params as Record<string, string>)['*'] ?? '';

    let path: string;
    try {
      path = assertSafeRelPath(safeDecode(wildcard));
    } catch (err) {
      if (err instanceof PathRefused || err instanceof URIError) {
        return reply.code(ERRORS.badPath.status).send(errorBody(ERRORS.badPath));
      }
      throw err;
    }

    if (!mayShow(path)) {
      deps.log.warn(
        { founderId: founder.id, path },
        'a file was not served because it belongs to the other track',
      );
      return reply.code(ERRORS.noSuchFile.status).send(errorBody(ERRORS.noSuchFile));
    }

    const found = await deps.store.readFile(founder.id, path);
    if (found === null) return reply.code(ERRORS.noSuchFile.status).send(errorBody(ERRORS.noSuchFile));

    reply.header('content-type', contentTypeFor(path));
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(found.bytes);
  });
}
