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
import type { DeployRefreshReport } from '../deployRefresh';

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
      const feed = svc.feed as FeedServerStatus | undefined;
      const rep = (reports ?? {}) as Record<string, DeployRefreshReport>;
      const next: Chip[] = [];

      const daemonStatus = svc.daemon?.status ?? (daemon as { status?: string } | null)?.status;
      next.push({
        id: 'daemon',
        label: 'DNS daemon',
        status: daemonStatus ?? 'unknown',
      });

      if (feed?.isRunning) {
        next.push({ id: 'feed', label: 'LAN feed', status: `live on :${feed.port}` });
      } else {
        next.push({ id: 'feed', label: 'LAN feed', status: 'stopped' });
      }

      if (cfg.piholeUrl) {
        next.push({ id: 'pihole', label: 'Pi-hole', status: reportText(rep.pihole) ?? 'configured' });
      }
      if (cfg.adguardHomeUrl) {
        next.push({
          id: 'adguard',
          label: 'AdGuard Home',
          status: reportText(rep['adguard-home']) ?? 'configured',
        });
      }
      if (cfg.haWebhookUrl) {
        next.push({
          id: 'home-assistant',
          label: 'Home Assistant',
          status: reportText(rep['home-assistant']) ?? 'configured',
        });
      }

      const contact = svc.extension?.lastContactAt;
      if (contact) {
        next.push({ id: 'extension', label: 'Browser extension', status: `seen ${relativeTime(contact)}` });
      }

      // Recipe targets surface only through their own reports — the recipes
      // carry a phone-home tail, so a report proves a live host ran them.
      for (const [targetId, label] of [
        ['unbound', 'Unbound'],
        ['dnsmasq', 'dnsmasq'],
        ['bind', 'BIND'],
        ['privoxy', 'Privoxy'],
        ['shadowrocket', 'Shadowrocket'],
        ['hosts', 'Hosts file'],
      ] as const) {
        const text = reportText(rep[targetId]);
        if (text) next.push({ id: targetId, label, status: text });
      }

      setChips(next);
    };

    void load();
    return () => {
      isMounted = false;
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
