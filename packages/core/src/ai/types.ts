/**
 * AI Radar [Beta] - Types & Domain Models
 * Hardened with runtime type guards, single-source-of-truth enumeration tuples,
 * immutable set indexing, safe normalization helpers, and default factory constructors.
 *
 * @packageDocumentation
 * @beta
 */

/**
 * High-level threat classification categories.
 * @beta
 */
export const THREAT_CATEGORIES = [
  'Advertising',
  'Telemetry/Analytics',
  'Consent/Annoyance',
  'CNAME Cloaking',
  'Malware/Phishing',
  'Clean',
  'Unknown',
] as const;
export type ThreatCategory = (typeof THREAT_CATEGORIES)[number];
export const THREAT_CATEGORY_SET: ReadonlySet<string> = new Set(
  THREAT_CATEGORIES,
);

/**
 * Assessed risk levels for domains and infrastructure.
 * @beta
 */
export const RISK_LEVELS = [
  'critical',
  'high',
  'medium',
  'low',
  'none',
] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const RISK_LEVEL_SET: ReadonlySet<string> = new Set(RISK_LEVELS);

/**
 * Actionable automated verdicts produced by the AI classifier and heuristic engines.
 * @beta
 */
export const AI_VERDICTS = [
  'ad_server',
  'tracker',
  'malicious',
  'annoyance',
  'clean',
  'suspicious',
] as const;
export type AiVerdict = (typeof AI_VERDICTS)[number];
export const AI_VERDICT_SET: ReadonlySet<string> = new Set(AI_VERDICTS);

/**
 * Underlying inference providers supported by the AI Detector service orchestrator.
 * @beta
 */
export const AI_PROVIDER_TYPES = [
  'mini-ai',
  'local-heuristics',
  'ollama',
  'gemini',
  'openai',
] as const;
export type AiProviderType = (typeof AI_PROVIDER_TYPES)[number];
export const AI_PROVIDER_TYPE_SET: ReadonlySet<string> = new Set(
  AI_PROVIDER_TYPES,
);

/**
 * Target environments supported by the Rule Synthesizer.
 * @beta
 */
export const SYNTHESIS_TARGETS = [
  'all',
  'adguard',
  'pihole',
  'ublock',
  'unbound',
  'dnsmasq',
  'hosts',
] as const;
export type SynthesisTarget = (typeof SYNTHESIS_TARGETS)[number];
export const SYNTHESIS_TARGET_SET: ReadonlySet<string> = new Set(
  SYNTHESIS_TARGETS,
);

/**
 * Verdict of evaluating a domain against a set of filter rules.
 * @beta
 */
export const DOMAIN_VERDICTS = ['blocked', 'exception', 'not_blocked'] as const;
export type DomainVerdict = (typeof DOMAIN_VERDICTS)[number];
export const DOMAIN_VERDICT_SET: ReadonlySet<string> = new Set(DOMAIN_VERDICTS);

/**
 * Network infrastructure kind classified by heuristic analyzer.
 * @beta
 */
export const INFRA_KINDS = [
  'ad-network',
  'tracker-network',
  'cloud',
  'cdn',
  'iot',
  'vendor',
  'platform',
  'dns',
  'none',
] as const;
export type InfraKind = (typeof INFRA_KINDS)[number];
export const INFRA_KIND_SET: ReadonlySet<string> = new Set(INFRA_KINDS);

/**
 * Supported anti-adblock circumvention / detection providers.
 * @beta
 */
export const ANTI_ADBLOCK_PROVIDERS = [
  'admiral',
  'google-fc',
  'blockthrough',
  'adinplay',
  'ezoic',
  'nitropay',
  'snigel',
  'generic',
] as const;
export type AntiAdblockProviderId = (typeof ANTI_ADBLOCK_PROVIDERS)[number];
export const ANTI_ADBLOCK_PROVIDER_SET: ReadonlySet<string> = new Set(
  ANTI_ADBLOCK_PROVIDERS,
);

/**
 * Independent evidence families that can support a threat verdict.
 *
 * "Specific" families are name-based knowledge with high precision — a match is
 * itself meaningful. The remaining families are statistical shape measurements of a
 * single hostname, which a perfectly legitimate name can exhibit by accident.
 */
export type EvidenceFamily =
  | 'known-network'
  | 'brand-impersonation'
  | 'cname-uncloak'
  | 'punycode'
  | 'hex-sld'
  | 'vowel-free'
  | 'keyword'
  | 'consonant-run'
  | 'digit-run'
  | 'ngram'
  | 'abuse-tld';

