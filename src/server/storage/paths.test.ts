/**
 * src/server/storage/paths.test.ts
 *
 * WHAT THIS IS. The tenancy boundary under test.
 *
 * WHY IT EXISTS. paths.ts is the only thing between a string that arrived from a model
 * Write, a download URL or a founder's own typing and a file on disk. Every case below
 * is a way somebody has escaped a directory somewhere. The assertions are negative on
 * purpose: the strongest thing to prove about this file is what it refuses.
 *
 * WHAT IT CALLS. src/server/storage/paths.ts only. No database, no filesystem.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFounderId,
  assertSafeRelPath,
  extensionOf,
  isUploadPath,
  UPLOAD_EXTENSIONS,
  uploadSlug,
  founderRoot,
  geHome,
  isExcludedPath,
  isPersonFile,
  personFilePath,
  personSlug,
  PathRefused,
  relFromGeHome,
  resolveInGeHome,
} from './paths.ts';

const FOUNDER = '01J8ZQTMK4NRC7XVYB3D9GHF2W';

describe('assertFounderId', () => {
  it('takes a ULID', () => {
    assert.equal(assertFounderId(FOUNDER), FOUNDER);
  });

  // One test per row, so a failure names the case rather than the loop.
  for (const [what, value] of [
    ['an email address', 'sam@example.com'],
    ['a path walk', '../other'],
    ['a slash', 'aa/bb'],
    ['too short', '01J8ZQTMK4NRC7XVYB3D9GHF2'],
    ['too long', `${FOUNDER}X`],
    ['lower case', FOUNDER.toLowerCase()],
    ['the letter I, which Crockford base32 leaves out', '01J8ZQTMK4NRC7XVYB3D9GHF2I'],
    ['empty', ''],
  ] as const) {
    it(`refuses ${what}`, () => {
      assert.throws(() => assertFounderId(value), PathRefused);
    });
  }
});

describe('assertSafeRelPath', () => {
  for (const rel of [
    'founder-brain.md',
    'people/sam-example-com.md',
    '.state/index.md',
    '.state/snapshots/ledger.md.20260827T021256Z',
    '.state/snapshots/people__sam-example-com.md.20260827T021255Z',
    'voice-samples/a note with spaces.md',
    '.gitignore',
  ] as const) {
    it(`allows ${rel}`, () => {
      assert.equal(assertSafeRelPath(rel), rel);
    });
  }

  for (const [what, rel] of [
    ['absolute', '/etc/passwd'],
    ['a parent walk', '../../etc/passwd'],
    ['a parent walk in the middle', 'people/../../etc/passwd'],
    ['a bare dot segment', './founder-brain.md'],
    ['an empty segment', 'people//sam.md'],
    ['a backslash', 'people\\sam.md'],
    ['a drive letter', 'C:/windows/system32'],
    ['a trailing slash', 'people/'],
    ['a leading dash, which ge would read as a flag', '-rf.md'],
    ['a leading dash inside a folder', 'people/-x.md'],
    ['a trailing space, which a founder cannot see in a file list', 'brain.md '],
    ['a trailing space on a folder segment', 'people /sam.md'],
    ['a trailing dot', 'brain.md.'],
    ['a tab', 'brain\t.md'],
    ['a newline', 'brain\n.md'],
    ['a null byte', 'ok.md\u0000../../etc/passwd'],
    ['a delete character', 'ok\u007f.md'],
    ['empty', ''],
  ] as const) {
    it(`refuses ${what}`, () => {
      assert.throws(() => assertSafeRelPath(rel), PathRefused);
    });
  }

  it('refuses a path longer than the cap', () => {
    assert.throws(() => assertSafeRelPath(`${'a'.repeat(500)}.md`), PathRefused);
  });
});

describe('resolveInGeHome', () => {
  it('lands inside the founder folder', () => {
    const abs = resolveInGeHome(FOUNDER, 'people/sam-example-com.md');
    assert.equal(abs.startsWith(geHome(FOUNDER)), true);
    assert.equal(abs.endsWith('/growth-engine/people/sam-example-com.md'), true);
  });

  it('refuses to leave it, however the escape is spelled', () => {
    assert.throws(() => resolveInGeHome(FOUNDER, '../../../etc/passwd'), PathRefused);
    assert.throws(() => resolveInGeHome(FOUNDER, '/etc/passwd'), PathRefused);
  });

  it('never lets one founder name another founder folder', () => {
    const other = '01J8ZQTMK4NRC7XVYB3D9GHF2X';
    assert.notEqual(founderRoot(FOUNDER), founderRoot(other));
    assert.throws(() => resolveInGeHome(FOUNDER, `../../${other}/growth-engine/people/x.md`), PathRefused);
  });
});

describe('relFromGeHome', () => {
  it('is the inverse of resolveInGeHome', () => {
    const rel = 'people/sam-example-com.md';
    assert.equal(relFromGeHome(FOUNDER, resolveInGeHome(FOUNDER, rel)), rel);
  });

  it('refuses a path from outside the folder', () => {
    assert.throws(() => relFromGeHome(FOUNDER, '/etc/passwd'), PathRefused);
  });
});

describe('isExcludedPath', () => {
  it('excludes the memory lock, because a harvested lock never unlocks', () => {
    assert.equal(isExcludedPath('.state/memory.lock'), true);
  });

  it('excludes a half written temporary file', () => {
    assert.equal(isExcludedPath('ledger.md.ge-tmp.4321'), true);
    assert.equal(isExcludedPath('.state/index.md.ge-tmp.99'), true);
  });

  it('KEEPS .state/undone, which is what makes pressing undo twice safe', () => {
    assert.equal(isExcludedPath('.state/undone'), false);
  });

  it('KEEPS snapshots, because content addressing makes them nearly free', () => {
    assert.equal(isExcludedPath('.state/snapshots/ledger.md.20260827T021256Z'), false);
  });

  it('keeps every ordinary founder file', () => {
    for (const rel of ['founder-brain.md', 'content-30.md', 'people/sam-example-com.md', '.state/index.md']) {
      assert.equal(isExcludedPath(rel), false);
    }
  });
});

describe('personSlug, the derive rule from schemas/person.md', () => {
  it('matches the two worked examples in the schema', () => {
    assert.equal(personSlug('sam@example.com'), 'sam-example-com');
    assert.equal(personSlug('ig:lumen.skin'), 'ig-lumen-skin');
  });

  it('lower cases, collapses runs of dashes and trims them', () => {
    assert.equal(personSlug('Sam...@@@Example.COM'), 'sam-example-com');
    assert.equal(personSlug('---sam---'), 'sam');
  });

  it('cuts to 60 characters and does not leave a trailing dash behind', () => {
    const slug = personSlug(`${'a'.repeat(59)}@example.com`);
    assert.ok(slug.length <= 60, `the slug is ${slug.length} characters, over the 60 cap`);
    assert.equal(slug.endsWith('-'), false);
  });

  it('builds a people path that passes the path check', () => {
    const rel = personFilePath('sam@example.com');
    assert.equal(rel, 'people/sam-example-com.md');
    assert.equal(assertSafeRelPath(rel), rel);
    assert.equal(isPersonFile(rel), true);
  });

  it('refuses a key that derives nothing', () => {
    assert.throws(() => personFilePath('@@@'), PathRefused);
  });
});

/**
 * THE UPLOAD NAME RULE, AND WHY IT IS THE ONE THING IN THIS FILE THAT SANITISES.
 *
 * Everything else here refuses, because everything else is a path this product
 * built and a bad one is a bug. An uploaded file's name is typed by a person, so
 * `Sam's post (final).pdf` is the ordinary case and not an attack.
 *
 * The cost of getting it wrong is not a refused upload. assertSafeRelPath runs on
 * every ge_file row inside materialise, before the rebuild decision, so a name it
 * refuses written into the record throws PathRefused out of every future turn,
 * permanently. Which is why the output of this function is asserted to survive
 * assertSafeRelPath rather than merely to look tidy.
 */
