import { describe, test, expect } from '@jest/globals';
import {
  buildTrayMenu,
  buildTrayTooltip,
  findTrayAction,
  emptyTrayState,
  TrayEpoch,
  type TrayMenuRow,
  type TraySharedState,
} from '../trayMenu';

function state(overrides: Partial<TraySharedState> = {}): TraySharedState {
  return { ...emptyTrayState(), ...overrides };
}

/** Every non-separator label, in order. */
function labels(rows: TrayMenuRow[]): string[] {
  return rows
    .filter((row) => row.type !== 'separator')
    .map((row) => row.label);
}

function statusLabels(rows: TrayMenuRow[]): string[] {
  return rows.filter((row) => row.type === 'status').map((row) => row.label);
}

describe('buildTrayMenu', () => {
  test('idle with no daemon shows the not-running header and no protection toggle', () => {
    const rows = buildTrayMenu(state(), false);

    expect(statusLabels(rows)[0]).toBe('Protection: Daemon not running');
    expect(findTrayAction(rows, 'toggle-protection')).toBeUndefined();
    expect(labels(rows)).toContain('DNS Protection: Not Running');
  });

  test('summarizes the last compilation with count and time', () => {
    const rows = buildTrayMenu(
      state({ lastRuleCount: 1234, lastProcessTime: '2026-09-29 10:00' }),
      false,
    );

    expect(statusLabels(rows)).toContain('1,234 rules • updated 2026-09-29 10:00');
  });

  test('omits the detail line entirely when there is nothing to report', () => {
    const rows = buildTrayMenu(state(), false);

    expect(statusLabels(rows).filter((l) => /rules|updated/.test(l))).toEqual([]);
    expect(statusLabels(rows)).toEqual([
      'Protection: Daemon not running',
      'DNS Protection: Not Running',
      'LAN Feed: Offline',
    ]);
  });

  test('shows partial detail when only one of count/time is known', () => {
    const onlyCount = buildTrayMenu(state({ lastRuleCount: 7 }), false);
    expect(statusLabels(onlyCount)).toContain('7 rules');

    const onlyTime = buildTrayMenu(
      state({ lastProcessTime: 'just now' }),
      false,
    );
    expect(statusLabels(onlyTime)).toContain('updated just now');
  });

  test('while compiling the header, row and tooltip all report progress', () => {
    const rows = buildTrayMenu(
      state({
        lastRuleCount: 500,
        compileProgress: { status: 'Fetching sources', percent: 42 },
      }),
      true,
    );

    expect(statusLabels(rows)[0]).toBe('Compiling… 42%');
    expect(statusLabels(rows)).toContain('⏳ Fetching sources (42%)');

    const compile = findTrayAction(rows, 'compile');
    expect(compile?.label).toBe('Compiling… (working)');
    expect(compile?.enabled).toBe(false);

    expect(
      buildTrayTooltip(
        state({ compileProgress: { status: 'Fetching sources', percent: 42 } }),
        true,
      ),
    ).toBe('Blockingmachine\nCompiling… 42%');
  });

  test('compile row is enabled and inert-labelled when idle', () => {
    const compile = findTrayAction(buildTrayMenu(state(), false), 'compile');

    expect(compile?.label).toBe('Compile & Update Rules Now');
    expect(compile?.enabled).toBe(true);
  });

  test('compiling without a percent falls back to 0%', () => {
    const rows = buildTrayMenu(state(), true);

    expect(statusLabels(rows)[0]).toBe('Compiling… 0%');
  });

  test('an active protection state offers to pause it', () => {
    const rows = buildTrayMenu(
      state({ protection: { enabled: true, status: 'running' } }),
      false,
    );

    expect(statusLabels(rows)[0]).toBe('Protection: Active');
    const toggle = findTrayAction(rows, 'toggle-protection');
    expect(toggle?.label).toBe('Pause DNS Protection');
    expect(toggle?.protectionEnabled).toBe(false);
    expect(buildTrayTooltip(state({ protection: { enabled: true, status: 'running' } }), false)).toBe(
      'Blockingmachine\nDNS protection active',
    );
  });

  test('a paused protection state offers to resume it', () => {
    const rows = buildTrayMenu(
      state({ protection: { enabled: false, status: 'paused' } }),
      false,
    );

    expect(statusLabels(rows)[0]).toBe('Protection: Paused');
    const toggle = findTrayAction(rows, 'toggle-protection');
    expect(toggle?.label).toBe('Resume DNS Protection');
    expect(toggle?.protectionEnabled).toBe(true);
    expect(
      buildTrayTooltip(state({ protection: { enabled: false, status: 'paused' } }), false),
    ).toBe('Blockingmachine\nDNS protection paused');
  });

  test('a running-but-disabled daemon is treated as paused', () => {
    const rows = buildTrayMenu(
      state({ protection: { enabled: false, status: 'running' } }),
      false,
    );

    expect(statusLabels(rows)[0]).toBe('Protection: Paused');
    expect(findTrayAction(rows, 'toggle-protection')?.protectionEnabled).toBe(true);
  });

  test('a stopped daemon exposes no protection toggle', () => {
    const rows = buildTrayMenu(
      state({ protection: { enabled: false, status: 'stopped' } }),
      false,
    );

    expect(findTrayAction(rows, 'toggle-protection')).toBeUndefined();
    expect(labels(rows)).toContain('DNS Protection: Not Running');
  });

  test('feed server status is shown when running and when offline', () => {
    const running = buildTrayMenu(
      state({ feedServer: { isRunning: true, lanUrl: 'http://192.168.1.5:9191' } }),
      false,
    );
    expect(statusLabels(running)).toContain('LAN Feed: http://192.168.1.5:9191');

    const offline = buildTrayMenu(
      state({ feedServer: { isRunning: false, lanUrl: 'http://192.168.1.5:9191' } }),
      false,
    );
    expect(statusLabels(offline)).toContain('LAN Feed: Offline');
  });

  test('every action id appears exactly once with a label and enabled flag', () => {
    const rows = buildTrayMenu(
      state({ protection: { enabled: true, status: 'running' } }),
      false,
    );
    const actions = rows.filter((row) => row.type === 'action');

    const ids = actions.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      [
        'compile',
        'flush-dns',
        'open',
        'open-deploy',
        'open-settings',
        'quit',
        'reveal-output',
        'toggle-protection',
      ].sort(),
    );
    for (const action of actions) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(typeof action.enabled).toBe('boolean');
    }
  });

  test('status rows are non-interactive and carry no action id', () => {
    const rows = buildTrayMenu(state(), false);
    for (const row of rows) {
      if (row.type === 'status' || row.type === 'separator') {
        expect('id' in row).toBe(false);
      }
    }
  });

  test('keeps the expected accelerators and separator structure', () => {
    const rows = buildTrayMenu(state(), false);

    expect(findTrayAction(rows, 'open-settings')?.accelerator).toBe('Cmd+,');
    expect(findTrayAction(rows, 'quit')?.accelerator).toBe('Cmd+Q');
    expect(findTrayAction(rows, 'open')?.accelerator).toBeUndefined();

    // Sections: header/details, core actions, protection, LAN, files, session.
    const separators = rows.filter((row) => row.type === 'separator').length;
    expect(separators).toBe(5);
  });

  test('the quit row is last and the open row is first among actions', () => {
    const rows = buildTrayMenu(state(), false);
    const last = rows[rows.length - 1];
    expect(last.type === 'action' && last.id === 'quit').toBe(true);

    const firstAction = rows.find((row) => row.type === 'action');
    expect(firstAction && firstAction.type === 'action' && firstAction.id === 'open').toBe(true);
  });
});

