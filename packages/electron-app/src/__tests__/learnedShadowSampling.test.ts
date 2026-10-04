/**
 * The unbiased sample slice, and what it is allowed to contain.
 *
 * The M5 promotion gate has two readers of `learned-shadow.jsonl` and they need
 * different populations. Disagreements are the domains where the learned model differs
 * from the lists, which is a biased view of traffic by construction; the drift stage
 * computes PSI over *production* traffic against the training baseline, so it reads the
 * sample records instead. That slice is written by one number in one call site, and it
 * was silently absent: the hook called the scorer with two arguments, the third defaulted
 * to 0, and the failure mode was a healthy-looking app and a `drift.py` that exited with
 * "no sample records in the shadow log".
 *
 * So these tests are about the number being stated rather than defaulted, the file
 * actually holding a slice of ordinary traffic, and a sampled record holding exactly the
 * fields the privacy document names — which is the only way that document stays true.
 *
 * The model and the allowlist on disk are the real ones; only Electron's `app` is
 * replaced, so the log is written by the shipping path into a temp directory.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEARNED_SHADOW_SAMPLE_RATE } from '@blockingmachine/core';

let userData: string;
/** Swapped for a directory with no resolvable core package, to test the fail-soft path. */
let appPath: string;

jest.unstable_mockModule('electron', () => ({
  app: {
    // The real module resolves the weights relative to the app path and the shadow log
    // relative to userData. Both need to land in a temp directory for this suite.
    getPath: (_name: string) => userData,
    getAppPath: () => appPath,
  },
}));

const { shadowScoreWatchdogDomains } = await import('../learnedShadow');

/**
 * A synthetic sweep of plausible hosts, deliberately a *mix* of verdicts.
 *
 * The first fixture this suite used was `host0.example0.com`, `host1.example1.com`, … and
 * the shipped model blocks every one of them at 0.996 — a numeric label under a generic
 * word reads as generated, which is what the model is trained to catch. With an
 * always-`allow` reference that made all 4,000 domains disagreements, so the sample slice
 * held no agreement-only records at all and the test asserting there were some was
 * measuring the fixture rather than the code. Realistic names are the point: the drift
 * stage reads ordinary traffic, so the fixture has to be ordinary traffic.
 *
 * Measured against the shipped weights, this grid is about 62% `allow` and 38% not, so a
 * sweep of it contains both populations — which `is a mixed population` asserts, so a
 * future weight change cannot quietly make the tests below vacuous.
 */
const SUBDOMAINS = [
  'www', 'shop', 'blog', 'mail', 'static', 'api', 'news', 'docs', 'assets', 'media', 'img',
  'forum', 'help', 'store', 'careers', 'support', 'portal', 'intranet', 'download', 'secure',
  'my', 'account', 'billing', 'status', 'beta', 'edge', 'origin',
];
const NAMES = [
  'riverside', 'northgate', 'bluehill', 'market', 'garden', 'lakeside', 'oakfield', 'brightlane',
  'stonebrook', 'willow', 'summit', 'harbor', 'meadow', 'clearview', 'pinehill', 'fairview',
  'eastgate', 'redwood', 'silverpine', 'brookline', 'westfield', 'greenway', 'highland', 'birchwood',
];
const TLDS = [
  'co.uk', 'com', 'org', 'net', 'io', 'de', 'fr', 'ca', 'au', 'nl', 'se', 'es', 'it', 'pl', 'pt',
  'be', 'at', 'ch', 'dk', 'fi', 'no', 'cz', 'ie', 'nz', 'sg', 'hk', 'in', 'za', 'br', 'mx',
];

function sweepDomains(count: number): string[] {
  const grid: string[] = [];
  for (const tld of TLDS) {
    for (const name of NAMES) {
      for (const sub of SUBDOMAINS) {
        grid.push(`${sub}.${name}${tld}`);
      }
    }
  }
  return grid.slice(0, count);
}

