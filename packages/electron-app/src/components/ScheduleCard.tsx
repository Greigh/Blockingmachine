/**
 * ScheduleCard — the automatic-compile cadence and the post-compilation
 * webhook, moved out of Settings onto Home where the compile button lives.
 * The card body is the Settings Automation & Scheduling card verbatim:
 * same state, same IPC calls, same handlers.
 */

import React, { useEffect, useRef, useState } from 'react';

export const ScheduleCard: React.FC = () => {
  const [autoSchedule, setAutoSchedule] = useState<'disabled' | '12h' | '24h' | 'weekly'>('disabled');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookMessage, setWebhookMessage] = useState('');
  const [isSavingWebhook, setIsSavingWebhook] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    let isMounted = true;
    const timers = timersRef.current;
    if (window.electron?.getAutoSchedule) {
      window.electron.getAutoSchedule().then((schedule) => {
        if (isMounted) setAutoSchedule(schedule || 'disabled');
      }).catch(console.error);
    }
    if (window.electron?.getWebhookUrl) {
      window.electron.getWebhookUrl().then((url) => {
        if (isMounted) setWebhookUrl(url || '');
      }).catch(console.error);
    }
    return () => {
      isMounted = false;
      timers.forEach(clearTimeout);
      timersRef.current = [];
    };
  }, []);

  const safeSetTimeout = (fn: () => void, delay: number) => {
    const id = setTimeout(() => {
      timersRef.current = timersRef.current.filter((t) => t !== id);
      fn();
    }, delay);
    timersRef.current.push(id);
  };

  const handleScheduleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as 'disabled' | '12h' | '24h' | 'weekly';
    setAutoSchedule(val);
    try {
      await window.electron.setAutoSchedule(val);
    } catch (err) {
      console.error('Failed to update auto schedule:', err);
    }
  };

  const handleSaveWebhook = async () => {
    setIsSavingWebhook(true);
    try {
      await window.electron.setWebhookUrl(webhookUrl);
      setWebhookMessage('Webhook endpoint URL saved successfully.');
      safeSetTimeout(() => setWebhookMessage(''), 3000);
    } catch (err) {
      console.error('Failed to save webhook URL:', err);
      setWebhookMessage('Failed to save webhook URL.');
    } finally {
      setIsSavingWebhook(false);
    }
  };

  return (
    <div className="setting-card schedule-card" id="home-schedule">
      <div className="setting-card-header">
        <h2>
          <span className="setting-icon-svg">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </span>
          Schedule
        </h2>
        <span className="setting-badge secondary">Automation</span>
      </div>

      <div className="setting-control-group">
        <label htmlFor="autoSchedule" className="setting-label">Automatic Compilation Schedule</label>
        <div className="select-container">
          <select
            id="autoSchedule"
            className="setting-select"
            value={autoSchedule}
            onChange={handleScheduleChange}
          >
            <option value="disabled">Disabled (Manual Compilation Only)</option>
            <option value="12h">Every 12 Hours</option>
            <option value="24h">Daily (Every 24 Hours)</option>
            <option value="weekly">Weekly</option>
          </select>
        </div>
        <p className="setting-help-text">
          When enabled, Blockingmachine fetches and compiles your enabled feeds in the background and delivers a native desktop notification upon completion.
        </p>
      </div>

      <div className="setting-control-group" style={{ marginTop: '16px' }}>
        <label htmlFor="compileWebhook" className="setting-label">Post-Compilation Webhook Endpoint (Optional)</label>
        <div className="path-input-container">
          <input
            id="compileWebhook"
            type="text"
            className="path-input"
            placeholder="https://pi.hole/admin/api.php?action=restart or webhook URL"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
          />
          <button
            type="button"
            className="browse-button"
            onClick={() => void handleSaveWebhook()}
            disabled={isSavingWebhook}
          >
            {isSavingWebhook ? 'Saving…' : 'Save'}
          </button>
        </div>
        {webhookMessage && <p className="setting-message success" role="status">{webhookMessage}</p>}
        <p className="setting-help-text">
          Sends an HTTP POST payload with compilation statistics whenever blocklists are updated, allowing Pi-hole, AdGuard Home, or DNS servers to reload automatically.
        </p>
      </div>
    </div>
  );
};
