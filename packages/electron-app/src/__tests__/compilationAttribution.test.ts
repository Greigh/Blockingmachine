/**
 * The hub passes each source's identity into the category attribution.
 *
 * The manifest the hub writes beside its compiled lists is the record a build cites for
 * "what was this built from" — and that is a question about *sources*, not categories. The
 * identity exists exactly once in the flow: `sourceResults` pairs each parsed rule list with
 * the `FilterSource` it was fetched for, and the deduplication that runs next keeps only the
 * first copy of a rule. The last place the mapping can cross into `buildCategoryAttribution`
 * is therefore the call itself — passing category buckets again would compile cleanly and
 * write a manifest that can no longer name its inputs.
 *
 * `index.ts` cannot be imported — importing it starts the Electron main process — so this
 * reads the call site the way `exportFormatDeployCoverage` reads the format validator.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));

/** The slice of the compile handler that builds and renders the attribution. */
function readAttributionCallSite(): string {
  const main = readFileSync(join(appRoot, 'src/index.ts'), 'utf8');
  const start = main.indexOf('buildCategoryAttribution(');
  if (start < 0) throw new Error('the buildCategoryAttribution call was not found in index.ts');
  const end = main.indexOf('toAttributionManifest(', start);
  if (end < 0) throw new Error('the attribution call site is unterminated in index.ts');
  return main.slice(start, end);
}

describe('hub compilation source provenance', () => {
  test('the attribution is built per source, carrying what the manifest will name', () => {
    const callSite = readAttributionCallSite();
    // One entry per configured source — not per category bucket — so a source that produced
    // rules in two categories, or rules in none, is still one entry on the record.
    expect(callSite).toContain('sourceResults.map(');
    expect(callSite).toContain('res.source.name');
    expect(callSite).toContain('res.source.url');
    expect(callSite).toContain('res.source.category');
    // A fetch that failed is recorded as attempted, so "configured" and "produced" stay two
    // different sentences the manifest can tell apart.
    expect(callSite).toContain('res.error');
  });
});
