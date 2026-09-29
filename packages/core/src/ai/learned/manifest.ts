/**
 * Release-manifest verification (M5 promotion ceremony).
 *
 * `promote.py` writes manifest.json next to model.json pinning SHA-256
 * hashes of the exact bytes shipped. The app verifies the manifest
 * BEFORE parsing the weights: a hash mismatch means the weights were
 * tampered with or half-copied, and the loader fails closed — the
 * caller falls back to lists-only mode instead of serving suspect
 * weights. This is the enforcement side of "no silent auto-ship".
 */
export interface LearnedManifest {
  format: 'bm-manifest/1';
  version: number;
  /** SHA-256 hex of the model.json bytes, as shipped. */
  model_sha256: string;
  /** SHA-256 hex of the allowlist.json bytes, as shipped. */
  allowlist_sha256: string;
  feature_version: number;
  trained_at?: string;
  thresholds?: { block: number; review: number };
  gate_report_sha256?: string | null;
  promoted_at: string;
  note?: string;
}

import { sha256Hex } from './sha256.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse and structurally validate a manifest. Throws a descriptive error. */
export function parseLearnedManifest(json: unknown): LearnedManifest {
  if (!isRecord(json)) throw new Error('learned manifest: not a JSON object');
  if (json['format'] !== 'bm-manifest/1') {
    throw new Error(`learned manifest: unsupported format ${JSON.stringify(json['format'])}`);
  }
  for (const f of ['version', 'model_sha256', 'allowlist_sha256', 'feature_version', 'promoted_at']) {
    if (json[f] === undefined || json[f] === null) {
      throw new Error(`learned manifest: missing field ${f}`);
    }
  }
  if (typeof json['version'] !== 'number' || typeof json['model_sha256'] !== 'string') {
    throw new Error('learned manifest: malformed version/hash fields');
  }
  return json as unknown as LearnedManifest;
}

/**
 * Verify raw artifact bytes against a manifest. Returns the parsed
 * manifest on success; throws on any mismatch. Call this with the
 * exact file bytes BEFORE createLearnedClassifier.
 */
export function verifyLearnedManifest(
  modelText: string,
  allowlistText: string,
  manifestJson: unknown,
): LearnedManifest {
  const manifest = parseLearnedManifest(manifestJson);
  const modelHash = sha256Hex(modelText);
  if (modelHash !== manifest.model_sha256.toLowerCase()) {
    throw new Error(
      `learned manifest: model.json hash mismatch (expected ${manifest.model_sha256.slice(0, 12)}…, ` +
        `got ${modelHash.slice(0, 12)}…) — refusing to load`,
    );
  }
  const allowHash = sha256Hex(allowlistText);
  if (allowHash !== manifest.allowlist_sha256.toLowerCase()) {
    throw new Error(
      `learned manifest: allowlist.json hash mismatch — refusing to load`,
    );
  }
  return manifest;
}
