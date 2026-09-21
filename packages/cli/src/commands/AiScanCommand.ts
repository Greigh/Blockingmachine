import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from './BaseCommand.js';
import {
  AiDetectorService,
  type AiProviderConfig,
  type AiProviderType,
  type RawDnsQuery,
} from '@blockingmachine/core';
import chalk from 'chalk';

export interface AiScanOptions {
  target?: string;
  provider?: string;
  ollamaUrl?: string;
  model?: string;
  apiKey?: string;
  apiEndpoint?: string;
  json?: boolean;
  querylog?: 'adguard' | 'pihole';
  adguardUrl?: string;
  adguardUser?: string;
  adguardPass?: string;
  piholeUrl?: string;
  piholeToken?: string;
  limit?: number;
}

export class AiScanCommand extends BaseCommand<AiScanOptions> {
  constructor(options: CommandOptions) {
    super(options);
  }

  async execute(options: AiScanOptions): Promise<CommandResult> {
    const provider = (options.provider as AiProviderType) || 'mini-ai';
    const aiConfig: AiProviderConfig = {
      provider,
      ollamaUrl: options.ollamaUrl || 'http://127.0.0.1:11434',
      ollamaModel: options.model || 'llama3.2',
      apiKey: options.apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY,
      apiEndpoint: options.apiEndpoint,
      modelName: options.model,
    };

    const service = new AiDetectorService(aiConfig);

    // Mode A: Sinkhole Query Log Scan
    if (options.querylog) {
      return this.handleQueryLogScan(service, options, aiConfig);
    }

    // Mode B: Single Domain / URL Scan
    const target = options.target?.trim();
    if (!target) {
      return this.failure(
        'Please provide a target domain or specify --querylog [adguard|pihole].\nExample: blockingmachine ai-scan tracking.bidder.net',
      );
    }

    this.logger.info(chalk.bold.cyan(`\n🔍 AI Radar [Beta] scanning target: ${chalk.white(target)}`));
    this.logger.info(chalk.dim(`  Provider: ${provider} | Engine: ${provider === 'mini-ai' ? 'Mini-AI Embedded Classifier' : 'Local Heuristics'}`));

    try {
      const result = await service.scanDomain(target, aiConfig);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return this.success(result, 'AI scan complete');
      }

      // Visual Terminal Presentation
      console.log('\n' + chalk.bold.underline('AI Threat Assessment Report [Beta]:'));
      console.log(`  Target Domain:   ${chalk.bold.white(result.domain)}`);

      let verdictBadge = chalk.bgGreen.black(' CLEAN ');
      if (result.verdict === 'ad_server') verdictBadge = chalk.bgRed.black.bold(' 🚨 AD SERVER ');
      else if (result.verdict === 'tracker') verdictBadge = chalk.bgMagenta.black.bold(' 👁️ TRACKER ');
      else if (result.verdict === 'malicious') verdictBadge = chalk.bgRed.black.bold(' ☠️ MALICIOUS ');
      else if (result.verdict === 'suspicious') verdictBadge = chalk.bgYellow.black.bold(' ⚠️ SUSPICIOUS ');

      console.log(`  Verdict:         ${verdictBadge} (${chalk.cyan(result.verdict)})`);
      console.log(`  Confidence:      ${this.formatConfidence(result.confidence)}`);
      console.log(`  Threat Category: ${chalk.yellow(result.category)}`);
      if (result.inferenceTimeMs !== undefined) {
        console.log(`  Inference Speed: ${chalk.green(`${result.inferenceTimeMs}ms`)} ${chalk.dim('(Air-gapped in-memory)')}`);
      }
      console.log(`  Shannon Entropy: ${result.entropy} ${result.isLikelyDga ? chalk.red('(Elevated DGA score)') : chalk.dim('(Normal range)')}`);

      if (result.decomposition) {
        const d = result.decomposition;
        console.log(`  Decomposition:   ${chalk.dim(`SLD: ${chalk.white(d.sld)} | TLD: .${chalk.white(d.tld)}${d.subdomains.length > 0 ? ` | Subdomains: ${d.subdomains.join('.')}` : ''}`)}`);
      }

      if (result.cnames.length > 0) {
        console.log(`  CNAME Chain:     ${chalk.cyan(result.cnames.join(' ➔ '))}`);
      }

      if (result.resolvedIps.length > 0) {
        console.log(`  Resolved IPs:    ${chalk.dim(result.resolvedIps.join(', '))}`);
      }

      console.log(`\n  ${chalk.bold('Detection Reasons & Evidence:')}`);
      for (const r of result.reasons) {
        console.log(`    • ${chalk.dim(r)}`);
      }

      if (result.generatedRules.length > 0) {
        console.log(`\n  ${chalk.bold.green('Recommended Blocking Rules (ABP / DNS):')}`);
        for (const rule of result.generatedRules) {
          console.log(`    ${chalk.green(rule)}`);
        }
      } else {
        console.log(`\n  ${chalk.dim('No blocking rules necessary for verified clean domain.')}`);
      }
      console.log('');

      return this.success(result, `Scan completed with verdict: ${result.verdict}`);
    } catch (err: any) {
      return this.failure(`AI Scan failed: ${err?.message || err}`);
    }
  }

  private async handleQueryLogScan(
    service: AiDetectorService,
    options: AiScanOptions,
    aiConfig: AiProviderConfig,
  ): Promise<CommandResult> {
    this.logger.info(chalk.bold.cyan(`\n📡 Fetching unblocked queries from ${options.querylog?.toUpperCase()}...`));

    const queries: RawDnsQuery[] = [];

    if (options.querylog === 'adguard') {
      const baseUrl = options.adguardUrl || 'http://127.0.0.1:3000';
      const user = options.adguardUser || '';
      const pass = options.adguardPass || '';
      const limit = options.limit || 50;

      try {
        const headers: Record<string, string> = {};
        if (user || pass) {
          const auth = Buffer.from(`${user}:${pass}`).toString('base64');
          headers.Authorization = `Basic ${auth}`;
        }

        const res = await fetch(`${baseUrl}/control/querylog?limit=${limit}`, { headers });
        if (!res.ok) throw new Error(`AdGuard HTTP ${res.status}: ${res.statusText}`);

        const json: any = await res.json();
        const data = Array.isArray(json?.data) ? json.data : [];
        for (const item of data) {
          const domain = item?.question?.name;
          const isBlocked = Boolean(item?.filter_id && item.filter_id > 0);
          if (domain && !isBlocked) {
            queries.push({
              domain,
              client: item?.client,
              elapsedMs: item?.elapsed_ms,
              blocked: false,
            });
          }
        }
      } catch (err: any) {
        return this.failure(`Failed to query AdGuard Home query log: ${err?.message || err}`);
      }
    } else if (options.querylog === 'pihole') {
      const baseUrl = options.piholeUrl || 'http://127.0.0.1';
      const token = options.piholeToken || '';
      const limit = options.limit || 50;

      try {
        const res = await fetch(`${baseUrl}/admin/api.php?getAllQueries=${limit}&auth=${token}`);
        if (!res.ok) throw new Error(`Pi-hole HTTP ${res.status}: ${res.statusText}`);

        const json: any = await res.json();
        const data = Array.isArray(json?.data) ? json.data : [];
        for (const item of data) {
          // Pi-hole query log format: [timestamp, queryType, domain, client, status]
          // status 2 = OK (forwarded), 3 = OK (cached)
          const domain = item?.[2];
          const status = item?.[4];
          if (domain && (status === '2' || status === '3')) {
            queries.push({
              domain,
              client: item?.[3],
              blocked: false,
            });
          }
        }
      } catch (err: any) {
        return this.failure(`Failed to query Pi-hole query log: ${err?.message || err}`);
      }
    }

    if (queries.length === 0) {
      this.logger.info(chalk.yellow('No unblocked queries found to analyze.'));
      return this.success({ totalQueriesAnalyzed: 0, results: [] }, 'No queries to scan');
    }

    this.logger.info(chalk.dim(`Analyzing ${queries.length} unblocked queries with AI Radar...`));
    const scanResult = await service.scanQueryLog(queries, aiConfig);

    if (options.json) {
      console.log(JSON.stringify(scanResult, null, 2));
      return this.success(scanResult, 'Query log scan complete');
    }

    console.log('\n' + chalk.bold.underline(`AI Radar Query Log Analysis Summary:`));
    console.log(`  Total Analyzed:  ${scanResult.totalQueriesAnalyzed} unique domains`);
    console.log(`  Flagged Threats: ${chalk.bold.red(scanResult.flaggedCount)} potential ad servers/trackers`);
    console.log(`  Clean Services:  ${chalk.bold.green(scanResult.cleanCount)}`);

    const flagged = scanResult.results.filter((r) => r.verdict !== 'clean');
    if (flagged.length > 0) {
      console.log('\n' + chalk.bold.yellow('Flagged Suspicious Hostnames:'));
      for (const f of flagged) {
        console.log(`\n  • ${chalk.bold.white(f.domain)} [${chalk.red(f.verdict.toUpperCase())} - ${f.confidence}% conf]`);
        console.log(`    Category: ${chalk.yellow(f.category)} | Entropy: ${f.entropy}`);
        if (f.cnames.length > 0) {
          console.log(`    CNAME:    ${chalk.cyan(f.cnames.join(' ➔ '))}`);
        }
        if (f.generatedRules.length > 0) {
          console.log(`    Rule:     ${chalk.green(f.generatedRules[0])}`);
        }
      }
    } else {
      console.log(chalk.green('\n✓ All analyzed unblocked queries appear benign.'));
    }
    console.log('');

    return this.success(scanResult, 'Query log analysis finished');
  }

  private formatConfidence(confidence: number): string {
    if (confidence >= 80) return chalk.red.bold(`${confidence}% (High Certainty)`);
    if (confidence >= 50) return chalk.yellow.bold(`${confidence}% (Moderate)`);
    return chalk.dim(`${confidence}% (Low)`);
  }
}