describe('the name a founder can actually upload under', () => {
  it('keeps what founders really call their files, and produces something storable', () => {
    const real = [
      "Sam's post (final).pdf",
      'my-résumé.md',
      '-lead.md',
      'Notes, draft 2.TXT',
      'photo 1.JPG',
      '~/Desktop/deep/folder/sample.md',
      'C:\\Users\\sam\\notes.md',
    ];
    for (const name of real) {
      const slug = uploadSlug(name);
      // The real assertion. Not "it looks nice": that it cannot wedge materialise.
      assert.doesNotThrow(
        () => assertSafeRelPath(`voice-samples/${slug}`),
        `voice-samples/${slug} would throw out of every future materialise`,
      );
    }
  });

  it('never lets a directory out of the name', () => {
    // A path in the name is the browser's business, not ours. Only the last part
    // is a file name, and neither separator may survive into the record.
    assert.equal(uploadSlug('../../etc/passwd.md'), 'passwd.md');
    assert.equal(uploadSlug('a/b/c/notes.md'), 'notes.md');
    assert.doesNotMatch(uploadSlug('C:\\Users\\sam\\notes.md'), /[\\/]/);
  });

  it('keeps the extension, because the extension is what decides readability', () => {
    assert.equal(extensionOf('Report.PDF'), '.pdf');
    assert.equal(extensionOf('a.b.tar.gz'), '.gz');
    assert.equal(extensionOf('noextension'), '');
    assert.equal(extensionOf('.hidden'), '', 'a leading dot is not an extension');
    assert.ok(uploadSlug('Report.PDF').endsWith('.pdf'));
  });

  it('still yields a name when there is nothing left to work with', () => {
    // Every character stripped would otherwise produce `voice-samples/`, which
    // assertSafeRelPath reads as a folder and refuses.
    assert.equal(uploadSlug('...pdf'), 'sample.pdf');
    assert.equal(uploadSlug('!!!.md'), 'sample.md');
  });
});

