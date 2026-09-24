import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { DnrManager } from '../background/dnrManager.js';

describe('DnrManager', () => {
  let mockGetDynamicRules: any;
  let mockUpdateDynamicRules: any;

  beforeEach(() => {
    mockGetDynamicRules = (jest.fn() as any).mockResolvedValue([{ id: 101 }]);
    mockUpdateDynamicRules = (jest.fn() as any).mockResolvedValue(undefined);

    (globalThis as any).chrome = {
      declarativeNetRequest: {
        MAX_NUMBER_OF_DYNAMIC_AND_MATCHED_RULES: 30000,
        RuleActionType: {
          BLOCK: 'block',
          ALLOW: 'allow'
        },
        ResourceType: {
          SCRIPT: 'script',
          IMAGE: 'image',
          XMLHTTPREQUEST: 'xmlhttprequest',
          SUB_FRAME: 'sub_frame',
          MEDIA: 'media',
          PING: 'ping'
        },
        getDynamicRules: mockGetDynamicRules,
        updateDynamicRules: mockUpdateDynamicRules
      }
    };
  });

  test('compiles domain rules into Chrome dynamic declarativeNetRequest rules', async () => {
    const dnr = new DnrManager();
    const rules = [
      '||tracker.com^',
      '||ads.example.com^',
      '! Comment line',
      '# Another comment',
      '   ',
      '||doubleclick.net^'
    ];

    const count = await dnr.updateDynamicRules(rules);

    expect(count).toBe(3);
    expect(mockGetDynamicRules).toHaveBeenCalledTimes(1);
    expect(mockUpdateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [101],
      addRules: expect.arrayContaining([
        expect.objectContaining({
          action: { type: 'block' },
          priority: 1,
          condition: expect.objectContaining({
            urlFilter: '||tracker.com^'
          })
        }),
        expect.objectContaining({
          action: { type: 'block' },
          priority: 1,
          condition: expect.objectContaining({
            urlFilter: '||ads.example.com^'
          })
        }),
        expect.objectContaining({
          action: { type: 'block' },
          priority: 1,
          condition: expect.objectContaining({
            urlFilter: '||doubleclick.net^'
          })
        })
      ])
    });
  });

  test('compiles exception rules (@@) with ALLOW action and higher priority', async () => {
    const dnr = new DnrManager();
    const rules = [
      '||tracker.com^',
      '@@||safe.tracker.com^',
      '||critical.com^$important',
      '@@||override.com^$important'
    ];

    const count = await dnr.updateDynamicRules(rules);
    expect(count).toBe(4);

    const callArgs = mockUpdateDynamicRules.mock.calls[0][0] as { addRules: any[] };
    const added: any[] = callArgs.addRules;

    const exceptionRule = added.find((r) => r.condition.urlFilter === '||safe.tracker.com^');
    expect(exceptionRule).toBeDefined();
    expect(exceptionRule.action.type).toBe('allow');
    expect(exceptionRule.priority).toBe(2);

    const normalBlock = added.find((r) => r.condition.urlFilter === '||tracker.com^');
    expect(normalBlock.action.type).toBe('block');
    expect(normalBlock.priority).toBe(1);

    const importantBlock = added.find((r) => r.condition.urlFilter === '||critical.com^');
    expect(importantBlock.action.type).toBe('block');
    expect(importantBlock.priority).toBe(3);

    const importantException = added.find((r) => r.condition.urlFilter === '||override.com^');
    expect(importantException.action.type).toBe('allow');
    expect(importantException.priority).toBe(4);
  });

  test('deduplicates identical patterns and ignores comments', () => {
    const dnr = new DnrManager();
    expect(dnr.parseRule('! Comment')).toBeNull();
    expect(dnr.parseRule('# Comment')).toBeNull();
    expect(dnr.parseRule('   ')).toBeNull();

    const parsed = dnr.parseRule('||doubleclick.net^$important');
    expect(parsed).toEqual({
      rawRule: '||doubleclick.net^$important',
      pattern: 'doubleclick.net',
      isException: false,
      isImportant: true,
      priority: 3
    });
  });

  test('parses hosts format and plain domains while rejecting invalid domains', () => {
    const dnr = new DnrManager();

    expect(dnr.parseRule('0.0.0.0 telemetry.ads.com')?.pattern).toBe('telemetry.ads.com');
    expect(dnr.parseRule('127.0.0.1 tracker.io')?.pattern).toBe('tracker.io');
    expect(dnr.parseRule('plain-adserver.com')?.pattern).toBe('plain-adserver.com');

    // Reject malformed domains with invalid characters
    expect(dnr.parseRule('||invalid domain.com^')).toBeNull();
    expect(dnr.parseRule('||<script>.com^')).toBeNull();
    expect(dnr.parseRule('||not-a-domain^')).toBeNull();
  });
});
