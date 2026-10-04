/**
 * The post-dedup generation pass off the main thread.
 *
 * After deduplication the pipeline used to run three `generateFilterList`
 * passes, both rule segregations, the host-candidate extraction and the hot-set
 * derivation as synchronous work on the event loop — measured at ~2.8s of
 * blocked time on the real ~360k-rule list, which is the "compile spins at 90%"
 * report this file exists to fix. `index.ts` spawns this as a `worker_threads`
 * worker bundled to `.webpack/main/outputWorker.cjs`; nothing in it may touch
 * `require('electron')`.
 *
 * The input is the deduplicated rules' raw lines joined with '\n' (~13MB,
 * ~20ms to build on the main thread) — the rule objects themselves would be a
 * ~160MB structured clone (~450ms on the sending thread), so the worker
 * re-parses instead. `parseFilterList` over the same raws is byte-identical on
 * every shipped format — verified against the real 361k-rule list — and the
 * ~440ms it costs runs here, not on the loop the user is watching.
 */

import { parentPort, workerData } from 'node:worker_threads';
import {
  parseFilterList,
  generateFilterList,
  filterDNSRules,
  filterBrowserRules,
  extractHostFromRule,
  selectHotList,
  formatHotList,
} from '@blockingmachine/core';
import type { FilterFormat, FilterListMetadata } from '@blockingmachine/core';

interface OutputWorkerInput {
  ruleLines: string;
  format: FilterFormat;
  additionalFormats: FilterFormat[];
  metadata: FilterListMetadata;
  hotlist: {
    hits: Array<{ rule: string; count: number }>;
    exceptions: string[];
    source: string;
    measuredOn: string;
  } | null;
}

interface OutputWorkerResult {
  generatedList: string;
  additionalContents: Array<{ format: string; content: string }>;
  dnsContent: string;
  browserContent: string;
  dnsCount: number;
  browserCount: number;
  candidates: string[];
  hotlistContent: string | null;
}

const input = workerData as OutputWorkerInput;
const post = (stage: string) => parentPort?.postMessage({ type: 'progress', stage });

post('Re-parsing compiled rules');
const rules = parseFilterList(input.ruleLines, 'compiled');

post(`Generating ${input.format} filter list`);
const generatedList = generateFilterList(rules, input.metadata, input.format);

const additionalContents: Array<{ format: string; content: string }> = [];
for (const addFormat of input.additionalFormats) {
  post(`Generating ${addFormat} export`);
  additionalContents.push({
    format: addFormat,
    content: generateFilterList(rules, input.metadata, addFormat),
  });
}

post('Generating DNS endpoint list');
const dnsRules = filterDNSRules(rules);
const dnsContent = generateFilterList(
  dnsRules,
  {
    ...input.metadata,
    stats: {
      ...input.metadata.stats,
      totalRules: dnsRules.length,
      uniqueRules: dnsRules.length,
    },
  },
  'adguard',
);

post('Generating browser endpoint list');
const browserRules = filterBrowserRules(rules);
const browserContent = generateFilterList(
  browserRules,
  {
    ...input.metadata,
    stats: {
      ...input.metadata.stats,
      totalRules: browserRules.length,
      uniqueRules: browserRules.length,
    },
  },
  'adguard',
);

// The classify pass's input comes from the same deduplicated list — extracting
// here keeps another ~360k-iteration loop off the main thread, and a Set keeps
// the semantics the inline extraction had (first-seen order, hosts deduped).
post('Extracting host candidates');
const candidateSet = new Set<string>();
for (const rule of rules) {
  const host = extractHostFromRule(rule.raw);
  if (host) candidateSet.add(host);
}

let hotlistContent: string | null = null;
if (input.hotlist && input.hotlist.hits.length > 0) {
  post('Deriving the measured hot set');
  hotlistContent = formatHotList(
    selectHotList({
      lines: browserRules.map((rule) => rule.raw),
      hits: input.hotlist.hits,
      exceptions: input.hotlist.exceptions,
    }),
    { source: input.hotlist.source, measuredOn: input.hotlist.measuredOn },
  );
}

parentPort?.postMessage({
  type: 'result',
  generatedList,
  additionalContents,
  dnsContent,
  browserContent,
  dnsCount: dnsRules.length,
  browserCount: browserRules.length,
  candidates: [...candidateSet],
  hotlistContent,
} satisfies { type: 'result' } & OutputWorkerResult);

export type { OutputWorkerInput, OutputWorkerResult };
