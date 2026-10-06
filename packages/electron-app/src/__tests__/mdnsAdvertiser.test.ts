import { describe, expect, it } from '@jest/globals';
import { advertiseTxt, advertiseFeedServer } from '../mdnsAdvertiser';

describe('advertiseTxt', () => {
  it('advertises api v1, the version, and an explicit token state', () => {
    expect(advertiseTxt({ version: '1.0.0-rc.9', tokenRequired: true })).toEqual({
      api: 'v1',
      version: '1.0.0-rc.9',
      token: 'required',
    });
    expect(advertiseTxt({ version: '1.0.0-rc.9', tokenRequired: false })).toEqual({
      api: 'v1',
      version: '1.0.0-rc.9',
      token: 'open',
    });
  });
});

describe('advertiseFeedServer', () => {
  it('never throws and returns a stoppable handle even without multicast', () => {
    // jest has no bonjour wiring; load may succeed (dep is installed) but publish on a
    // port-less environment must still return a handle rather than throw.
    const handle = advertiseFeedServer({ port: 9191, version: 'test', tokenRequired: false });
    expect(typeof handle.stop).toBe('function');
    expect(() => handle.stop()).not.toThrow();
    expect(() => handle.stop()).not.toThrow(); // idempotent
  });
});
