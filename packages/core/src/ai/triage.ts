/**
 * Triage cascade: screen everything locally, escalate only what is genuinely undecided.
 *
 * Every mainstream blocker chooses an inference backend *exclusively* — you either run
 * the local classifier on everything, or you send everything to a model. That fork is
 * the reason AdGuard's LLM research stalled on cost: *"a webpage has thousands of
 * elements, and analyzing all of them would be slow and expensive"*, so their model is
 * only ever pointed at elements a filter list already flagged.
 *
 * The cascade removes the fork. The embedded classifier costs ~0.05ms and no network,
 * so it can look at every element and every host; its verdict is then *kept* for the
 * cases it can defend and *escalated* only where it cannot. The LLM stops being the
 * classifier and becomes the tiebreaker.
 *
 * Everything in this module is pure: no clock, no network, no iteration-order
 * dependence. That is deliberate — the escalation rate is the number the whole
 * architecture is judged on, so it has to be reproducible in a test.
 *
 * @beta
 */

import type {
  AiVerdict,
  CorroborationTier,
  MiniAiFeatureContribution,
  RiskLevel,
  ThreatCategory,
} from './types.js';

/**
 * The subset of a classifier prediction the triage engine needs.
 *
 * Structurally compatible with `MiniAiPrediction` and `ElementPrediction`, so callers
 * pass their real prediction object rather than converting it.
 * @beta
 */
export interface TriageCandidate {
  /** Stable identifier used in plans and reports — usually the hostname or element label. */
  id: string;
  verdict: AiVerdict;
  /** 0-100, matching `MiniAiPrediction.confidence`. */
  confidence: number;
  riskLevel: RiskLevel;
  /** Softmax distribution when available; the top-2 margin is the strongest ambiguity signal. */
  classProbabilities?: Partial<Record<ThreatCategory, number>>;
  /**
   * `'corroborated' | 'single-signal' | 'lexical-only'` for hostnames. The element
   * engine spells its weakest tier `'model-only'`, which callers map to `lexical-only`
   * before handing the prediction over.
   */
  corroboration?: CorroborationTier;
  /**
   * Evidence families from either engine. Typed loosely because the hostname and
   * element engines have disjoint vocabularies; see `HIGH_PRECISION_FAMILIES`.
   */
  evidenceFamilies?: readonly string[];
  topContributions?: MiniAiFeatureContribution[];
}

/**
 * Evidence families that are *knowledge* rather than *shape*: a match is itself
 * meaningful, because the family is a name-based lookup rather than a statistical
 * measurement of one hostname's letters. Their presence makes a non-clean verdict
 * decisive, so the escalation budget is never spent re-litigating them.
 * @beta
 */
export const HIGH_PRECISION_FAMILIES: readonly string[] = [
  // Hostname engine (`EvidenceFamily`): curated lookups and name analysis.
  'known-network',
  'cname-uncloak',
  'brand-impersonation',
  // Element engine (`ElementEvidenceFamily`): mirrors its `DEFINITIVE_FAMILIES` set —
  // the families that actually *name* a class rather than describing how it is drawn.
  'user-choice',
  'ad-marker',
  'ad-attribute',
  'ad-network',
  'ad-ancestor',
  'measurement',
  'anti-adblock',
  'social-embed',
  'pixel-shape',
];

/** Why a candidate was escalated, or why it was not. Suitable for logs and the UI. */
export type TriageReasonCode =
  | 'near-tie'
  | 'self-doubt'
  | 'unsupported'
  | 'conflicting-evidence'
  | 'no-evidence'
  | 'decision-boundary'
  | 'decisive-evidence'
  /** Name-based evidence and a clean verdict disagree — a conflict, not an uncertainty. */
  | 'contradiction'
  /** A clean verdict reached without conviction — a hedge, not a finding. */
  | 'tentative'
  /** A clean verdict resolved locally without spending budget. */
  | 'kept-clean';