describe('buildTrayTooltip', () => {
  test('reports rule count when idle', () => {
    expect(buildTrayTooltip(state({ lastRuleCount: 4200 }), false)).toBe(
      'Blockingmachine\n4,200 rules active',
    );
  });

  test('is just the title when there is nothing to say', () => {
    expect(buildTrayTooltip(state(), false)).toBe('Blockingmachine');
  });

  test('compiling takes precedence over the rule count', () => {
    expect(
      buildTrayTooltip(
        state({
          lastRuleCount: 4200,
          compileProgress: { status: 'Working', percent: 10 },
        }),
        true,
      ),
    ).toBe('Blockingmachine\nCompiling… 10%');
  });
});

describe('findTrayAction', () => {
  test('returns undefined for an action that is not present', () => {
    const rows = buildTrayMenu(state(), false);
    expect(findTrayAction(rows, 'toggle-protection')).toBeUndefined();
  });
});

describe('TrayEpoch', () => {
  test('starts at zero with no rebuild yet', () => {
    expect(new TrayEpoch().value).toBe(0);
  });

  test('a bump makes the previous stamp stale', () => {
    const epoch = new TrayEpoch();
    const first = epoch.bump();
    expect(epoch.isCurrent(first)).toBe(true);

    const second = epoch.bump();
    expect(epoch.isCurrent(second)).toBe(true);
    expect(epoch.isCurrent(first)).toBe(false);
  });

  test('bumps are strictly increasing', () => {
    const epoch = new TrayEpoch();
    expect(epoch.bump()).toBe(1);
    expect(epoch.bump()).toBe(2);
    expect(epoch.bump()).toBe(3);
  });
});