/**
 * The allowed list is measured against the model's own Read tool, not chosen, so
 * the test that matters is that the formats Read REFUSES are absent from it.
 * Accepting one would mean storing a file, charging it against the founder's
 * limits, showing it in their Files, and then having the model say it cannot open
 * it, which is a worse outcome than refusing at the upload screen.
 */
describe('what may be uploaded', () => {
  it('holds nothing the model cannot open', () => {
    // Refused by Read outright, with "This tool cannot read binary files".
    for (const ext of ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.bmp', '.tiff']) {
      assert.equal(UPLOAD_EXTENSIONS.includes(ext), false, `${ext} cannot be read by the model`);
    }
    // In neither of Read's sets, so it is not refused and is read as text. That is
    // worse than a refusal, and it is an iPhone's default.
    assert.equal(UPLOAD_EXTENSIONS.includes('.heic'), false, 'heic is read as text, silently');
  });

  it('holds the ones a founder is most likely to have', () => {
    for (const ext of ['.md', '.txt', '.pdf', '.png', '.jpg']) {
      assert.equal(UPLOAD_EXTENSIONS.includes(ext), true, ext);
    }
  });
});

describe('which paths are uploads', () => {
  it('covers what is inside the folder and never the folder itself', () => {
    assert.equal(isUploadPath('voice-samples/sample.md'), true);
    assert.equal(isUploadPath('voice-samples/'), false, 'the folder is not a file');
    assert.equal(isUploadPath('voice-samples'), false);
    assert.equal(isUploadPath('founder-brain.md'), false);
    // The check gates a refusal that protects a founder's whole turn, so a path
    // that merely starts with the same letters must not slip through it.
    assert.equal(isUploadPath('voice-samples-old/x.md'), false);
  });
});
