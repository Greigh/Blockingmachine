import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from './BaseCommand.js';
import {
  AiDetectorService,
  type AiProviderConfig,
  type AiProviderType,
} from '@blockingmachine/core';
import chalk from 'chalk';

export interface AiCrawlOptions {
  url: string;
  provider?: string;
  ollamaUrl?: string;
  model?: string;
  apiKey?: string;
  json?: boolean;
}

export class AiCrawlCommand extends BaseCommand<AiCrawlOptions> {
  constructor(options: CommandOptions) {
    super(options);
  }

  async execute(options: AiCrawlOptions): Promise<CommandResult> {
    const rawUrl = options.url?.trim();
    if (!rawUrl) {
      return this.failure('Please specify a web URL to crawl.\nExample: blockingmachine ai-crawl https://example-news.com');
    }

    const provider = (options.provider as AiProviderType) || 'mini-ai';
    const aiConfig: AiProviderConfig = {
      provider,
      ollamaUrl: options.ollamaUrl || 'http://127.0.0.1:11434',
      ollamaModel: options.model || 'llama3.2',
      apiKey: options.apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY,
    };

    const service = new AiDetectorService(aiConfig);

    this.logger.info(chalk.bold.cyan(`\n🕷️ Web Canary Crawler [Beta] visiting: ${chalk.white(rawUrl)}`));
    this.logger.info(chalk.dim('Extracting third-party scripts, iframes, and tracking endpoints...'));

    try {
      const crawlResult = await service.crawlAndScanUrl(rawUrl, aiConfig);

      if (options.json) {
        console.log(JSON.stringify(crawlResult, null, 2));
        return this.success(crawlResult, 'Crawl complete');
      }

      console.log('\n' + chalk.bold.underline('Canary Crawl Analysis Report [Beta]:'));
      console.log(`  Scanned URL:         ${chalk.white(crawlResult.url)}`);
      console.log(`  Discovered Hosts:    ${crawlResult.extractedHosts.length} external origins`);
      console.log(`  Flagged Ad/Trackers: ${chalk.bold.red(crawlResult.flaggedHosts.length)}`);

      if (crawlResult.flaggedHosts.length > 0) {
        console.log('\n' + chalk.bold.red('Detected Advertising & Tracking Infrastructure:'));
        for (const host of crawlResult.flaggedHosts) {
          console.log(`\n  • ${chalk.bold.white(host.domain)} [${chalk.red(host.verdict.toUpperCase())}]`);
          console.log(`    Category: ${chalk.yellow(host.category)} | Confidence: ${host.confidence}%`);
          for (const reason of host.reasons.slice(0, 2)) {
            console.log(`    - ${chalk.dim(reason)}`);
          }
        }

        console.log('\n' + chalk.bold.green('Generated Filter Rules for Site:'));
        for (const rule of crawlResult.synthesizedRules.slice(0, 15)) {
          console.log(`  ${chalk.green(rule)}`);
        }
      } else {
        console.log(chalk.green('\n✓ No overt third-party ad injection or tracking servers detected on page.'));
      }
      console.log('');

      return this.success(crawlResult, `Crawl finished with ${crawlResult.flaggedHosts.length} flagged hosts`);
    } catch (err: any) {
      return this.failure(`Canary crawl failed: ${err?.message || err}`);
    }
  }
}
