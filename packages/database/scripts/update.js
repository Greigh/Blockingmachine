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
  // but fall back to the sources path if necessary.
  let adguardSrcPath = path.join(databaseRoot, 'filters', 'output', 'filter-list.txt');
  try {
    await fs.access(adguardSrcPath);
  } catch (err) {
    adguardSrcPath = path.join(databaseRoot, 'sources', 'filters', 'output', 'filter-list.txt');
  }
  const adguardDestPath = path.join(databaseRoot, 'filters', 'adguardBrowser.txt');
  
  try {
    await fs.access(adguardSrcPath);
    
    // Read the source file and update headers
    const content = await fs.readFile(adguardSrcPath, 'utf-8');
    const lines = content.split('\n');
    
    // Count actual blocking rules (excluding metadata)
    const ruleCount = lines.filter(line => 
      line.trim() && !line.startsWith('!') && !line.startsWith('#') && !line.startsWith('[')
    ).length;
    
    // Update headers with current timestamp and rule count
    const updatedLines = lines.map(line => {
      if (line.startsWith('! Last updated:')) {
        return `! Last updated: ${new Date().toISOString()}`;
      }
      if (line.startsWith('! Rules count:')) {
        return `! Rules count: ${ruleCount}`;
      }
      return line;
    });
    
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

async function generateAdditionalFormats(adguardFilePath) {
  try {
    const content = await fs.readFile(adguardFilePath, 'utf-8');
    const lines = content.split('\n');
    
    // Collect rules skipped due to modifiers (single pass audit)
    const skippedModifierRules = [];
    lines.forEach((line) => {
      if (line && line.includes('$') && !line.trim().startsWith('!')) {
        if (!skippedModifierRules.includes(line)) skippedModifierRules.push(line);
      }
    });

    // Generate hosts format
    const hostsRules = [];
    hostsRules.push('# Title: Blockingmachine AdGuard List');
    hostsRules.push('# Description: Combined filter list optimized for AdGuard');
    hostsRules.push('# Homepage: https://github.com/greigh/blockingmachine');
    hostsRules.push('# License: BSD-3-Clause');
    hostsRules.push('# Made by: Daniel Hipskind aka Greigh');
    hostsRules.push('# Version: 3.0.0');
    hostsRules.push(`# Last Updated: ${new Date().toISOString()}`);
    // placeholder for rules count (will be replaced after generation)
    const hostsCountIndex = hostsRules.length;
    hostsRules.push(`# Rules count: 0`);
    hostsRules.push('# Expires: 1 day');
    hostsRules.push('');
    let hostsCount = 0;

    lines.forEach((line) => {
      // Preserve exception (allowlist) rules as comments so everything stays in one list
      if (line.match(/^@@\|\|([^\/\^$]+)\^$/)) {
        const domain = line.replace(/^@@\|\|/, '').replace(/\^$/, '');
        if (domain) {
          hostsRules.push(`# EXCEPTION: @@||${domain}^`);
        }
        return;
      }
      // Skip rules containing modifiers/options (they cannot be safely converted to hosts)
      if (line.includes('$')) return;

      // Normal blocking domain rules (AdGuard/uBO format)
      if (line.match(/^\|\|([^\/\^$]+)\^$/)) {
        const domain = line.replace(/^\|\|/, '').replace(/\^$/, '');
        if (domain && !domain.includes('*') && !domain.includes('$')) {
          hostsRules.push(`0.0.0.0 ${domain}`);
          hostsCount++;
        }
      }
    });
    // update rules count header
    hostsRules[hostsCountIndex] = `# Rules count: ${hostsCount}`;

    await fs.writeFile(path.join(databaseRoot, 'filters', 'hosts.txt'), hostsRules.join('\n'));
    console.log('✓ Generated hosts.txt format');
    
    // Generate basic dnsmasq format
    const dnsmasqRules = [];
    dnsmasqRules.push('# Title: Blockingmachine AdGuard List');
    dnsmasqRules.push('# Description: Combined filter list optimized for AdGuard');
    dnsmasqRules.push('# Homepage: https://github.com/greigh/blockingmachine');
    dnsmasqRules.push('# License: BSD-3-Clause');
    dnsmasqRules.push('# Made by: Daniel Hipskind aka Greigh');
    dnsmasqRules.push('# Version: 3.0.0');
    dnsmasqRules.push(`# Last Updated: ${new Date().toISOString()}`);
    dnsmasqRules.push('# Expires: 1 day');
    dnsmasqRules.push('');
    const dnsmasqCountIndex = dnsmasqRules.length - 2; // position of rules count will be inserted earlier
    let dnsmasqCount = 0;

    lines.forEach((line) => {
      if (line.match(/^@@\|\|([^\/\^$]+)\^$/)) {
        const domain = line.replace(/^@@\|\|/, '').replace(/\^$/, '');
        if (domain) dnsmasqRules.push(`# EXCEPTION: @@||${domain}^`);
        return;
      }

      // Skip rules with modifiers/options
      if (line.includes('$')) return;

      if (line.match(/^\|\|([^\/\^$]+)\^$/)) {
        const domain = line.replace(/^\|\|/, '').replace(/\^$/, '');
        if (domain && !domain.includes('*') && !domain.includes('$')) {
          dnsmasqRules.push(`address=/${domain}/0.0.0.0`);
          dnsmasqCount++;
        }
      }
    });
    // insert rules count after Last Updated (which is at index 6)
    dnsmasqRules.splice(7, 0, `# Rules count: ${dnsmasqCount}`);

    await fs.writeFile(path.join(databaseRoot, 'filters', 'dnsmasq.conf'), dnsmasqRules.join('\n'));
    console.log('✓ Generated dnsmasq.conf format');
    
    // Generate unbound format
    const unboundRules = [];
    unboundRules.push('# Title: Blockingmachine unbound List');
    unboundRules.push('# Description: Combined filter list optimized for unbound');
    unboundRules.push('# Homepage: https://github.com/greigh/blockingmachine');
    unboundRules.push('# License: BSD-3-Clause');
    unboundRules.push('# Made by: Daniel Hipskind aka Greigh');
    unboundRules.push('# Version: 3.0.0');
    unboundRules.push(`# Last Updated: ${new Date().toISOString()}`);
    unboundRules.push('# Expires: 1 day');
    unboundRules.push('');
    let unboundCount = 0;

    lines.forEach((line) => {
      if (line.match(/^@@\|\|([^\/\^$]+)\^$/)) {
        const domain = line.replace(/^@@\|\|/, '').replace(/\^$/, '');
        if (domain) {
          unboundRules.push(`# EXCEPTION: @@||${domain}^`);
        }
        return;
      }

      // Skip rules with modifiers/options
      if (line.includes('$')) return;

      if (line.match(/^\|\|([^\/\^$]+)\^$/)) {
        const domain = line.replace(/^\|\|/, '').replace(/\^$/, '');
        if (domain && !domain.includes('*') && !domain.includes('$')) {
          unboundRules.push(`local-zone: "${domain}" redirect`);
          unboundRules.push(`local-data: "${domain} A 0.0.0.0"`);
          unboundCount++;
        }
      }
    });
    unboundRules.splice(7, 0, `# Rules count: ${unboundCount}`);

    await fs.writeFile(path.join(databaseRoot, 'filters', 'unbound.conf'), unboundRules.join('\n'));
    console.log('✓ Generated unbound.conf format');
    
    // Generate BIND named.conf format
    const namedRules = [];
    namedRules.push('# Title: Blockingmachine BIND List');
    namedRules.push('# Description: Combined filter list optimized for BIND');
    namedRules.push('# Homepage: https://github.com/greigh/blockingmachine');
    namedRules.push('# License: BSD-3-Clause');
    namedRules.push('# Made by: Daniel Hipskind aka Greigh');
    namedRules.push('# Version: 3.0.0');
    namedRules.push(`# Last Updated: ${new Date().toISOString()}`);
    namedRules.push('# Expires: 1 day');
    namedRules.push('');
    let namedCount = 0;

    lines.forEach((line) => {
      if (line.match(/^@@\|\|([^\/\^$]+)\^$/)) {
        const domain = line.replace(/^@@\|\|/, '').replace(/\^$/, '');
        if (domain) namedRules.push(`# EXCEPTION: @@||${domain}^`);
        return;
      }

      // Skip rules with modifiers/options
      if (line.includes('$')) return;

      if (line.match(/^\|\|([^\/\^$]+)\^$/)) {
        const domain = line.replace(/^\|\|/, '').replace(/\^$/, '');
        if (domain && !domain.includes('*') && !domain.includes('$')) {
          namedRules.push(`zone "${domain}" { type master; file "/dev/null"; };`);
          namedCount++;
        }
      }
    });
    namedRules.splice(7, 0, `# Rules count: ${namedCount}`);

    await fs.writeFile(path.join(databaseRoot, 'filters', 'named.conf'), namedRules.join('\n'));
    console.log('✓ Generated named.conf format');
    
    // Generate Privoxy format
    const privoxyRules = [];
    privoxyRules.push('# Title: Blockingmachine Privoxy List');
    privoxyRules.push('# Description: Combined filter list optimized for Privoxy');
    privoxyRules.push('# Homepage: https://github.com/greigh/blockingmachine');
    privoxyRules.push('# License: BSD-3-Clause');
    privoxyRules.push('# Made by: Daniel Hipskind aka Greigh');
    privoxyRules.push('# Version: 3.0.0');
    privoxyRules.push(`# Last Updated: ${new Date().toISOString()}`);
    // privoxy header and placeholder for rules count
    privoxyRules.push('# Expires: 1 day');
    const privoxyCountIndex = privoxyRules.length;
    privoxyRules.push(`# Rules count: 0`);
    privoxyRules.push('');
    privoxyRules.push('{+block{Blockingmachine Blocklist}}');
    let privoxyCount = 0;

    lines.forEach((line) => {
      if (line.match(/^@@\|\|([^\/\^$]+)\^$/)) {
        const domain = line.replace(/^@@\|\|/, '').replace(/\^$/, '');
        if (domain) privoxyRules.push(`# EXCEPTION: @@||${domain}^`);
        return;
      }

      // Skip rules with modifiers/options
      if (line.includes('$')) return;

      if (line.match(/^\|\|([^\/\^$]+)\^$/)) {
        const domain = line.replace(/^\|\|/, '').replace(/\^$/, '');
        if (domain && !domain.includes('*') && !domain.includes('$')) {
          privoxyRules.push(`.${domain}`);
          privoxyCount++;
        }
      }
    });
    privoxyRules[privoxyCountIndex] = `# Rules count: ${privoxyCount}`;

    await fs.writeFile(path.join(databaseRoot, 'filters', 'privoxy.action'), privoxyRules.join('\n'));
    console.log('✓ Generated privoxy.action format');
    
    // Generate Shadowrocket format
    const shadowrocketRules = [];
    shadowrocketRules.push('# Title: Blockingmachine Shadowrocket List');
    shadowrocketRules.push('# Description: Combined filter list optimized for Shadowrocket');
    shadowrocketRules.push('# Homepage: https://github.com/greigh/blockingmachine');
    shadowrocketRules.push('# License: BSD-3-Clause');
    shadowrocketRules.push('# Made by: Daniel Hipskind aka Greigh');
    shadowrocketRules.push('# Version: 3.0.0');
    shadowrocketRules.push(`# Last Updated: ${new Date().toISOString()}`);
    shadowrocketRules.push('# Expires: 1 day');
    const shadowCountIndex = shadowrocketRules.length;
    shadowrocketRules.push(`# Rules count: 0`);
    shadowrocketRules.push('');
    shadowrocketRules.push('[Rule]');
    let shadowCount = 0;

    lines.forEach((line) => {
      if (line.match(/^@@\|\|([^\/\^$]+)\^$/)) {
        const domain = line.replace(/^@@\|\|/, '').replace(/\^$/, '');
        if (domain) shadowrocketRules.push(`# EXCEPTION: @@||${domain}^`);
        return;
      }

      // Skip rules with modifiers/options
      if (line.includes('$')) return;

      if (line.match(/^\|\|([^\/\^$]+)\^$/)) {
        const domain = line.replace(/^\|\|/, '').replace(/\^$/, '');
        if (domain && !domain.includes('*') && !domain.includes('$')) {
          shadowrocketRules.push(`DOMAIN-SUFFIX,${domain},REJECT`);
          shadowCount++;
        }
      }
    });
    shadowrocketRules[shadowCountIndex] = `# Rules count: ${shadowCount}`;

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
    
    // Filter out browser-specific rules, keep only DNS-compatible ones
    const dnsRules = content
      .split('\n')
      .filter(line => {
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
        
        // Remove browser-specific rules with modifiers
        return false;
      });
    
    // Count actual blocking rules (excluding metadata)
    const ruleCount = dnsRules.filter(line => 
      line.trim() && !line.startsWith('!') && !line.startsWith('#') && !line.startsWith('[')
    ).length;
    
    // Update the headers with current timestamp and DNS rule count
    const updatedDnsRules = dnsRules.map(line => {
      if (line.startsWith('! Last updated:')) {
        return `! Last updated: ${new Date().toISOString()}`;
      }
      if (line.startsWith('! Rules count:')) {
        return `! Rules count: ${ruleCount}`;
      }
      return line;
    });
    
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
