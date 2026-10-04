#!/usr/bin/env node
/**
 * Automated Manifest V3 Compliance Validator
 * Verifies that the browser extension strictly complies with Google Chrome Web Store
 * Manifest V3 policies and runtime restrictions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgvOrExit } from './argv.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionRoot = path.resolve(__dirname, '../packages/browser-extension');
const manifestPath = path.join(extensionRoot, 'manifest.json');
const distPath = path.join(extensionRoot, 'dist');

// This script takes no arguments — a stray `--flag` or extra word was previously ignored, so
// anything that arrives is a question nobody asked: refuse it.
parseArgvOrExit(process.argv.slice(2), {});

console.log('🔍 [MV3 Compliance] Running automated Manifest V3 compliance verification...');

// Chrome's documented bounds for declarativeNetRequest static rulesets.
const MAX_STATIC_RULES = 30000;
const MAX_STATIC_RULESETS = 100;
// Static rules lose priority ties to session and dynamic rules, so every tier rule is pinned
// to the bottom band. A tier at a higher priority could outrank a synced exception or a user
// allowance, which is exactly what a shipped ruleset must never be able to do.
//
// A tier may also ship *only* block rules, and that is not decoration either: priorities are
// compared across the whole match set, so a static `allow` parked at priority 2 would beat a
// dynamic block at priority 1 — a shipped list overriding the extension's own blocking. Keeping
// every tier rule a bottom-priority block is what guarantees a synced exception (2), a user
// allowance (500), or a site pause (1000) always wins. `PRIORITY_STATIC_TIER` in
// `src/shared/rulesetTiers.ts` is the same figure; a test pins the two together.
const STATIC_TIER_PRIORITY = 1;

let hasErrors = false;

function error(msg) {
  console.error(`❌ [MV3 Violation] ${msg}`);
  hasErrors = true;
}

function success(msg) {
  console.log(`✅ [MV3 Compliant] ${msg}`);
}

// 1. Verify manifest.json exists
if (!fs.existsSync(manifestPath)) {
  error(`manifest.json not found at ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// 2. Validate manifest_version === 3
if (manifest.manifest_version !== 3) {
  error(`manifest_version must be 3, found: ${manifest.manifest_version}`);
} else {
  success('manifest_version is 3');
}

// 3. Prohibited permissions (MV2 remnants)
const prohibitedPermissions = [
  'webRequestBlocking',
  'background', // replaced by background.service_worker
  'debugger'
];

for (const perm of manifest.permissions || []) {
  if (prohibitedPermissions.includes(perm)) {
    error(`Prohibited MV3 permission found in manifest: "${perm}"`);
  }
}
success('No prohibited or deprecated MV2 permissions declared');

// 4. Background service worker check
if (!manifest.background || !manifest.background.service_worker) {
  error('Missing "background.service_worker" in manifest');
} else {
  success(`Service worker configured: ${manifest.background.service_worker}`);
}

// 4b. Static declarativeNetRequest ruleset tiers
//
// These are shipped as JSON files the manifest names by path, so a broken file or a stale
// path ships a silently inert tier. Validate the bytes Chrome will actually parse.
const dnrConfig = manifest.declarative_net_request;
const ruleResources = dnrConfig && Array.isArray(dnrConfig.rule_resources) ? dnrConfig.rule_resources : [];

if (dnrConfig && !Array.isArray(dnrConfig.rule_resources)) {
  error('"declarative_net_request.rule_resources" must be an array');
}

if (ruleResources.length > 0) {
  if (ruleResources.length > MAX_STATIC_RULESETS) {
    error(`Declared ${ruleResources.length} static rulesets, above the ${MAX_STATIC_RULESETS} limit`);
  }

  const seenRulesetIds = new Set();
  let totalStaticRules = 0;

  for (const resource of ruleResources) {
    const id = resource?.id;
    const resourcePath = resource?.path;

    if (typeof id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
      error(`Static ruleset id ${JSON.stringify(id)} is not a valid identifier`);
      continue;
    }
    if (seenRulesetIds.has(id)) {
      error(`Duplicate static ruleset id "${id}"`);
    }
    seenRulesetIds.add(id);

    if (typeof resource.enabled !== 'boolean') {
      error(`Static ruleset "${id}" must declare a boolean "enabled" flag`);
    }

    if (typeof resourcePath !== 'string' || !resourcePath.endsWith('.json')) {
      error(`Static ruleset "${id}" must declare a ".json" path`);
      continue;
    }
    if (path.isAbsolute(resourcePath) || resourcePath.split('/').includes('..')) {
      error(`Static ruleset "${id}" path must be relative and inside the extension: ${resourcePath}`);
      continue;
    }

    const sourceFile = path.join(extensionRoot, resourcePath);
    if (!fs.existsSync(sourceFile)) {
      error(`Static ruleset "${id}" file is missing: ${resourcePath}`);
      continue;
    }
    if (fs.existsSync(distPath) && !fs.existsSync(path.join(distPath, resourcePath))) {
      error(`Static ruleset "${id}" was not copied into dist: ${resourcePath}`);
    }

    let rules;
    try {
      rules = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    } catch (err) {
      error(`Static ruleset "${id}" is not valid JSON: ${err.message}`);
      continue;
    }
    if (!Array.isArray(rules)) {
      error(`Static ruleset "${id}" must be a JSON array`);
      continue;
    }

    const ruleIds = new Set();
    rules.forEach((rule, index) => {
      const where = `${resourcePath}[${index}]`;
      if (!rule || typeof rule !== 'object') {
        error(`${where} is not an object`);
        return;
      }
      if (!Number.isInteger(rule.id) || rule.id <= 0) {
        error(`${where} needs a positive integer id`);
      } else if (ruleIds.has(rule.id)) {
        error(`${where} duplicates rule id ${rule.id}`);
      } else {
        ruleIds.add(rule.id);
      }

      if (!Number.isInteger(rule.priority) || rule.priority !== STATIC_TIER_PRIORITY) {
        error(`${where} priority must be ${STATIC_TIER_PRIORITY}, not ${JSON.stringify(rule.priority)}`);
      }
      if (!rule.action || typeof rule.action.type !== 'string') {
        error(`${where} needs a rule action`);
      } else if (rule.action.type !== 'block') {
        error(
          `${where} action must be "block", not ${JSON.stringify(rule.action.type)}: a tier may never ship a rule that could outrank the extension's own blocking`
        );
      }
      if (
        !rule.condition ||
        typeof rule.condition.urlFilter !== 'string' ||
        rule.condition.urlFilter.length === 0
      ) {
        error(`${where} needs a condition.urlFilter`);
      }
    });

    totalStaticRules += rules.length;
  }

  if (totalStaticRules > MAX_STATIC_RULES) {
    error(`Static rules total ${totalStaticRules}, above the ${MAX_STATIC_RULES} guaranteed limit`);
  } else {
    success(
      `Static ruleset tiers valid: ${ruleResources.length} rulesets, ${totalStaticRules} rules within the ${MAX_STATIC_RULES} budget`
    );
  }
}

// 5. Content scripts configuration
if (Array.isArray(manifest.content_scripts)) {
  for (const cs of manifest.content_scripts) {
    if (!cs.matches || cs.matches.length === 0) {
      error('Content script entry missing "matches" declaration');
    }
    if (cs.world && !['MAIN', 'ISOLATED'].includes(cs.world)) {
      error(`Invalid content script execution world: "${cs.world}"`);
    }
  }
  success('Content scripts have valid execution contexts (MAIN/ISOLATED)');
}

// 6. Scan compiled dist artifacts for prohibited dynamic code execution
if (fs.existsSync(distPath)) {
  const prohibitedPatterns = [
    { regex: /\beval\s*\(/g, name: 'eval()' },
    { regex: /new\s+Function\s*\(/g, name: 'new Function()' },
    { regex: /document\.write\s*\(/g, name: 'document.write()' },
    { regex: /chrome\.extension\b/g, name: 'deprecated chrome.extension' }
  ];

  const files = fs.readdirSync(distPath).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(distPath, file), 'utf8');
    for (const pattern of prohibitedPatterns) {
      if (pattern.regex.test(content)) {
        // Exclude license comments
        if (!content.includes('LICENSE') || pattern.regex.test(content.replace(/\/\*[\s\S]*?\*\//g, ''))) {
          error(`Prohibited dynamic pattern "${pattern.name}" detected in dist/${file}`);
        }
      }
    }
  }
  success('Zero prohibited dynamic code execution (eval, new Function, document.write) in build bundles');
} else {
  console.warn('⚠️ [MV3 Compliance] dist/ not found, run npm run build before bundle scanning.');
}

if (hasErrors) {
  console.error('\n🚨 [MV3 Compliance Failed] The extension contains violations of Manifest V3 policies.');
  process.exit(1);
} else {
  console.log('\n🎉 [MV3 Compliance Passed] The extension is 100% compliant with Manifest V3 policies.\n');
  process.exit(0);
}