/** Which ambiguity signals fired for one candidate. */
export interface TriageSignals {
  /** The top two class probabilities are close: the model is splitting its vote. */
  nearTie: boolean;
  /** The verdict is the model's own uncertainty bucket. */
  selfDoubt: boolean;
  /** The model's probability is the only support — no independent evidence family. */
  unsupported: boolean;
  /** Feature contributions push toward threat and clean with comparable force. */
  conflicting: boolean;
  /** A non-clean verdict resting on no evidence family at all. */
  noEvidence: boolean;
  /** Confidence sits inside the band that separates block from allow. */
  boundary: boolean;
  /**
   * A *clean* verdict the classifier reached without conviction.
   *
   * Clean traffic the model actually recognises lands at 99% — it is by far the
   * classifier's most confident output. A clean verdict well below that is the model
   * hedging, and hedging on clean is the one case a filter list can never revisit: an
   * ordinary-looking hostname it does not recognise.
   */
  tentative: boolean;
  /** Name-based knowledge is present, so the verdict does not need a second opinion. */
  highPrecision: boolean;
}

export interface AmbiguityAssessment {
  id: string;
  /** 0 (decided) to 1 (coin flip). */
  ambiguity: number;
  signals: TriageSignals;
  reasons: TriageReasonCode[];
  /** One line per firing signal, written for a user reading a scan result. */
  explanations: string[];
  /**
   * Whether spending a second opinion here is worthwhile. Already accounts for
   * decisive evidence and for the configured clean-traffic policy.
   */
  ambiguous: boolean;
}

export type TriageAction = 'resolve-locally' | 'escalate' | 'deferred';

export interface TriageItem extends AmbiguityAssessment {
  action: TriageAction;
  local: TriageCandidate;
}

export interface TriageStats {
  screened: number;
  escalated: number;
  deferred: number;
  resolvedLocally: number;
  /** Escalated / screened, 0-1. The headline number for the architecture. */
  escalationRate: number;
  /**
   * LLM calls the exclusive-fork design would have made on the same input — one per
   * candidate. Recorded so the saving is a measurement, not a claim.
   */
  forkLlmCalls: number;
  llmCallsSaved: number;
  budget: number;
  budgetRemaining: number;
  signalCounts: Record<TriageReasonCode, number>;
}

export interface TriagePlan {
  items: TriageItem[];
  /** Ranked, budget-capped: send these to the model, in this order. */
  escalate: TriageItem[];
  resolvedLocally: TriageItem[];
  /**
   * Ambiguous but over budget. The local verdict still stands — a cascade must never
   * leave a candidate undecided — so these are recorded rather than dropped.
   */
  deferred: TriageItem[];
  stats: TriageStats;
}

export interface TriageOptions {
  /** Escalations allowed for this call. */
  maxEscalations?: number;
  /** Escalations already spent this session, so callers can enforce a session budget. */
  spentEscalations?: number;
  /** Ambiguity below this is always resolved locally. */
  minAmbiguity?: number;
  /**
   * Whether an uncertain *clean* verdict may be escalated.
   *
   * Off by default: clean is the classifier's highest-precision output, and re-checking
   * confident clean traffic is the wrong default trade. Turn it on for discovery runs
   * where the goal is finding what the lists miss.
   */
  escalateClean?: boolean;
  /** Softmax top-2 margin below which the model counts as undecided. */
  nearTieMargin?: number;
  /** Width of the confidence band around `blockBoundary` that counts as undecided. */
  boundaryWindow?: number;
  /** Confidence above which a verdict counts as a block decision for boundary purposes. */
  blockBoundary?: number;
  /**
   * Clean verdicts below this confidence count as tentative. Defaults to 95 because
   * clean verdicts on recognised traffic cluster at 99%.
   */
  cleanConfidenceFloor?: number;
}

