/**
 * User feedback labels — the bridge from in-app Confirm-Threat / Mark-Safe
 * actions to the training pipeline's `labels.db`.
 *
 * Every tune/reset action appends one JSONL record in the schema
 * `packages/ai-training/feedback.py` already ingests — `{domain, verdict,
 * reporter, at}` — plus provenance extras (`correctedVerdict`,
 * `correctedCategory`) the merge ignores. `feedback.py --feedback` applies
 * them as gold labels with its canary-quarantine and flip-agreement guards;
 * `verdict: "reset"` is a Forget-Learn tombstone that deletes the stored
 * feedback label.
 *
 * Guards: only `isPublicHostname` names are ever recorded (a `.local` label
 * would train LAN noise), the file is bounded (compaction keeps the newest
 * record per domain), and writes are validated the same way the merge will
 * read them so a corrupt line can't land half-formed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isPublicHostname } from '@blockingmachine/core';

export type UserLabelVerdict = 'threat' | 'safe' | 'reset';

/**
 * One record per line — `verdict`/`domain`/`reporter`/`at` is the
 * feedback.py contract; the `corrected*` fields are audit provenance.
 */
export interface UserLabelRecord {
  domain: string;
  /** threat = confirmed malicious, safe = false positive, reset = forget. */
  verdict: UserLabelVerdict;
  /** feedback.py's anti-poisoning groups by reporter; the app is single-user. */
  reporter: string;
  /** The classifier verdict/category the label corrected — provenance, not truth. */
  correctedVerdict?: string;
  correctedCategory?: string;
  at: string;
}

export const USER_LABEL_REPORTER = 'local-user';

/** Hard bound on the file. Compaction keeps the newest record per domain. */
const MAX_USER_LABEL_RECORDS = 10_000;

export function userLabelsFilePath(userDataDir: string): string {
  return path.join(userDataDir, 'user-labels.jsonl');
}

function normalizeLabelDomain(domain: string): string | null {
  const clean = domain.trim().toLowerCase().replace(/\.$/, '');
  return isPublicHostname(clean) ? clean : null;
}

function parseRecord(line: string): UserLabelRecord | null {
  try {
    const rec = JSON.parse(line) as UserLabelRecord;
    if (!rec || typeof rec.domain !== 'string') return null;
    if (!['threat', 'safe', 'reset'].includes(rec.verdict)) return null;
    if (typeof rec.reporter !== 'string' || !rec.reporter) return null;
    return rec;
  } catch {
    return null;
  }
}

export function readUserLabels(userDataDir: string): UserLabelRecord[] {
  const file = userLabelsFilePath(userDataDir);
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(parseRecord)
      .filter((r): r is UserLabelRecord => r !== null);
  } catch {
    return [];
  }
}

/** Latest record per domain — the merge-time view of the file. */
export function effectiveUserLabels(userDataDir: string): UserLabelRecord[] {
  const latest = new Map<string, UserLabelRecord>();
  for (const rec of readUserLabels(userDataDir)) {
    latest.set(rec.domain, rec);
  }
  return [...latest.values()];
}

/**
 * Append one record. Returns false for non-public names — a label on
 * `_airplay._tcp.local` would poison the corpus, so the caller can report
 * "not recorded" instead of silently training on LAN discovery noise.
 * Over the bound, the file is compacted latest-per-domain before appending.
 */
export function appendUserLabel(
  userDataDir: string,
  domain: string,
  verdict: UserLabelVerdict,
  corrected?: { verdict?: string; category?: string },
): boolean {
  const clean = normalizeLabelDomain(domain);
  if (!clean) return false;
  const file = userLabelsFilePath(userDataDir);
  const record: UserLabelRecord = {
    domain: clean,
    verdict,
    reporter: USER_LABEL_REPORTER,
    correctedVerdict: corrected?.verdict,
    correctedCategory: corrected?.category,
    at: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let prior = '';
    try {
      prior = fs.readFileSync(file, 'utf8');
    } catch { /* first write */ }
    const lines = prior.split('\n').filter(Boolean);
    if (lines.length >= MAX_USER_LABEL_RECORDS) {
      const latest = new Map<string, string>();
      for (const line of lines) {
        const rec = parseRecord(line);
        if (rec) latest.set(rec.domain, line);
      }
      prior = `${[...latest.values()].join('\n')}\n`;
    }
    fs.writeFileSync(file, prior + JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}