function readLog(): Record<string, unknown>[] {
  const path = join(userData, 'learned-shadow.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * The log holds three kinds, and only two of them are about a domain: the per-sweep
 * `summary` carries counters and no hostname. Anything asking "which domains did we see"
 * has to exclude it, or the counters read as one more domain scored.
 */
function isPerDomain(record: Record<string, unknown>): boolean {
  return record.type !== 'summary';
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'bm-shadow-'));
  appPath = join(process.cwd(), 'package.json');
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('the drift sample rate is stated, not defaulted', () => {
  it('is the one-percent slice the gate is sized against', () => {
    // gate.py: min_shadow_days 7, min_shadow_scored 1000. A rate below this cannot fill
    // the smallest PSI bin; a rate above it buys nothing the smallest bin cannot see.
    expect(LEARNED_SHADOW_SAMPLE_RATE).toBe(0.01);
  });

  it('is a fraction, not a percentage or a flag', () => {
    expect(LEARNED_SHADOW_SAMPLE_RATE).toBeGreaterThan(0);
    expect(LEARNED_SHADOW_SAMPLE_RATE).toBeLessThanOrEqual(1);
  });
});

describe('a watchdog sweep writes the sample slice', () => {
  it('has a mixed population to sample from, or nothing below is measuring anything', () => {
    // Guards the fixture, not the code: if every domain in the grid earned the same
    // verdict, the slice would be all-agreement or all-disagreement and the independence
    // test would pass or fail for the wrong reason.
    const domains = sweepDomains(600);
    const result = shadowScoreWatchdogDomains(domains, () => 'allow', LEARNED_SHADOW_SAMPLE_RATE);
    expect(result).not.toBeNull();
    const records = readLog();
    expect(records.length).toBeGreaterThan(0);
    const disagreeing = records.filter((r) => isPerDomain(r) && r.sample !== true).length;
    expect(disagreeing).toBeGreaterThan(0);
    expect(disagreeing).toBeLessThan(records.length);
  });

  it('logs roughly the stated fraction of all scored domains, disagreements aside', () => {
    // 10,000 domains at 1% is ~100 records. The bound is deliberately loose: the draw is
    // Math.random inside the shipping path, and a test that pins the count exactly would
    // be testing a coin rather than the wiring.
    const domains = sweepDomains(10_000);
    const result = shadowScoreWatchdogDomains(domains, () => 'allow', LEARNED_SHADOW_SAMPLE_RATE);

    expect(result).not.toBeNull();
    expect(result!.evaluated).toBe(domains.length);

    const samples = readLog().filter((record) => record.sample === true);
    expect(samples.length).toBeGreaterThan(30);
    expect(samples.length).toBeLessThan(400);
  });

  it('samples independently of disagreement, so ordinary traffic is represented', () => {
    // The whole point of the slice: most of it is *not* a disagreement. A sweep where the
    // model and production agree almost everywhere still has to produce sample records for
    // the domains where they did agree, because that population is exactly what a
    // disagreement-only log can never show and the one PSI needs.
    //
    // Sampling is independent of the disagreement check, so a sampled disagreement is
    // written twice (once per kind) and the slice is not a subset of anything. What has to
    // hold is that the slice carries the *population's* mix, agreement records included.
    const domains = sweepDomains(4000);
    shadowScoreWatchdogDomains(domains, () => 'allow', LEARNED_SHADOW_SAMPLE_RATE);

    const records = readLog();
    const samples = records.filter((record) => record.sample === true);
    const disagreementsSeen = new Set(
      records.filter((record) => isPerDomain(record) && record.sample !== true).map((r) => r.domain),
    );

    expect(samples.length).toBeGreaterThan(0);
    // Both kinds are present, and agreement-only records are a real share of the slice.
    // That is the anti-bias check: sampling that were secretly gated on disagreement — the
    // failure this whole slice exists to prevent — would put agreement-only records at
    // exactly zero however healthy the sample count looked.
    const agreed = samples.filter((s) => !disagreementsSeen.has(s.domain));
    expect(agreed.length).toBeGreaterThan(0);
    expect(agreed.length / samples.length).toBeGreaterThan(0.25);
    // The population is ~62% agreement, so a slice drawn from it rather than from the
    // disagreements should land near that, and certainly not near zero.
    expect(agreed.length / samples.length).toBeLessThan(0.95);
  });

  it('writes nothing extra for a sweep run at rate 0, which is why the default was removed', () => {
    const domains = sweepDomains(2000);
    shadowScoreWatchdogDomains(domains, () => 'allow', 0);
    expect(readLog().filter((record) => record.sample === true)).toHaveLength(0);
  });
});

describe('the per-sweep summary, without which the gate reads zero forever', () => {
  // `shadow.py`'s `coverage()` derives `scored_domains` from `summary` records and from
  // nothing else, so a sweep that scored 30,000 domains and agreed with production about
  // all of them left no trace: `gate.py`'s shadow_scored reported `0 domains scored (min
  // 1000)` after any amount of running. The record kind was documented in shadow.py and
  // written by synth_shadow.py; only the shipping app omitted it.
  it('writes exactly one per sweep, carrying the counters the sweep really produced', () => {
    const domains = sweepDomains(1500);
    const result = shadowScoreWatchdogDomains(domains, () => 'allow', LEARNED_SHADOW_SAMPLE_RATE);
    expect(result).not.toBeNull();

    const summaries = readLog().filter((r) => r.type === 'summary');
    expect(summaries).toHaveLength(1);
    // The numbers are the returned ones, not a re-count and not a constant: a summary
    // that disagreed with its own sweep would be worse than a missing one.
    expect(summaries[0].evaluated).toBe(result!.evaluated);
    expect(summaries[0].evaluated).toBe(domains.length);
    expect(summaries[0].disagreements).toBe(result!.disagreements);
    expect(typeof summaries[0].at).toBe('string');
  });

  it('names the weights that scored the sweep, or admits there is no manifest', () => {
    // The shipped weights predate the promotion manifest, so the honest value is null.
    // A summary that claimed a version nothing could verify would let a gate report
    // present unversioned evidence as though it identified a model.
    const result = shadowScoreWatchdogDomains(sweepDomains(200), () => 'allow', 0);
    const [summary] = readLog().filter((r) => r.type === 'summary');
    expect(summary).toBeDefined();
    expect(summary.modelVersion).toBeNull();
    expect(result!.modelVersion).toBeNull();
  });

  it('carries no hostname at all, which is what makes it safe to write unconditionally', () => {
    // The other two kinds are disclosures; this one is arithmetic. Nothing here should
    // ever be able to say what you visited.
    shadowScoreWatchdogDomains(sweepDomains(300), () => 'allow', 0);
    const [summary] = readLog().filter((r) => r.type === 'summary');
    expect(Object.keys(summary).sort()).toEqual(
      ['at', 'disagreements', 'evaluated', 'modelVersion', 'type'].sort(),
    );
    for (const key of ['domain', 'learnedScore', 'learnedDecision', 'referenceDecision']) {
      expect(summary).not.toHaveProperty(key);
    }
  });

  it('writes none for a sweep that scored nothing, because running is not coverage', () => {
    // A watchdog tick with no domains to look at produces an empty summary. Writing it
    // would count a day of shadow in `coverage()`'s `days` field — a day on which the
    // model saw nothing, presented as a day it was tested.
    const result = shadowScoreWatchdogDomains([], () => 'allow', LEARNED_SHADOW_SAMPLE_RATE);
    expect(result).not.toBeNull();
    expect(result!.evaluated).toBe(0);
    expect(readLog().filter((r) => r.type === 'summary')).toHaveLength(0);
  });

  it('accumulates one summary per sweep rather than rewriting the last', () => {
    // Append-only is the log's contract: the JSONL is read by three Python scripts that
    // would all have to seek backwards if the newest count replaced the old one.
    shadowScoreWatchdogDomains(sweepDomains(120), () => 'allow', 0);
    shadowScoreWatchdogDomains(sweepDomains(120), () => 'allow', 0);
    shadowScoreWatchdogDomains(sweepDomains(120), () => 'allow', 0);
    expect(readLog().filter((r) => r.type === 'summary')).toHaveLength(3);
  });
});

describe('what a sampled record is allowed to contain', () => {
  // The privacy claim in docs/learned-shadow-privacy.md is a list of fields. A list of
  // fields is only documentation until something holds it to exactly that list, so this
  // is the test that keeps the document from drifting away from the log format.
  const DOCUMENTED_FIELDS = new Set([
    'domain',
    'learnedScore',
    'learnedDecision',
    'referenceDecision',
    'allowlisted',
    'at',
    'sample',
  ]);

  it('holds the documented fields and nothing else', () => {
    shadowScoreWatchdogDomains(sweepDomains(200), () => 'allow', 1);
    const samples = readLog().filter((record) => record.sample === true);
    expect(samples.length).toBeGreaterThan(0);

    for (const sample of samples) {
      for (const key of Object.keys(sample)) {
        expect(DOCUMENTED_FIELDS.has(key)).toBe(true);
      }
      expect(Object.keys(sample).sort()).toEqual([...DOCUMENTED_FIELDS].sort());
    }
  });

  it('never carries a URL, a path or a client', () => {
    // The DNS log the sweep reads has a path and a client per query; the sample keeps the
    // host and drops the rest. This is the assertion that would fail first if anyone
    // widened the record for debugging convenience.
    shadowScoreWatchdogDomains(sweepDomains(200), () => 'allow', 1);
    for (const sample of readLog().filter((r) => r.sample === true)) {
      expect(String(sample.domain)).not.toContain('/');
      expect(String(sample.domain)).not.toContain('?');
      for (const forbidden of ['url', 'path', 'client', 'query', 'qtype', 'ip', 'addresses']) {
        expect(sample).not.toHaveProperty(forbidden);
      }
    }
  });

  it('records the domain as a host, never as a full DNS name', () => {
    shadowScoreWatchdogDomains(['plain.example.com'], () => 'allow', 1);
    const [sample] = readLog().filter((record) => record.sample === true);
    expect(sample.domain).toBe('plain.example.com');
  });
});

describe('the shadow log is where the privacy document says it is', () => {
  it('writes inside userData, not next to the app', () => {
    shadowScoreWatchdogDomains(sweepDomains(10), () => 'allow', 1);
    expect(existsSync(join(userData, 'learned-shadow.jsonl'))).toBe(true);
  });

  it('returns null and writes nothing when the model is unavailable', async () => {
    // A missing or unresolvable weights file is the fail-soft path: the watchdog must not
    // break, and an unavailable model is not a reason to log anything at all — the sample
    // slice holds model scores, so with no model there is nothing honest to write.
    //
    // The classifier is memoised at module scope, so this needs a fresh module registry
    // rather than a flipped flag.
    appPath = join(userData, 'not-an-app');
    await jest.isolateModulesAsync(async () => {
      const isolated = await import('../learnedShadow');
      expect(isolated.getLearnedClassifier()).toBeNull();
      expect(isolated.shadowScoreWatchdogDomains(['a.example.com'], () => 'allow', 1)).toBeNull();
    });
    expect(readLog()).toHaveLength(0);
  });
});