export const DEFAULT_TRIAGE_OPTIONS: Required<TriageOptions> = {
  maxEscalations: 25,
  spentEscalations: 0,
  minAmbiguity: 0.5,
  escalateClean: false,
  nearTieMargin: 0.15,
  boundaryWindow: 12,
  blockBoundary: 65,
  cleanConfidenceFloor: 95,
};

/**
 * Merges caller options over the defaults, ignoring absent *and* explicitly-undefined
 * keys. A plain spread would let a caller passing `{ minAmbiguity: undefined }` — the
 * natural result of forwarding an optional config field — erase the default and make
 * every comparison against `undefined` silently fail.
 */
function normalizeTriageOptions(
  options: TriageOptions | undefined,
): Required<TriageOptions> {
  const source = options && typeof options === 'object' ? options : {};
  const num = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return {
    maxEscalations: num(source.maxEscalations, DEFAULT_TRIAGE_OPTIONS.maxEscalations),
    spentEscalations: num(source.spentEscalations, DEFAULT_TRIAGE_OPTIONS.spentEscalations),
    minAmbiguity: num(source.minAmbiguity, DEFAULT_TRIAGE_OPTIONS.minAmbiguity),
    escalateClean:
      typeof source.escalateClean === 'boolean'
        ? source.escalateClean
        : DEFAULT_TRIAGE_OPTIONS.escalateClean,
    nearTieMargin: num(source.nearTieMargin, DEFAULT_TRIAGE_OPTIONS.nearTieMargin),
    boundaryWindow: num(source.boundaryWindow, DEFAULT_TRIAGE_OPTIONS.boundaryWindow),
    blockBoundary: num(source.blockBoundary, DEFAULT_TRIAGE_OPTIONS.blockBoundary),
    cleanConfidenceFloor: num(
      source.cleanConfidenceFloor,
      DEFAULT_TRIAGE_OPTIONS.cleanConfidenceFloor,
    ),
  };
}

/**
 * Signal weights. They sum above 1 and the score is clamped, so two strong signals are
 * already enough to escalate — a candidate has to look *badly* undecided, not merely
 * unusual, to justify a network round trip.
 */
const SIGNAL_WEIGHTS: Record<
  keyof Omit<TriageSignals, 'highPrecision'>,
  number
> = {
  nearTie: 0.34,
  tentative: 0.30,
  selfDoubt: 0.22,
  unsupported: 0.18,
  boundary: 0.16,
  conflicting: 0.14,
  noEvidence: 0.12,
};

const REASON_CODES: readonly TriageReasonCode[] = [
  'near-tie',
  'self-doubt',
  'unsupported',
  'conflicting-evidence',
  'no-evidence',
  'decision-boundary',
  'decisive-evidence',
  'contradiction',
  'tentative',
  'kept-clean',
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function isNonCleanVerdict(verdict: AiVerdict | string): boolean {
  return typeof verdict === 'string' && verdict !== 'clean';
}

/** Severity ordering used only as a tiebreak between equally ambiguous candidates. */
const RISK_SEVERITY: Record<string, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * The two highest finite class probabilities, or null when the distribution is too
 * sparse to judge. Post-`Clean` renormalisation can leave the map incomplete, so this
 * never assumes all six categories are present.
 */
function topTwoProbabilities(
  probabilities: TriageCandidate['classProbabilities'],
): [number, number] | null {
  if (!probabilities || typeof probabilities !== 'object') return null;
  const values: number[] = [];
  for (const raw of Object.values(probabilities)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) values.push(raw);
  }
  if (values.length < 2) return null;
  values.sort((a, b) => b - a);
  return [values[0], values[1]];
}

/**
 * Whether feature contributions argue for a block and for a pass with comparable
 * force — the signature of a candidate whose fate was decided by arithmetic noise.
 */
