/**
 * ScheduleCard — the automation card moved out of Settings into the Home
 * compile row: the auto-compile cadence select and the post-compilation
 * webhook endpoint. Same IPC calls the Settings card made.
 */

import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ScheduleCard } from '../components/ScheduleCard';

afterEach(cleanup);

function bridge(overrides: Record<string, unknown> = {}) {
  (window as unknown as { electron: unknown }).electron = {
    getAutoSchedule: jest.fn(async () => '24h' as const),
    setAutoSchedule: jest.fn(async () => ({ success: true })),
    getWebhookUrl: jest.fn(async () => 'https://pi.hole/admin/api.php?action=restart'),
    setWebhookUrl: jest.fn(async () => ({ success: true })),
    ...overrides,
  };
}

describe('ScheduleCard', () => {
  it('renders the cadence select with the stored value and the webhook field', async () => {
    bridge();
    await act(async () => {
      render(<ScheduleCard />);
    });
    const select = screen.getByLabelText('Automatic Compilation Schedule') as HTMLSelectElement;
    expect(select.value).toBe('24h');
    expect((screen.getByPlaceholderText(/pi\.hole\/admin\/api\.php|webhook URL/) as HTMLInputElement).value).toBe(
      'https://pi.hole/admin/api.php?action=restart',
    );
  });

  it('changing the cadence calls setAutoSchedule', async () => {
    const setAutoSchedule = jest.fn<(s: string) => Promise<{ success: boolean }>>(async () => ({ success: true }));
    bridge({ setAutoSchedule });
    await act(async () => {
      render(<ScheduleCard />);
    });
    fireEvent.change(screen.getByLabelText('Automatic Compilation Schedule'), { target: { value: 'weekly' } });
    await act(async () => {});
    expect(setAutoSchedule).toHaveBeenCalledWith('weekly');
  });

  it('saving the webhook calls setWebhookUrl', async () => {
    const setWebhookUrl = jest.fn<(url: string) => Promise<{ success: boolean }>>(async () => ({ success: true }));
    bridge({ setWebhookUrl });
    await act(async () => {
      render(<ScheduleCard />);
    });
    const input = screen.getByPlaceholderText(/webhook URL/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://hook.example/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => {});
    expect(setWebhookUrl).toHaveBeenCalledWith('https://hook.example/x');
  });
});