/**
 * `corroborated` — enough independent evidence for a confident verdict.
 * `single-signal` — one family only; a lead, not a finding.
 * `lexical-only` — the model's own probability is the sole support.
 */
export type CorroborationTier = 'corroborated' | 'single-signal' | 'lexical-only';

export interface CorroborationAssessment {
  /** Evidence families detected, most specific first. */
  families: EvidenceFamily[];
  /** How many detected families are high-precision name-based matches. */
  specific: number;
  tier: CorroborationTier;
  /** Highest risk level this evidence can justify. */
  maxRiskLevel: RiskLevel;
  /** Highest confidence percentage this evidence can justify. */
  maxConfidence: number;
}

export interface MiniAiFeatureContribution {
  name: string;
  value: number;
  weight: number;
  impact: 'threat' | 'clean' | 'neutral';
  description: string;
}

export interface MiniAiPrediction {
  verdict: AiVerdict;
  category: ThreatCategory;
  confidence: number;
  riskLevel: RiskLevel;
  classProbabilities: Record<ThreatCategory, number>;
  topContributions: MiniAiFeatureContribution[];
  inferenceTimeMs: number;
  reasons: string[];
  /**
   * How well the verdict is corroborated — see `assessCorroboration()`. Omitted on
   * fail-safe and short-circuit paths (malformed input, IP addresses, whitelist overrides).
   */
  corroboration?: CorroborationTier;
  /** Independent evidence families detected for this verdict. */
  evidenceFamilies?: EvidenceFamily[];
}

/**
 * Triage cascade settings.
 *
 * With `enabled`, the embedded classifier screens every candidate first and the
 * configured `provider` is used only as the *escalation backend* for the candidates it
 * cannot defend. Without it, `provider` keeps its original meaning: the single engine
 * that evaluates everything, with no local screening pass.
 * @beta
 */
export interface TriageCascadeConfig {
  enabled: boolean;
  /** Escalations allowed per scan call. */
  maxEscalations?: number;
  /** Escalations already spent, so a session budget can be enforced across calls. */
  spentEscalations?: number;
  /** Ambiguity below which a candidate is resolved locally. */
  minAmbiguity?: number;
  /** Allow escalating an uncertain *clean* verdict (off by default). */
  escalateClean?: boolean;
}

/**
 * What the cascade did with one candidate, recorded on the scan result so a verdict can
 * be traced back to the screening pass that produced it.
 * @beta
 */
export interface TriageOutcomeSummary {
  action: 'resolve-locally' | 'escalate' | 'deferred';
  /** 0-1; how undecided the local verdict was. */
  ambiguity: number;
  /** Signal codes that fired, e.g. `near-tie`, `unsupported`. */
  signals: string[];
  /** One line per firing signal, suitable for display. */
  explanations: string[];
  /** Where the final verdict came from. */
  source: 'local' | 'escalated' | 'contested';
  /** The escalation recommended clearing a target the local evidence defends. */
  contradicted: boolean;
  /** An escalation was attempted and failed; the local verdict stands. */
  escalationFailed: boolean;
  model?: string;
}

export interface AiProviderConfig {
  provider: AiProviderType;
  cascade?: TriageCascadeConfig;
  ollamaUrl?: string; // Default http://127.0.0.1:11434
  ollamaModel?: string; // Default llama3.2
  apiKey?: string;
  /** Electron-side sealed form of `apiKey` — set at rest, resolved to `apiKey` on read. */
  apiKeyEncrypted?: string;
  apiEndpoint?: string;
  modelName?: string;
  allowlist?: string[];
  bypassCache?: boolean;
  skipDns?: boolean;
  dnsTimeoutMs?: number;
  existingRules?: string[];
}

export interface RuleCoverageResult {
  isCovered: boolean;
  coveringRule?: string;
}

export interface DomainLabelEntropy {
  label: string;
  entropy: number;
  isSuspicious: boolean;
}

export interface DomainDecomposition {
  sld: string;
  tld: string;
  subdomains: string[];
  labelEntropies: DomainLabelEntropy[];
}

