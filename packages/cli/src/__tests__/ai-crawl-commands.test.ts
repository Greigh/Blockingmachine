/**
 * AiCrawlCommand's crawl path — split into its own file because it needs
 * `jest.unstable_mockModule` before the command (and its transitively-shared
 * AiDetectorService) binds `node-fetch`. Static imports resolve at module
 * link time, before a same-file mock can register; here the command import is
 * dynamic, so the resolver-pinned fetch is the mock, not the network.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';

jest.unstable_mockModule('node-fetch', () => ({
  __esModule: true,
  default: jest.fn(),
}));
const nodeFetchMock = (await import('node-fetch')).default as unknown as jest.MockedFunction<typeof fetch>;
const { AiCrawlCommand } = await import('../commands/AiCrawlCommand.js');

describe('CLI AI Radar Commands — AiCrawlCommand (node-fetch mocked)', () => {
  let mockLogger: any;
  let mockConfig: any;

  beforeEach(() => {
    nodeFetchMock.mockReset();
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    mockConfig = { baseDir: process.cwd(), sources: [] };
  });

  it('crawls public url and handles non-existent pages gracefully without crashing', async () => {
      nodeFetchMock
        .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND non-existent-crawl-domain-testing-12345.org'));

      const cmd = new AiCrawlCommand({ config: mockConfig, logger: mockLogger });
      const result = await cmd.execute({
        url: 'https://non-existent-crawl-domain-testing-12345.org',
        provider: 'local-heuristics',
      });

      expect(result.success).toBe(true);
      expect(result.data.extractedHosts).toEqual([]);
    });

  it('crawls HTML and extracts discovered third-party script and iframe hosts', async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <script src="https://adservice.google.com/ads.js"></script>
            <script src="https://telemetry.tracker.io/beacon.js"></script>
          </head>
          <body>
            <iframe src="https://cdn.example.org/embed"></iframe>
          </body>
        </html>
      `;
      // node-fetch bodies are Node streams — `Readable.from` satisfies the
      // `for await` loop the extractor reads with.
      nodeFetchMock.mockResolvedValueOnce({
        ok: true,
        url: 'https://example-site.com',
        body: Readable.from([Buffer.from(mockHtml)]),
      } as any);

      const cmd = new AiCrawlCommand({ config: mockConfig, logger: mockLogger });
      const result = await cmd.execute({
        url: 'https://example-site.com',
        provider: 'local-heuristics',
      });

      expect(result.success).toBe(true);
      expect(result.data.extractedHosts).toContain('adservice.google.com');
      expect(result.data.extractedHosts).toContain('telemetry.tracker.io');
    });
});
