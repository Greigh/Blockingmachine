import { describe, it, expect } from '@jest/globals';

/**
 * Mirrors the normalization logic in the `set-radar-display-config` IPC handler
 * (packages/electron-app/src/index.ts) so regressions in validation semantics
 * surface in tests. Keep in sync with the handler.
 */
function normalizeRadarDisplayConfig(
  current: { showIgnoredOffenders?: boolean } | undefined,
  incoming: { showIgnoredOffenders?: boolean } | null | undefined,
): { showIgnoredOffenders: boolean } {
  if (!incoming || typeof incoming !== 'object') {
    throw new Error('Invalid config parameter');
  }
  const base = current || { showIgnoredOffenders: false };
  return {
    showIgnoredOffenders:
      typeof incoming.showIgnoredOffenders === 'boolean'
        ? incoming.showIgnoredOffenders
        : Boolean(base.showIgnoredOffenders),
  };
}

describe('Radar display config normalization', () => {
  it('defaults to hidden when nothing is saved', () => {
    expect(normalizeRadarDisplayConfig(undefined, { showIgnoredOffenders: false })).toEqual({
      showIgnoredOffenders: false,
    });
  });

  it('applies a boolean toggle directly', () => {
    expect(normalizeRadarDisplayConfig({ showIgnoredOffenders: false }, { showIgnoredOffenders: true })).toEqual({
      showIgnoredOffenders: true,
    });
    expect(normalizeRadarDisplayConfig({ showIgnoredOffenders: true }, { showIgnoredOffenders: false })).toEqual({
      showIgnoredOffenders: false,
    });
  });

  it('keeps the saved value when the incoming field is not a boolean', () => {
    expect(
      normalizeRadarDisplayConfig({ showIgnoredOffenders: true }, { showIgnoredOffenders: 'yes' as unknown as boolean }),
    ).toEqual({ showIgnoredOffenders: true });
    expect(normalizeRadarDisplayConfig({ showIgnoredOffenders: true }, {})).toEqual({ showIgnoredOffenders: true });
  });

  it('falls back to the default for missing saved config', () => {
    expect(normalizeRadarDisplayConfig(undefined, {})).toEqual({ showIgnoredOffenders: false });
  });

  it('rejects non-object payloads', () => {
    expect(() => normalizeRadarDisplayConfig(undefined, null)).toThrow(/Invalid config parameter/);
    expect(() => normalizeRadarDisplayConfig({ showIgnoredOffenders: true }, 'show' as unknown as object)).toThrow(
      /Invalid config parameter/,
    );
  });
});