function hasConflictingContributions(
  contributions: MiniAiFeatureContribution[] | undefined,
): boolean {
  if (!Array.isArray(contributions) || contributions.length === 0) return false;
  let threat = 0;
  let clean = 0;
  for (const item of contributions) {
    if (!item || typeof item !== 'object') continue;
    const magnitude = Math.abs(typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : 0)
      * (typeof item.weight === 'number' && Number.isFinite(item.weight) ? Math.abs(item.weight) : 0);
    if (item.impact === 'threat') threat += magnitude;
    else if (item.impact === 'clean') clean += magnitude;
  }
  if (threat <= 0 || clean <= 0) return false;
  const stronger = Math.max(threat, clean);
  const weaker = Math.min(threat, clean);
  return stronger > 0 && weaker / stronger > 0.5;
}

function hasHighPrecisionEvidence(candidate: TriageCandidate): boolean {
  const families = candidate.evidenceFamilies;
  if (!Array.isArray(families)) return false;
  return families.some(
    (family) => typeof family === 'string' && HIGH_PRECISION_FAMILIES.includes(family),
  );
}

/**
 * Scores how undecided a local verdict is, and explains why.
 *
 * High ambiguity means "the model cannot defend this", not "this is dangerous". A
 * confidently-malicious host is trivially decidable and must not consume budget, while
 * a 45/40 split between Clean and Advertising is exactly where a second opinion is
 * worth a network round trip.
 * @beta
 */
export function assessAmbiguity(
  candidate: TriageCandidate,
  options: TriageOptions = {},
): AmbiguityAssessment {
  const opts = normalizeTriageOptions(options);
  const id = typeof candidate?.id === 'string' ? candidate.id : '';
  const confidence = normalizeConfidence(candidate?.confidence);
  const verdict = candidate?.verdict;
  const families = Array.isArray(candidate?.evidenceFamilies) ? candidate.evidenceFamilies : [];
  const highPrecision = hasHighPrecisionEvidence(candidate);
  const nonClean = isNonCleanVerdict(verdict);

  const pair = topTwoProbabilities(candidate?.classProbabilities);
  const margin = pair ? pair[0] - pair[1] : null;

  const signals: TriageSignals = {
    nearTie: margin !== null && margin < opts.nearTieMargin,
    selfDoubt: verdict === 'suspicious',
    unsupported: candidate?.corroboration === 'lexical-only',
    conflicting: hasConflictingContributions(candidate?.topContributions),
    noEvidence: nonClean && families.length === 0,
    boundary: Math.abs(confidence - opts.blockBoundary) <= opts.boundaryWindow,
    // Requires an explicit clean verdict: a malformed candidate (no verdict, no
    // confidence) must not read as a tentative clean and consume budget.
    tentative: verdict === 'clean' && confidence < opts.cleanConfidenceFloor,
    highPrecision,
  };

  let ambiguity = 0;
  for (const [signal, weight] of Object.entries(SIGNAL_WEIGHTS) as Array<
    [keyof Omit<TriageSignals, 'highPrecision'>, number]
  >) {
    if (signals[signal]) ambiguity += weight;
  }
  ambiguity = clamp01(ambiguity);

  const explanations: string[] = [];
  const reasons: TriageReasonCode[] = [];

  if (signals.nearTie && margin !== null) {
    reasons.push('near-tie');
    explanations.push(
      `Top two classes are within ${(margin * 100).toFixed(1)} points — the model is splitting its vote`,
    );
  }
  if (signals.selfDoubt) {
    reasons.push('self-doubt');
    explanations.push('Verdict is the classifier\'s own uncertain bucket ("suspicious")');
  }
  if (signals.unsupported) {
    reasons.push('unsupported');
    explanations.push('The model\'s probability is the only support — no independent evidence family');
  }
  if (signals.conflicting) {
    reasons.push('conflicting-evidence');
    explanations.push('Feature contributions argue for a block and a pass with comparable force');
  }
  if (signals.noEvidence) {
    reasons.push('no-evidence');
    explanations.push('Non-clean verdict resting on no evidence family at all');
  }
  if (signals.boundary) {
    reasons.push('decision-boundary');
    explanations.push(
      `Confidence ${confidence.toFixed(0)} sits inside the ${opts.blockBoundary} ± ${opts.boundaryWindow} band that separates block from allow`,
    );
  }
  if (signals.tentative) {
    reasons.push('tentative');
    explanations.push(
      `Clean verdict at only ${confidence.toFixed(0)}% — recognised clean traffic reports ~99%, so this is a hedge rather than a finding`,
    );
  }

  // Decisive: name-based knowledge outranks a lexical coin flip, so a non-clean verdict
  // carrying it never spends budget. A high-precision family on a *clean* verdict is a
  // genuine contradiction, so it is left eligible to escalate.
  const decisive = highPrecision && nonClean && !signals.conflicting;
  if (decisive) {
    reasons.push('decisive-evidence');
    explanations.push('Backed by name-based evidence, which outranks a statistical ambiguity');
    ambiguity = 0;
  }

  let ambiguous = !decisive && ambiguity >= opts.minAmbiguity;

  // Clean-traffic policy. Clean is the classifier's highest-precision output, so
  // re-checking it is opt-in — with one exception that is a conflict rather than an
  // uncertainty: name-based evidence says threat while the verdict says clean, which is
  // exactly the missed-block case a filter-list product cannot see at all.
  if (!nonClean) {
    if (signals.highPrecision) {
      ambiguous = !decisive && !signals.conflicting;
      reasons.push('contradiction');
      explanations.push(
        'Name-based evidence indicates a threat but the verdict is clean — escalated even though clean-traffic escalation is off',
      );
    } else if (!opts.escalateClean) {
      ambiguous = false;
      reasons.push('kept-clean');
      explanations.push('Clean verdict kept locally; escalateClean is off');
    } else {
      // Discovery mode accepts a lower bar than the summed score, because clean verdicts
      // rarely trip the self-doubt and unsupported signals that raise it.
      ambiguous =
        !decisive &&
        (signals.tentative ||
          signals.nearTie ||
          signals.boundary ||
          signals.unsupported ||
          signals.conflicting);
    }
  }

  return { id, ambiguity, signals, reasons, explanations, ambiguous };
}

