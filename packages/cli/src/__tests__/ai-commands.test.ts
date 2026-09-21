import { jest } from '@jest/globals';
import { AiScanCommand } from '../commands/AiScanCommand.js';
import { AiCrawlCommand } from '../commands/AiCrawlCommand.js';

describe('CLI AI Radar Commands', () => {
  let mockLogger: any;
  let mockConfig: any;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    mockConfig = {
      baseDir: process.cwd(),
      sources: [],
    };
  });

  describe('AiScanCommand', () => {
    it('returns failure when target or querylog is not specified', async () => {
      const cmd = new AiScanCommand({ config: mockConfig, logger: mockLogger });
      const result = await cmd.execute({});
      expect(result.success).toBe(false);
      expect(result.message).toContain('Please provide a target domain');
    });

    it('successfully scans an ad server domain and generates rules', async () => {
      const cmd = new AiScanCommand({ config: mockConfig, logger: mockLogger });
      const result = await cmd.execute({
        target: 'doubleclick.net',
        provider: 'local-heuristics',
      });

      expect(result.success).toBe(true);
      expect(result.data.domain).toBe('doubleclick.net');
      expect(result.data.verdict).toBe('ad_server');
      expect(result.data.generatedRules).toContain('||doubleclick.net^');
    });

    it('successfully scans a clean mainstream domain', async () => {
      const cmd = new AiScanCommand({ config: mockConfig, logger: mockLogger });
      const result = await cmd.execute({
        target: 'wikipedia.org',
        provider: 'local-heuristics',
      });

      expect(result.success).toBe(true);
      expect(result.data.verdict).toBe('clean');
      expect(result.data.generatedRules).toEqual([]);
    });
  });

  describe('AiCrawlCommand', () => {
    it('returns failure when url is not provided', async () => {
      const cmd = new AiCrawlCommand({ config: mockConfig, logger: mockLogger });
      const result = await cmd.execute({ url: '' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Please specify a web URL');
    });

    it('rejects SSRF attacks targeting loopback or metadata endpoints', async () => {
      const cmd = new AiCrawlCommand({ config: mockConfig, logger: mockLogger });
      const result = await cmd.execute({
        url: 'http://127.0.0.1:59999/test-non-existent-page',
        provider: 'local-heuristics',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('SSRF Guard blocked crawl request');
    });

    it('crawls public url and handles non-existent pages gracefully without crashing', async () => {
      const cmd = new AiCrawlCommand({ config: mockConfig, logger: mockLogger });
      const result = await cmd.execute({
        url: 'https://non-existent-crawl-domain-testing-12345.org',
        provider: 'local-heuristics',
      });

      expect(result.success).toBe(true);
      expect(result.data.extractedHosts).toEqual([]);
    });
  });
});
