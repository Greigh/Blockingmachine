/**
 * NetworkReachStrip — Home's "and is it reaching my devices?" strip. One chip
 * per live signal: configured sinkholes with their last-reported refresh, the
 * managed DNS daemon, the browser extension's last contact, and the LAN feed.
 * Recipe targets (unbound, dnsmasq, bind, privoxy, shadowrocket, hosts) only
 * appear once a deployed agent has reported back — there is no other signal to
 * show for them. Chips carry their status as text, never colour alone.
 */

import React, { useEffect, useState } from 'react';
import type { FeedServerStatus, LiveServicesStatus, SinkholeConfig } from '../types';
import { deployRefreshFailing, type DeployRefreshReport } from '../deployRefresh';

interface NetworkReachStripProps {
  onOpenDistribute: () => void;
}

const relativeTime = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const reportText = (report: DeployRefreshReport | undefined): string | null => {
  if (!report) return null;
  // lastOkAt is never cleared, so a fresh failure hides behind stale success —
  // the shared predicate answers "did anything fail after the last good fetch".
  if (deployRefreshFailing(report)) {
    return `refresh failed ${relativeTime(report.lastFailAt!)}`;
  }
  if (report.lastOkAt) {
    return `synced ${relativeTime(report.lastOkAt)}${report.lastOkPeer ? ` · ${report.lastOkPeer}` : ''}`;
  }
  if (report.lastFailAt) {
    return `refresh failed ${relativeTime(report.lastFailAt)}`;
  }
  return null;
};

interface Chip {
  id: string;
  label: string;
  status: string;
}

export const NetworkReachStrip: React.FC<NetworkReachStripProps> = ({ onOpenDistribute }) => {
  const [chips, setChips] = useState<Chip[]>([]);

  useEffect(() => {
    let isMounted = true;

    const load = async () => {
      const [sinkhole, daemon, live, reports] = await Promise.all([
        window.electron?.getSinkholeConfig?.().catch(() => null) ?? Promise.resolve(null),
        window.electron?.getDaemonStatus?.().catch(() => null) ?? Promise.resolve(null),
        window.electron?.getLiveServices?.().catch(() => null) ?? Promise.resolve(null),
        window.electron?.getDeployRefreshReports?.().catch(() => null) ?? Promise.resolve(null),
      ]);

      if (!isMounted) return;

      const cfg = (sinkhole ?? {}) as SinkholeConfig;
      const svc = (live ?? {}) as Partial<LiveServicesStatus>;
      // The aggregate read can fail as a unit (it awaits daemon status) — fall
      // back to the dedicated endpoint before claiming the feed is down.
      let feed = svc.feed as FeedServerStatus | undefined;
      if (!feed && window.electron?.getFeedServerStatus) {
        feed = (await window.electron.getFeedServerStatus().catch(() => null)) ?? undefined;
      }
      if (!isMounted) return;
      const rep = (reports ?? {}) as Record<string, DeployRefreshReport>;
      const next: Chip[] = [];

      const daemonStatus = svc.daemon?.status ?? (daemon as { status?: string } | null)?.status;
      next.push({
        id: 'daemon',
        label: 'DNS daemon',
        status: daemonStatus ?? 'unknown',
      });

      next.push({
        id: 'feed',
        label: 'LAN feed',
        status: feed ? (feed.isRunning ? `live on :${feed.port}` : 'stopped') : 'unknown',
      });

      // The sinkholes' own API paths never emit deploy reports (only the
      // resolver recipes carry the phone-home tail), so their chips can only
      // ever say 'configured'.
      if (cfg.piholeUrl) {
        next.push({ id: 'pihole', label: 'Pi-hole', status: 'configured' });
      }
      if (cfg.adguardHomeUrl) {
        next.push({ id: 'adguard', label: 'AdGuard Home', status: 'configured' });
      }
      if (cfg.haWebhookUrl) {
        next.push({ id: 'home-assistant', label: 'Home Assistant', status: 'configured' });
      }

      const contact = svc.extension?.lastContactAt;
      if (contact) {
        next.push({ id: 'extension', label: 'Browser extension', status: `seen ${relativeTime(contact)}` });
      }

      // Recipe targets surface only through their own reports — the recipes
      // carry a phone-home tail, so a report proves a live host ran them. The
      // ids mirror DEPLOY_REFRESH_TARGETS; bind-null reports file under BIND.
      for (const [targetId, label] of [
        ['unbound', 'Unbound'],
        ['dnsmasq', 'dnsmasq'],
        ['bind', 'BIND'],
        ['privoxy', 'Privoxy'],
        ['shadowrocket', 'Shadowrocket'],
      ] as const) {
        const report = rep[targetId] ?? (targetId === 'bind' ? rep['bind-null'] : undefined);
        const text = reportText(report);
        if (text) next.push({ id: targetId, label, status: text });
      }

      setChips(next);
    };

    void load();
    // Poll on ProtectionCard's cadence — daemon/feed/contact state is live truth,
    // not a mount-time snapshot.
    const interval = setInterval(() => void load(), 10_000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="network-reach-strip" role="group" aria-label="Network reach">
      {chips.map((chip) => (
        <span key={chip.id} className="reach-chip">
          {chip.label} · {chip.status}
        </span>
      ))}
      <button type="button" className="reach-open-btn" onClick={onOpenDistribute}>
        Open Distribute →
      </button>
    </div>
  );
};
