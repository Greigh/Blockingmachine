/**
 * Blockingmachine AI Subsystem
 *
 * Provides intelligent threat detection, Shannon entropy lexical analysis,
 * DGA identification, multi-format rule evaluation and precedence resolution,
 * CNAME cloaking unwrapping, anti-adblock defusal synthesis, and machine learning classification.
 *
 * @packageDocumentation
 * @beta
 */

// 1. Data Models, Enums & Interfaces
export * from './types.js';

// 2. Registrable Domain & Hostname Reputation, Brand Spoof & Anti-Adblock
export * from './reputation.js';

// 3. Shannon Entropy, DGA Heuristics & Domain Decomposition
export * from './entropy.js';

// 4. CNAME Resolution, Recursive Cloak Tracing & Network Graph
export * from './cnameResolver.js';

// 5. Filter Rule Synthesizer, Coverage Trie & Conflict Solver
export * from './ruleSynthesizer.js';

// 6. RFC/Adblock Domain Evaluator & Precedence Engine
export * from './domainEvaluator.js';

// 7. Embedded Mini-AI Machine Learning Classifier
export * from './MiniAiClassifier.js';

// 8. AI Detector Multi-Provider Service Orchestrator
export * from './AiDetectorService.js';