/**
 * Plans a budgeted cascade over a batch of local verdicts.
 *
 * Escalation order is ambiguity first, then risk severity, then input order. Ambiguity
 * leads because that is what the LLM is uniquely good at; the severity tiebreak exists
 * only so that when two candidates are equally undecided the higher-stakes one is
 * resolved before the budget runs out.
 *
 * Nothing is ever dropped. A candidate that is ambiguous but over budget becomes
 * `deferred` and keeps its local verdict.
 * @beta
 */
export function planTriage(
  candidates: TriageCandidate[],
  options: TriageOptions = {},
): TriagePlan {
  const opts = normalizeTriageOptions(options);
  const list = Array.isArray(candidates) ? candidates.slice() : [];

  const assessed = list.map((candidate, index) => ({
    index,
    assessment: assessAmbiguity(candidate, opts),
    candidate,
  }));

  const budget = Math.max(
    0,
    Math.floor(opts.maxEscalations) - Math.max(0, Math.floor(opts.spentEscalations)),
  );

  const rankable = assessed
    .filter((entry) => entry.assessment.ambiguous)
    .sort((a, b) => {
      if (b.assessment.ambiguity !== a.assessment.ambiguity) {
        return b.assessment.ambiguity - a.assessment.ambiguity;
      }
      const riskDelta =
        (RISK_SEVERITY[b.candidate?.riskLevel ?? 'none'] ?? 0) -
        (RISK_SEVERITY[a.candidate?.riskLevel ?? 'none'] ?? 0);
      if (riskDelta !== 0) return riskDelta;
      // Total tiebreak, so the budget cannot depend on the order candidates arrived in
      // (Set iteration order over a query log is arbitrary, not meaningful).
      const idA = a.assessment.id;
      const idB = b.assessment.id;
      if (idA !== idB) return idA < idB ? -1 : 1;
      return a.index - b.index;
    });

  // Budget is marked by position, not by id: duplicate ids would otherwise both match a
  // Set lookup and push the plan over its own cap.
  const escalateIndexes = new Set(rankable.slice(0, budget).map((entry) => entry.index));

  const items: TriageItem[] = assessed.map((entry) => {
    let action: TriageAction;
    if (!entry.assessment.ambiguous) action = 'resolve-locally';
    else if (escalateIndexes.has(entry.index)) action = 'escalate';
    else action = 'deferred';
    return { ...entry.assessment, action, local: entry.candidate };
  });

  const escalate = items.filter((item) => item.action === 'escalate');
  const resolvedLocally = items.filter((item) => item.action === 'resolve-locally');
  const deferred = items.filter((item) => item.action === 'deferred');

  const signalCounts = Object.fromEntries(
    REASON_CODES.map((code) => [code, 0]),
  ) as Record<TriageReasonCode, number>;
  for (const item of items) {
    for (const reason of item.reasons) {
      if (reason in signalCounts) signalCounts[reason] += 1;
    }
  }

  const stats: TriageStats = {
    screened: items.length,
    escalated: escalate.length,
    deferred: deferred.length,
    resolvedLocally: resolvedLocally.length,
    escalationRate: items.length === 0 ? 0 : escalate.length / items.length,
    forkLlmCalls: items.length,
    llmCallsSaved: Math.max(0, items.length - escalate.length),
    budget,
    budgetRemaining: Math.max(0, budget - escalate.length),
    signalCounts,
  };

  return { items, escalate, resolvedLocally, deferred, stats };
}