export interface AiScanResult {
  target: string;
  domain: string;
  verdict: AiVerdict;
  confidence: number; // 0 to 100
  riskLevel: RiskLevel;
  category: ThreatCategory;
  reasons: string[];
  entropy: number;
  isLikelyDga: boolean;
  decomposition?: DomainDecomposition;
  cnames: string[];
  resolvedIps: string[];
  generatedRules: string[];
  coveredByRule?: string;
  featureScores?: Record<string, number>;
  inferenceTimeMs?: number;
  provider: AiProviderType;
  modelUsed?: string;
  antiAdblock?: AntiAdblockDetection;
  /**
   * Present only when the false-positive guard cleared this target before screening ran.
   *
   * Independent of `triage`: the guard sits in front of both the cascade and the single-engine
   * paths, so this is set with the cascade on or off.
   */
  falsePositiveGuard?: FalsePositiveGuardResult;
  /** Present only when the triage cascade evaluated this target. */
  triage?: TriageOutcomeSummary;
  timestamp: string;
}

export interface RawDnsQuery {
  domain: string;
  client?: string;
  timestamp?: string;
  elapsedMs?: number;
  blocked?: boolean;
  clientIp?: string;
  statusCode?: string;
  recordType?: string;
}

export interface QueryLogScanResult {
  totalQueriesAnalyzed: number;
  flaggedCount: number;
  cleanCount: number;
  results: AiScanResult[];
  timestamp: string;
}

export interface CrawlScanResult {
  url: string;
  scannedAt: string;
  extractedHosts: string[];
  newUnblockedHosts: string[];
  flaggedHosts: AiScanResult[];
  synthesizedRules: string[];
}

export interface CompactionResult {
  originalCount: number;
  compactedCount: number;
  compactedRules: string[];
  savingsPercent: number;
  collapsedGroups: Array<{
    parentDomain: string;
    subdomains: string[];
    rule: string;
  }>;
}

export interface RuleConflictResult {
  hasConflict: boolean;
  conflictingAllowRule?: string;
  suggestedOverrideRule?: string;
  reason?: string;
}

export interface DomainRuleMatch {
  rule: string;
  pattern: string;
  isWildcard: boolean;
  isImportant: boolean;
  source?: string;
  ruleType?: string;
  denyAllowDomains?: string[];
}

export interface DomainEvaluationResult {
  domain: string;
  verdict: DomainVerdict;
  matchingRule?: string;
  matchingRules: DomainRuleMatch[];
  exceptionRule?: string;
  overriddenRules: string[];
  details: string;
}

export interface DgaDetectionResult {
  isLikelyDga: boolean;
  score: number; // 0 (normal) to 100 (high probability machine generated)
  reasons: string[];
}

export interface InfraClassification {
  safe: boolean;
  adNetwork: boolean;
  kind: InfraKind;
  suffix?: string;
  reason: string;
}

export interface ReputationFeatures {
  brandSpoofScore: number;
  knownSafeInfra: number;
  adKeywordWeight: number;
  trackerKeywordWeight: number;
  consentKeywordWeight?: number;
  trigramPerplexity: number;
  entropySld: number;
  entropySubdomain?: number;
  sldLength: number;
  highRiskTld: number;
  punycode: number;
  consecutiveConsonants: number;
  vowelRatio: number;
  userTuneBias?: number;
  hexScore?: number;
  cnameKnownTracker?: number;
}

export interface CategoryAdjustment {
  category: ThreatCategory;
  probability: number;
  policyReason?: string;
}

export interface RuleSynthesisInput {
  domain: string;
  verdict: AiVerdict;
  category: ThreatCategory;
  cnames?: string[];
  isSubdomain?: boolean;
  target?: SynthesisTarget;
  includeComments?: boolean;
  confidence?: number;
}

export interface DomainFeatureVector {
  entropyFull: number;
  entropySld: number;
  entropySubdomain: number;
  domainLength: number;
  sldLength: number;
  subdomainDepth: number;
  vowelRatio: number;
  consonantRatio: number;
  digitRatio: number;
  consecutiveConsonants: number;
  consecutiveDigits: number;
  hexScore: number;
  trigramPerplexity: number;
  adKeywordWeight: number;
  trackerKeywordWeight: number;
  consentKeywordWeight: number;
  cnameKnownTracker: number;
  cnameExternal: number;
  cnameDepth: number;
  knownSafeInfra: number;
  highRiskTld: number;
  punycode: number;
  hyphenRatio: number;
  syllableCadence: number;
  numericSubdomain: number;
  userTuneBias: number;
  brandSpoofScore: number;
}

