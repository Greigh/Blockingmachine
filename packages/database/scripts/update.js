#!/usr/bin/env node
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const databaseRoot = path.dirname(__dirname);
const today = new Date().toISOString().split('T')[0];

async function updateFilters() {
  try {
    console.log('🚀 Starting Blockingmachine filter update...');
    
    // Ensure output directory exists
    await fs.mkdir(path.join(databaseRoot, 'filters', 'output'), { recursive: true });
    
    // Copy config to root for CLI
    await fs.copyFile(path.join(databaseRoot, 'sources', '.blockingmachinerc.json'), path.join(databaseRoot, '.blockingmachinerc.json'));
    
    // Check if we should force a fresh import (in CI or if specifically requested)
    const forceFreshImport = process.env.NODE_ENV === 'production' || process.env.FORCE_IMPORT === 'true';
    // Prefer the export path used by the CLI (root ./filters/output), fall back to the old sources path
    let filterListPath = path.join(databaseRoot, 'filters', 'output', 'filter-list.txt');
    try {
      await fs.access(filterListPath);
    } catch (err) {
      // fallback
      filterListPath = path.join(databaseRoot, 'sources', 'filters', 'output', 'filter-list.txt');
    }

    let shouldImport = forceFreshImport;
    
    if (!forceFreshImport) {
      try {
        await fs.access(filterListPath);
        console.log('✅ Using existing filter data from previous successful import');
        shouldImport = false;
      } catch (error) {
        console.log('⚠️ No existing filter data found, attempting CLI import...');
        shouldImport = true;
      }
    } else {
      console.log('🔄 Force importing fresh filter data...');
    }
    
    if (shouldImport) {
      
      // Run Blockingmachine import command from database root
      console.log('📥 Importing filter lists...');
      try {
        const { stdout, stderr } = await execAsync('npx blockingmachine import');
        console.log('Import output:', stdout);
        if (stderr) console.log('Import warnings:', stderr);
        
        // Append personal filters after successful import
        await appendPersonalFilters();
        
      } catch (error) {
        console.error(`❌ Import failed: ${error.message}`);
        console.log('⚠️ Attempting to continue with export...');
      }

      // Run Blockingmachine export command from database root
      console.log('📤 Exporting filter lists...');
      try {
        const { stdout, stderr } = await execAsync(`npx blockingmachine export --output-path filters/output`);
        console.log('Export output:', stdout);
        if (stderr) console.log('Export warnings:', stderr);
      } catch (error) {
        console.error(`❌ Export failed: ${error.message}`);
        console.log('⚠️ Will continue with existing data...');
      }
    }

    // Copy and rename files
    console.log('📁 Organizing output files...');
    await copyAndRenameFiles();

    // Generate DNS-specific AdGuard list
    console.log('🔧 Generating DNS-optimized AdGuard list...');
    await generateDNSAdGuardList();

    // Update README with current date and statistics
    console.log('📝 Updating README...');
    await updateReadme();

    console.log('✅ Filter lists updated successfully!');
    
    return {
      success: true,
      timestamp: new Date().toISOString(),
      date: today
    };
    
  } catch (error) {
    console.error('💥 Error updating filters:', error);
    throw error;
  } finally {
    // Clean up config
    try {
      await fs.unlink(path.join(databaseRoot, '.blockingmachinerc.json'));
    } catch (e) {
      // ignore
    }
  }
}

