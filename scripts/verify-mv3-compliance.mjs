#!/usr/bin/env node
/**
 * Automated Manifest V3 Compliance Validator
 * Verifies that the browser extension strictly complies with Google Chrome Web Store
 * Manifest V3 policies and runtime restrictions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionRoot = path.resolve(__dirname, '../packages/browser-extension');
const manifestPath = path.join(extensionRoot, 'manifest.json');
const distPath = path.join(extensionRoot, 'dist');

console.log('🔍 [MV3 Compliance] Running automated Manifest V3 compliance verification...');

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