export interface CnameResolutionResult {
  domain: string;
  cnames: string[];
  ips: string[];
  hasCnameCloaking: boolean;
  cloakedTarget?: string;
  knownTrackerTarget?: string;
  isExternalCname?: boolean;
}

export interface AntiAdblockDetection {
  detected: boolean;
  provider?: AntiAdblockProviderId;
  providerName?: string;
  reason?: string;
}

/**
 * The pre-screening false-positive guard's verdict on a target, recorded rather than implied.
 *
 * `isSafeInfrastructure` runs *before* any classifier or model — infrastructure, product endpoints
 * and allowlisted hosts are cleared on sight — so a guarded result has no `triage` record and no
 * `featureScores`. That is a deliberate skip, not a cascade that decided nothing, and the
 * distinction was previously readable only from the sentence appended to `reasons`. Anything
 * showing a screen's coverage needs it as data, because "no cascade record" and "the guard cleared
 * it" mean opposite things about a running scan and look identical on the result.
 *
 * `cleared` is kept as a field rather than inferred from presence so a future "evaluated but not
 * cleared" record has somewhere to go without changing the shape readers already handle.
 * @beta
 */
export interface FalsePositiveGuardResult {
  /** The target was cleared before screening. */
  cleared: boolean;
  /** Why, as the guard phrases it, e.g. `Product status, API, CDN, or update endpoint`. */
  reason?: string;
}

// -----------------------------------------------------------------------------
// Runtime Type Guards (Validation Predicates)
// -----------------------------------------------------------------------------

export function isThreatCategory(val: unknown): val is ThreatCategory {
  return typeof val === 'string' && THREAT_CATEGORY_SET.has(val);
}

export function isRiskLevel(val: unknown): val is RiskLevel {
  return typeof val === 'string' && RISK_LEVEL_SET.has(val);
}

export function isAiVerdict(val: unknown): val is AiVerdict {
  return typeof val === 'string' && AI_VERDICT_SET.has(val);
}

export function isAiProviderType(val: unknown): val is AiProviderType {
  return typeof val === 'string' && AI_PROVIDER_TYPE_SET.has(val);
}

export function isSynthesisTarget(val: unknown): val is SynthesisTarget {
  return typeof val === 'string' && SYNTHESIS_TARGET_SET.has(val);
}

export function isDomainVerdict(val: unknown): val is DomainVerdict {
  return typeof val === 'string' && DOMAIN_VERDICT_SET.has(val);
}

export function isInfraKind(val: unknown): val is InfraKind {
  return typeof val === 'string' && INFRA_KIND_SET.has(val);
}