/** A model verdict, in the shape the existing providers already return. */
export interface EscalationVerdict {
  verdict: AiVerdict;
  confidence: number;
  category?: ThreatCategory;
  riskLevel?: RiskLevel;
  reasons?: string[];
  model?: string;
}

/** Where a final verdict in a cascade actually came from. */
export type TriageVerdictSource = 'local' | 'escalated' | 'contested';

export interface TriageVerdict {
  id: string;
  verdict: AiVerdict;
  category?: ThreatCategory;
  confidence: number;
  riskLevel: RiskLevel;
  source: TriageVerdictSource;
  /** The model agreed with the local verdict. */
  agreement: boolean;
  /** The model tried to clear a candidate the local evidence defends. */
  contradicted: boolean;
  /** The escalation was attempted and failed — the local verdict stands. */
  escalationFailed: boolean;
  model?: string;
  reasons: string[];
}

/**
 * Reconciles an escalated verdict with the local one.
 *
 * The contract exists to stop a tiebreaker from silently erasing hard evidence. An LLM
 * may raise severity on an undecided candidate — that is what it is for. It may not
 * clear one whose local verdict rests on name-based knowledge (`cname-uncloak`,
 * `brand-impersonation`, `known-network`), because those families are lookups rather
 * than statistics, and a model second-guessing a known tracker hostname is more likely
 * to be wrong than the lookup is. Those disagreements are recorded as `contested`
 * instead of being applied.
 *
 * Failure is not an error state: a null or malformed model verdict simply leaves the
 * local verdict in place, flagged, so a cascade degrades into the local classifier
 * rather than into a gap.
 * @beta
 */