async function copyAndRenameFiles() {
  // First, copy the main filter file. Prefer the root export path (where the CLI writes),
  // When running in repo context, the generated file is placed in database/filters/output/filter-list.txt,
  // but fall back to the sources path if necessary.
  const adguardPrimaryPath = path.join(databaseRoot, 'filters', 'output', 'filter-list.txt');
  const adguardFallbackPath = path.join(databaseRoot, 'sources', 'filters', 'output', 'filter-list.txt');
  const adguardDestPath = path.join(databaseRoot, 'filters', 'adguardBrowser.txt');
  
  try {
    let content;
    try {
      content = await fs.readFile(adguardPrimaryPath, 'utf-8');
    } catch {
      content = await fs.readFile(adguardFallbackPath, 'utf-8');
    }
    
    // Read the source file and update headers
    const lines = content.split('\n');
    const updatedLines = stampHeaders(lines);
    const ruleCount = lines.filter(isRuleLine).length;

    // Write the updated content to the destination
    await fs.writeFile(adguardDestPath, updatedLines.join('\n'));
    console.log(`✓ Copied filter-list.txt → adguardBrowser.txt (${ruleCount.toLocaleString()} rules)`);
    
    // Generate other formats from the AdGuard format
    console.log('🔄 Generating additional formats from AdGuard list...');
    await generateAdditionalFormats(adguardDestPath);
    
  } catch (error) {
    console.log(`⚠️ Could not copy main filter list: ${error.message}`);
  }
}