export function isAntiAdblockProviderId(
  val: unknown,
): val is AntiAdblockProviderId {
  return typeof val === 'string' && ANTI_ADBLOCK_PROVIDER_SET.has(val);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInRange(
  value: unknown,
  min: number,
  max = Infinity,
): value is number {
  return isFiniteNumber(value) && value >= min && value <= max;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isDomainDecomposition(value: unknown): value is DomainDecomposition {
  return (
    isRecord(value) &&
    typeof value.sld === 'string' &&
    typeof value.tld === 'string' &&
    isStringArray(value.subdomains) &&
    Array.isArray(value.labelEntropies) &&
    value.labelEntropies.every(
      (label) =>
        isRecord(label) &&
        typeof label.label === 'string' &&
        isInRange(label.entropy, 0) &&
        typeof label.isSuspicious === 'boolean',
    )
  );
}

function isDomainRuleMatch(value: unknown): value is DomainRuleMatch {
  return (
    isRecord(value) &&
    typeof value.rule === 'string' &&
    typeof value.pattern === 'string' &&
    typeof value.isWildcard === 'boolean' &&
    typeof value.isImportant === 'boolean' &&
    isOptionalString(value.source) &&
    isOptionalString(value.ruleType) &&
    (value.denyAllowDomains === undefined ||
      isStringArray(value.denyAllowDomains))
  );
}

export function isAiScanResult(val: unknown): val is AiScanResult {
  if (!isRecord(val)) return false;
  return (
    typeof val.domain === 'string' &&
    typeof val.target === 'string' &&
    isAiVerdict(val.verdict) &&
    isThreatCategory(val.category) &&
    isRiskLevel(val.riskLevel) &&
    isInRange(val.confidence, 0, 100) &&
    isStringArray(val.reasons) &&
    isInRange(val.entropy, 0) &&
    typeof val.isLikelyDga === 'boolean' &&
    isStringArray(val.cnames) &&
    isStringArray(val.resolvedIps) &&
    isStringArray(val.generatedRules) &&
    isAiProviderType(val.provider) &&
    typeof val.timestamp === 'string' &&
    Number.isFinite(Date.parse(val.timestamp)) &&
    isOptionalString(val.coveredByRule) &&
    isOptionalString(val.modelUsed) &&
    (val.inferenceTimeMs === undefined || isInRange(val.inferenceTimeMs, 0)) &&
    (val.decomposition === undefined ||
      isDomainDecomposition(val.decomposition)) &&
    (val.featureScores === undefined ||
      (isRecord(val.featureScores) &&
        Object.values(val.featureScores).every(isFiniteNumber))) &&
    (val.antiAdblock === undefined ||
      (isRecord(val.antiAdblock) &&
        typeof val.antiAdblock.detected === 'boolean' &&
        (val.antiAdblock.provider === undefined ||
          isAntiAdblockProviderId(val.antiAdblock.provider)) &&
        isOptionalString(val.antiAdblock.providerName) &&
        isOptionalString(val.antiAdblock.reason))) &&
    (val.falsePositiveGuard === undefined ||
      (isRecord(val.falsePositiveGuard) &&
        typeof val.falsePositiveGuard.cleared === 'boolean' &&
        isOptionalString(val.falsePositiveGuard.reason))) &&
    (val.triage === undefined ||
      (isRecord(val.triage) &&
        (val.triage.action === 'resolve-locally' ||
          val.triage.action === 'escalate' ||
          val.triage.action === 'deferred') &&
        isInRange(val.triage.ambiguity, 0, 1) &&
        isStringArray(val.triage.signals) &&
        isStringArray(val.triage.explanations) &&
        (val.triage.source === 'local' ||
          val.triage.source === 'escalated' ||
          val.triage.source === 'contested') &&
        typeof val.triage.contradicted === 'boolean' &&
        typeof val.triage.escalationFailed === 'boolean' &&
        isOptionalString(val.triage.model)))
  );
}

export function isMiniAiPrediction(val: unknown): val is MiniAiPrediction {
  if (!isRecord(val)) return false;
  const probabilities = val.classProbabilities;
  return (
    isAiVerdict(val.verdict) &&
    isThreatCategory(val.category) &&
    isRiskLevel(val.riskLevel) &&
    isInRange(val.confidence, 0, 100) &&
    isInRange(val.inferenceTimeMs, 0) &&
    isRecord(probabilities) &&
    THREAT_CATEGORIES.every((category) =>
      isInRange(probabilities[category], 0, 1),
    ) &&
    Array.isArray(val.topContributions) &&
    val.topContributions.every(
      (item) =>
        isRecord(item) &&
        typeof item.name === 'string' &&
        typeof item.description === 'string' &&
        isFiniteNumber(item.value) &&
        isFiniteNumber(item.weight) &&
        (item.impact === 'threat' ||
          item.impact === 'clean' ||
          item.impact === 'neutral'),
    ) &&
    isStringArray(val.reasons)
  );
}

export function isDomainEvaluationResult(
  val: unknown,
): val is DomainEvaluationResult {
  return (
    isRecord(val) &&
    typeof val.domain === 'string' &&
    isDomainVerdict(val.verdict) &&
    Array.isArray(val.matchingRules) &&
    val.matchingRules.every(isDomainRuleMatch) &&
    isStringArray(val.overriddenRules) &&
    typeof val.details === 'string' &&
    isOptionalString(val.matchingRule) &&
    isOptionalString(val.exceptionRule)
  );
}

export function isCompactionResult(val: unknown): val is CompactionResult {
  return (
    isRecord(val) &&
    isInRange(val.originalCount, 0) &&
    Number.isInteger(val.originalCount) &&
    isInRange(val.compactedCount, 0) &&
    Number.isInteger(val.compactedCount) &&
    isStringArray(val.compactedRules) &&
    isInRange(val.savingsPercent, 0, 100) &&
    Array.isArray(val.collapsedGroups) &&
    val.collapsedGroups.every(
      (group) =>
        isRecord(group) &&
        typeof group.parentDomain === 'string' &&
        typeof group.rule === 'string' &&
        isStringArray(group.subdomains),
    )
  );
}

// -----------------------------------------------------------------------------
// Runtime Normalizers & Sanitizers
// -----------------------------------------------------------------------------

export function normalizeVerdict(
  val: unknown,
  fallback: AiVerdict = 'suspicious',
): AiVerdict {
  if (isAiVerdict(val)) return val;
  if (typeof val === 'string') {
    const lower = val.toLowerCase().trim();
    if (isAiVerdict(lower)) return lower;
    if (
      lower === 'clean' ||
      lower === 'safe' ||
      lower === 'allow' ||
      lower === 'benign'
    )
      return 'clean';
    if (
      lower === 'ad' ||
      lower === 'ads' ||
      lower === 'adserver' ||
      lower === 'advertising'
    )
      return 'ad_server';
    if (
      lower === 'tracker' ||
      lower === 'tracking' ||
      lower === 'telemetry' ||
      lower === 'analytics'
    )
      return 'tracker';
    if (lower === 'malware' || lower === 'malicious' || lower === 'phishing')
      return 'malicious';
    if (
      lower === 'annoyance' ||
      lower === 'annoyances' ||
      lower === 'consent' ||
      lower === 'consent_management' ||
      lower === 'cmp'
    )
      return 'annoyance';
    if (lower === 'suspicious' || lower === 'unknown') return 'suspicious';
  }
  return fallback;
}

export function normalizeThreatCategory(
  val: unknown,
  fallback: ThreatCategory = 'Unknown',
): ThreatCategory {
  if (isThreatCategory(val)) return val;
  if (typeof val === 'string') {
    const lower = val.toLowerCase().trim();
    if (lower.includes('cname') || lower.includes('cloak'))
      return 'CNAME Cloaking';
    if (/\b(?:malware|malicious|phishing|phish)\b/.test(lower))
      return 'Malware/Phishing';
    if (
      /\b(?:ad|ads|adserver|ad_server|advertising|advertisement)\b/.test(lower)
    )
      return 'Advertising';
    if (/\b(?:telemetry|analytics?|tracker|tracking)\b/.test(lower))
      return 'Telemetry/Analytics';
    if (
      /\b(?:consent|annoyance|annoyances|cmp|gdpr|ccpa|cookie.?consent)\b/.test(lower)
    )
      return 'Consent/Annoyance';
    if (/\b(?:clean|safe|benign)\b/.test(lower)) return 'Clean';
  }
  return fallback;
}

export function normalizeRiskLevel(
  val: unknown,
  fallback: RiskLevel = 'low',
): RiskLevel {
  if (isRiskLevel(val)) return val;
  if (typeof val === 'string') {
    const lower = val.toLowerCase().trim();
    if (isRiskLevel(lower)) return lower;
  }
  return fallback;
}

export function clampConfidence(val: unknown, fallback = 0): number {
  const value = isFiniteNumber(val)
    ? val
    : isFiniteNumber(fallback)
      ? fallback
      : 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

// -----------------------------------------------------------------------------
// Safe Default Factory Builders
// -----------------------------------------------------------------------------

export function createDefaultScanResult(
  domain: string,
  overrides?: Partial<AiScanResult>,
): AiScanResult {
  return {
    target: domain,
    domain,
    verdict: 'clean',
    confidence: 0,
    riskLevel: 'none',
    category: 'Clean',
    reasons: [],
    entropy: 0,
    isLikelyDga: false,
    cnames: [],
    resolvedIps: [],
    generatedRules: [],
    provider: 'mini-ai',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

export function createDefaultMiniAiPrediction(
  overrides?: Partial<MiniAiPrediction>,
): MiniAiPrediction {
  return {
    verdict: 'clean',
    category: 'Clean',
    confidence: 0,
    riskLevel: 'none',
    classProbabilities: {
      Clean: 1.0,
      Advertising: 0,
      'Telemetry/Analytics': 0,
      'Consent/Annoyance': 0,
      'CNAME Cloaking': 0,
      'Malware/Phishing': 0,
      Unknown: 0,
    },
    topContributions: [],
    inferenceTimeMs: 0,
    reasons: [],
    ...overrides,
  };
}

export function createDefaultDomainEvaluationResult(
  domain: string,
  overrides?: Partial<DomainEvaluationResult>,
): DomainEvaluationResult {
  return {
    domain,
    verdict: 'not_blocked',
    matchingRules: [],
    overriddenRules: [],
    details: 'No blocking rules matched domain',
    ...overrides,
  };
}
