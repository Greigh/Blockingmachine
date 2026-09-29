/**
 * GBDT forward pass for bm-gbdt/1 weights.
 *
 * Tree JSON shape (from export.py):
 *   { split_feature, threshold, default_left, left, right } — internal node,
 *     go left when vector[split_feature] <= threshold (LightGBM '<=')
 *   { leaf_value }                             — leaf
 * A NaN feature value (missing behavioral observation, feature v2+)
 * follows LightGBM's missing direction: default_left. v1 trees predate
 * the field and never see NaN; the fallback (right) is unreachable there
 * but preserves the old behavior exactly.
 * Score = sigmoid(sum of leaf values), matching LightGBM's binary
 * objective. No dependencies; safe to run in any JS runtime.
 */

export interface GbdtNode {
  leaf_value?: number;
  split_feature?: number;
  threshold?: number;
  /** Where NaN (missing) values go. Undefined = right (v1 artifacts). */
  default_left?: boolean;
  left?: GbdtNode;
  right?: GbdtNode;
}

export interface GbdtModelFile {
  format: 'bm-gbdt/1';
  feature_version: number;
  feature_names: string[];
  trees: GbdtNode[];
  thresholds: { block: number; review: number };
}

/** Evaluate the tree ensemble on one feature vector. Returns P(tracker). */
export function evaluateGbdt(trees: GbdtNode[], vector: readonly number[]): number {
  let total = 0;
  for (const tree of trees) {
    let node: GbdtNode | undefined = tree;
    while (node !== undefined && node.leaf_value === undefined) {
      const f: number | undefined = node.split_feature;
      const t: number | undefined = node.threshold;
      if (f === undefined || t === undefined || node.left === undefined || node.right === undefined) {
        throw new Error('learned GBDT: malformed tree node');
      }
      const x: number = vector[f];
      node = Number.isNaN(x) ? (node.default_left === true ? node.left : node.right)
        : x <= t ? node.left
        : node.right;
    }
    if (node === undefined || node.leaf_value === undefined) {
      throw new Error('learned GBDT: tree terminated without a leaf');
    }
    total += node.leaf_value;
  }
  return 1 / (1 + Math.exp(-total));
}