const EXCEPTION_RE = /^@@\|\|([^\/\^$]+)\^$/;
const BLOCK_DOMAIN_RE = /^\|\|([^\/\^$]+)\^$/;
const HOSTS_LINE_RE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+([^\s#]+)/;

/** A line that counts as a real rule — not a comment, metadata, or section header. */
const isRuleLine = (line) =>
  line.trim() && !line.startsWith('!') && !line.startsWith('#') && !line.startsWith('[');

/**
 * Re-stamp the `! Last updated:`/`! Rules count:` headers a compiled list
 * carries — the count is recomputed from the lines being shipped, so a subset
 * (like the DNS list) honestly reports its own size.
 */
export function stampHeaders(lines, now = new Date()) {
  const ruleCount = lines.filter(isRuleLine).length;
  return lines.map((line) => {
    if (line.startsWith('! Last updated:')) {
      return `! Last updated: ${now.toISOString()}`;
    }
    if (line.startsWith('! Rules count:')) {
      return `! Rules count: ${ruleCount}`;
    }
    return line;
  });
}

/**
 * The DNS-optimized subset of an AdGuard list: comments and metadata pass
 * through; a rule survives when a DNS resolver could consume it — plain
 * `||domain^` blocks and `@@||domain^` exceptions without modifiers, and
 * hosts-format lines. Everything else (cosmetics, `$`-modifier rules) is
 * browser-only and dropped. Headers are re-stamped with the subset's own count.
 */
export function deriveDnsAdGuardLines(content, now = new Date()) {
  const dnsRules = content
    .split('\n')
    .filter((line) => {
      // Keep comments and metadata
      if (line.startsWith('!') || line.startsWith('#') || line.trim() === '') {
        return true;
      }
      // Keep basic domain blocking rules
      if (line.match(/^\|\|[^$]*\^$/)) {
        return true;
      }
      // Keep whitelisting rules
      if (line.match(/^@@\|\|[^$]*\^$/)) {
        return true;
      }
      // Keep hosts file rules
      if (line.match(HOSTS_LINE_RE)) {
        return true;
      }
      // Remove browser-specific rules with modifiers
      return false;
    });
  return stampHeaders(dnsRules, now);
}

/**
 * Rule-line → artifact transform, extracted pure so the whole conversion layer
 * is unit-testable without touching the filesystem or the CLI.
 *
 * Given the AdGuard-format source lines, returns every derived artifact as a
 * line array: hosts, dnsmasq, unbound, BIND RPZ, Privoxy, Shadowrocket, plus
 * the audit list of `$`-modifier rules the host-style formats cannot express.
 *
 * Semantics worth pinning: `@@||domain^` exceptions suppress blocking entries
 * for the domain *and its subdomains* in every format; `$`-bearing rules are
 * skipped everywhere (and audited); hosts-format source lines reach only the
 * hosts and dnsmasq artifacts (the zone formats can't consume them); wildcard
 * domains never convert.
 */
export function deriveFormatOutputs(lines, now = new Date()) {
  const iso = now.toISOString();

  // Rules skipped for carrying modifiers — audited for transparency.
  const skippedSeen = new Set();
  const skippedModifierRules = [];
  for (const line of lines) {
    if (line && line.includes('$') && !line.trim().startsWith('!') && !skippedSeen.has(line)) {
      skippedSeen.add(line);
      skippedModifierRules.push(line);
    }
  }

  // Exception domains suppress their exact host and every subdomain beneath it.
  const exceptionDomains = new Set();
  for (const line of lines) {
    const match = line.match(EXCEPTION_RE);
    if (match) exceptionDomains.add(match[1].toLowerCase().trim());
  }
  const isDomainAllowed = (d) => {
    const lower = d.toLowerCase();
    if (exceptionDomains.has(lower)) return true;
    for (const ex of exceptionDomains) {
      if (lower.endsWith('.' + ex)) return true;
    }
    return false;
  };

  const stdHeader = (description) => [
    `# Title: Blockingmachine ${description} List`,
    `# Description: Combined filter list optimized for ${description}`,
    '# Homepage: https://github.com/greigh/blockingmachine',
    '# License: BSD-3-Clause',
    '# Made by: Greigh Studios LLC aka Greigh',
    '# Version: 3.0.0',
    `# Last Updated: ${iso}`,
  ];

  const hostsRules = [...stdHeader('AdGuard'), '# Rules count: 0', '# Expires: 1 day', ''];
  const hostsCountIndex = 7;

  const dnsmasqRules = [...stdHeader('AdGuard'), '# Expires: 1 day', ''];
  // The count line is spliced after 'Last Updated' (index 6) — keeping the
  // splice preserves the historical header order exactly.
  const dnsmasqCountIndex = 7;

  const unboundRules = [...stdHeader('unbound'), '# Expires: 1 day', ''];
  const unboundCountIndex = 7;

  const namedRules = [
    '; Title: Blockingmachine BIND RPZ',
    '; Description: Response Policy Zone for BIND, one policy record per blocked name',
    '; Homepage: https://github.com/greigh/blockingmachine',
    '; License: BSD-3-Clause',
    '; Made by: Greigh Studios LLC aka Greigh',
    '; Version: 3.0.0',
    `; Last Updated: ${iso}`,
    '; Expires: 1 day',
    '; Rules count: 0',
    ';',
    '; Enable it in named.conf with:',
    ';   zone "rpz.blockingmachine" { type master; file "db.blockingmachine.rpz"; };',
    ';   options { response-policy { zone "rpz.blockingmachine"; }; };',
    '; `CNAME .` means NXDOMAIN (block); `CNAME rpz-passthru.` means allow.',
    '',
    '$TTL 3600',
    '@ IN SOA localhost. root.localhost. ( 1 3600 600 604800 86400 )',
    '@ IN NS localhost.',
  ];
  const namedCountIndex = 8;

  const privoxyRules = [...stdHeader('Privoxy'), '# Expires: 1 day', '# Rules count: 0', '', '{+block{Blockingmachine Blocklist}}'];
  const privoxyCountIndex = 8;

  const shadowrocketRules = [...stdHeader('Shadowrocket'), '# Expires: 1 day', '# Rules count: 0', '', '[Rule]'];
  const shadowCountIndex = 8;

  let hostsCount = 0;
  let dnsmasqCount = 0;
  let unboundCount = 0;
  let namedCount = 0;
  let privoxyCount = 0;
  let shadowCount = 0;

  const convertible = (domain) =>
    domain && !domain.includes('*') && !domain.includes('$') && !isDomainAllowed(domain);

  for (const line of lines) {
    const exception = line.match(EXCEPTION_RE);
    if (exception) {
      const domain = exception[1];
      hostsRules.push(`# EXCEPTION: @@||${domain}^`);
      dnsmasqRules.push(`# EXCEPTION: @@||${domain}^`, `server=/${domain}/#`);
      unboundRules.push(`# EXCEPTION: @@||${domain}^`, `local-zone: "${domain}" transparent`);
      namedRules.push(`; EXCEPTION: @@||${domain}^`);
      privoxyRules.push(`# EXCEPTION: @@||${domain}^`);
      shadowrocketRules.push(`# EXCEPTION: @@||${domain}^`);
      continue;
    }

    // Rules with modifiers/options cannot be safely converted to host formats.
    if (line.includes('$')) continue;

    // Hosts-format source lines only reach the artifacts that can consume them.
    const hostsMatch = line.match(HOSTS_LINE_RE);
    if (hostsMatch) {
      const domain = hostsMatch[1].trim();
      if (convertible(domain)) {
        hostsRules.push(`0.0.0.0 ${domain}`);
        hostsCount++;
        dnsmasqRules.push(`address=/${domain}/0.0.0.0`);
        dnsmasqCount++;
      }
      continue;
    }

    const blockMatch = line.match(BLOCK_DOMAIN_RE);
    if (blockMatch) {
      const domain = blockMatch[1];
      if (convertible(domain)) {
        hostsRules.push(`0.0.0.0 ${domain}`);
        hostsCount++;
        dnsmasqRules.push(`address=/${domain}/0.0.0.0`);
        dnsmasqCount++;
        unboundRules.push(`local-zone: "${domain}" redirect`, `local-data: "${domain} A 0.0.0.0"`);
        unboundCount++;
        namedRules.push(`${domain} CNAME .`);
        namedCount++;
        privoxyRules.push(`.${domain}`);
        privoxyCount++;
        shadowrocketRules.push(`DOMAIN-SUFFIX,${domain},REJECT`);
        shadowCount++;
      }
    }
  }

  hostsRules[hostsCountIndex] = `# Rules count: ${hostsCount}`;
  dnsmasqRules.splice(dnsmasqCountIndex, 0, `# Rules count: ${dnsmasqCount}`);
  unboundRules.splice(unboundCountIndex, 0, `# Rules count: ${unboundCount}`);
  namedRules[namedCountIndex] = `; Rules count: ${namedCount}`;
  privoxyRules[privoxyCountIndex] = `# Rules count: ${privoxyCount}`;
  shadowrocketRules[shadowCountIndex] = `# Rules count: ${shadowCount}`;

  return { hostsRules, dnsmasqRules, unboundRules, namedRules, privoxyRules, shadowrocketRules, skippedModifierRules };
}

async function generateAdditionalFormats(adguardFilePath) {
  try {
    const content = await fs.readFile(adguardFilePath, 'utf-8');
    const lines = content.split('\n');
    const {
      hostsRules, dnsmasqRules, unboundRules, namedRules, privoxyRules,
      shadowrocketRules, skippedModifierRules,
    } = deriveFormatOutputs(lines);

    await fs.writeFile(path.join(databaseRoot, 'filters', 'hosts.txt'), hostsRules.join('\n'));
    console.log('✓ Generated hosts.txt format');
    await fs.writeFile(path.join(databaseRoot, 'filters', 'dnsmasq.conf'), dnsmasqRules.join('\n'));
    console.log('✓ Generated dnsmasq.conf format');
    await fs.writeFile(path.join(databaseRoot, 'filters', 'unbound.conf'), unboundRules.join('\n'));
    console.log('✓ Generated unbound.conf format');
    await fs.writeFile(path.join(databaseRoot, 'filters', 'named.conf'), namedRules.join('\n'));
    console.log('✓ Generated BIND RPZ zone');
    await fs.writeFile(path.join(databaseRoot, 'filters', 'privoxy.action'), privoxyRules.join('\n'));
    console.log('✓ Generated privoxy.action format');
    await fs.writeFile(path.join(databaseRoot, 'filters', 'shadowrocket.conf'), shadowrocketRules.join('\n'));
    console.log('✓ Generated shadowrocket.conf format');

    // Write audit of skipped modifier-bearing rules for transparency
    try {
      const auditHeader = [];
      auditHeader.push('# Skipped modifier-bearing rules');
      auditHeader.push('# These rules contain `$` modifiers and were not converted to host-style formats');
      auditHeader.push(`# Generated: ${new Date().toISOString()}`);
      auditHeader.push(`# Count: ${skippedModifierRules.length}`);
      auditHeader.push('');
      const auditContent = auditHeader.concat(skippedModifierRules).join('\n');
      await fs.writeFile(path.join(databaseRoot, 'filters', 'skipped-modifier-rules.txt'), auditContent);
      console.log(`✓ Wrote skipped-modifier-rules.txt (${skippedModifierRules.length} rules)`);
    } catch (err) {
      console.log(`⚠️ Could not write skipped-modifier-rules.txt: ${err.message}`);
    }

  } catch (error) {
    console.log(`⚠️ Could not generate additional formats: ${error.message}`);
  }
}

async function generateDNSAdGuardList() {
  try {
    const browserListPath = path.join(databaseRoot, 'filters', 'adguardBrowser.txt');
    const dnsListPath = path.join(databaseRoot, 'filters', 'adguardDns.txt');
    
    const content = await fs.readFile(browserListPath, 'utf-8');
    const updatedDnsRules = deriveDnsAdGuardLines(content);
    const ruleCount = updatedDnsRules.filter(isRuleLine).length;

    await fs.writeFile(dnsListPath, updatedDnsRules.join('\n'));
    console.log(`✓ Generated DNS-optimized AdGuard list (${ruleCount.toLocaleString()} rules)`);
    
  } catch (error) {
    console.log(`⚠️ Could not generate DNS AdGuard list: ${error.message}`);
  }
}

async function updateReadme() {
  try {
    let readme = await fs.readFile(path.join(databaseRoot, 'README.md'), 'utf-8');
    
    // Update last updated date
    readme = readme.replace(/\*\*Last updated:\*\* \d{4}-\d{2}-\d{2}/, `**Last updated:** ${today}`);
    
    // Update statistics if files exist
    try {
      const adguardPath = path.join(databaseRoot, 'filters', 'adguardBrowser.txt');
      const adguardContent = await fs.readFile(adguardPath, 'utf-8');
      const totalRules = adguardContent.split('\n').filter(line => 
        line.trim() && !line.startsWith('!') && !line.startsWith('#') && !line.startsWith('[')
      ).length;
      
      const stats = await fs.stat(adguardPath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(1) + 'MB';
      const formattedCount = totalRules.toLocaleString();
      readme = readme.replace(
        /\| [\d,]+ \| [\d.]+MB? \| \d{4}-\d{2}-\d{2} \|/,
        `| ${formattedCount} | ${sizeMB} | ${today} |`
      );
      
      console.log(`✓ Updated statistics: ${formattedCount} rules, ${sizeMB}`);
    } catch (error) {
      console.log(`⚠️ Could not update statistics: ${error.message}`);
    }
    
    await fs.writeFile(path.join(databaseRoot, 'README.md'), readme);
    console.log('✓ Updated README.md');
    
  } catch (error) {
    console.log(`⚠️ Could not update README: ${error.message}`);
  }
}

async function appendPersonalFilters() {
  try {
    // Use absolute paths
    const importedRulesPath = path.join(databaseRoot, 'filters', 'output', 'imported-rules.txt');
    const personalRulesPath = path.join(databaseRoot, 'sources', 'blockingmachine-rules.txt');
    
    // Read both files
    const importedContent = await fs.readFile(importedRulesPath, 'utf-8');
    const personalContent = await fs.readFile(personalRulesPath, 'utf-8');
    
    // Append personal rules to imported rules
    const combinedContent = importedContent + '\n! Personal Filters\n' + personalContent;
    
    // Write back to imported rules file
    await fs.writeFile(importedRulesPath, combinedContent);
    console.log('✓ Appended personal filters to imported rules');
    
  } catch (error) {
    console.log(`⚠️ Could not append personal filters: ${error.message}`);
  }
}

// Run the update if this script is called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  updateFilters()
    .then(result => {
      console.log('🎉 Update completed successfully:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('💥 Update failed:', error);
      process.exit(1);
    });
}

export { updateFilters };
