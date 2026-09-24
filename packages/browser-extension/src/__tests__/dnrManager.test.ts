import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { DnrManager } from '../background/dnrManager.js';

describe('DnrManager', () => {
  let mockGetDynamicRules: jest.Mock;
  let mockUpdateDynamicRules: jest.Mock;

  beforeEach(() => {
    mockGetDynamicRules = jest.fn().mockResolvedValue([{ id: 101 }]);
    mockUpdateDynamicRules = jest.fn().mockResolvedValue(undefined);

    (globalThis as any).chrome = {
      declarativeNetRequest: {
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
          condition: expect.objectContaining({
            urlFilter: '||tracker.com^'
          })
        }),
        expect.objectContaining({
          action: { type: 'block' },
          condition: expect.objectContaining({
            urlFilter: '||ads.example.com^'
          })
        }),
        expect.objectContaining({
          action: { type: 'block' },
          condition: expect.objectContaining({
            urlFilter: '||doubleclick.net^'
          })
        })
      ])
    });
  });
});