export function mergeTriageVerdict(
  local: TriageCandidate,
  escalated: EscalationVerdict | null | undefined,
): TriageVerdict {
  const localVerdict = local?.verdict ?? 'clean';
  const localConfidence = normalizeConfidence(local?.confidence);
  const localRisk = local?.riskLevel ?? 'none';
  const id = typeof local?.id === 'string' ? local.id : '';

  if (!escalated || typeof escalated !== 'object' || typeof escalated.verdict !== 'string') {
    return {
      id,
      verdict: localVerdict,
      confidence: localConfidence,
      riskLevel: localRisk,
      source: 'local',
      agreement: false,
      contradicted: false,
      escalationFailed: true,
      reasons: ['Escalation unavailable — local verdict retained'],
    };
  }

  const modelVerdict = escalated.verdict;
  const modelConfidence = normalizeConfidence(escalated.confidence);
  const modelRisk = escalated.riskLevel ?? localRisk;
  const modelName = typeof escalated.model === 'string' ? escalated.model : undefined;
  const modelReasons = Array.isArray(escalated.reasons)
    ? escalated.reasons.filter((line) => typeof line === 'string')
    : [];

  const agreement = modelVerdict === localVerdict;
  const downgrade = isNonCleanVerdict(localVerdict) && !isNonCleanVerdict(modelVerdict);
  const defendedByKnowledge = hasHighPrecisionEvidence(local) || local?.corroboration === 'corroborated';

  if (agreement) {
    return {
      id,
      verdict: localVerdict,
      category: escalated.category,
      // Two independent methods agreeing is stronger evidence than either alone, so the
      // higher confidence is kept rather than averaged down.
      confidence: Math.max(localConfidence, modelConfidence),
      riskLevel: localRisk,
      source: 'escalated',
      agreement: true,
      contradicted: false,
      escalationFailed: false,
      model: modelName,
      reasons: ['Local screening and the model agreed', ...modelReasons],
    };
  }

  if (downgrade && defendedByKnowledge) {
    return {
      id,
      verdict: localVerdict,
      confidence: localConfidence,
      riskLevel: localRisk,
      source: 'contested',
      agreement: false,
      contradicted: true,
      escalationFailed: false,
      model: modelName,
      reasons: [
        'Model recommended clearing this target, but the local verdict rests on name-based evidence and was kept',
        ...modelReasons,
      ],
    };
  }

  return {
    id,
    verdict: modelVerdict,
    category: escalated.category,
    confidence: modelConfidence,
    riskLevel: downgrade ? 'none' : modelRisk,
    source: 'escalated',
    agreement: false,
    contradicted: false,
    escalationFailed: false,
    model: modelName,
    reasons:
      modelReasons.length > 0
        ? modelReasons
        : [`Model disagreed with the local screening (${localVerdict} → ${modelVerdict})`],
  };
}

/** Applies a batch of escalated verdicts, keyed by candidate id. */
export function mergeTriageVerdicts(
  items: TriageItem[],
  escalated: Map<string, EscalationVerdict | null | undefined> | Record<string, EscalationVerdict | null | undefined>,
): TriageVerdict[] {
  const lookup = (id: string): EscalationVerdict | null | undefined => {
    if (escalated instanceof Map) return escalated.get(id);
    if (escalated && typeof escalated === 'object') return escalated[id];
    return undefined;
  };
  const list = Array.isArray(items) ? items : [];
  return list.map((item) => mergeTriageVerdict(item.local, lookup(item.id)));
}

/**
 * One-line summary for logs and the UI, e.g.
 * `Screened 412 · escalated 18 (4.4%) · deferred 0 · 394 model calls avoided`.
 * @beta
 */
export function summarizeTriage(plan: TriagePlan): string {
  const stats = plan?.stats;
  if (!stats) return 'Screened 0';
  const rate = (stats.escalationRate * 100).toFixed(1);
  const parts = [
    `Screened ${stats.screened}`,
    `escalated ${stats.escalated} (${rate}%)`,
  ];
  if (stats.deferred > 0) parts.push(`deferred ${stats.deferred} (budget)`);
  parts.push(`${stats.llmCallsSaved} model calls avoided`);
  return parts.join(' · ');
}
