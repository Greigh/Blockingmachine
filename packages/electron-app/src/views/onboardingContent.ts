import type { FilterFormat } from '../types/';

export interface OnboardingStep {
  id: number;
  label: string;
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  { id: 1, label: 'Welcome' },
  { id: 2, label: 'Protection' },
  { id: 3, label: 'Setup' },
  { id: 4, label: 'Personalize' },
  { id: 5, label: 'Launch' },
];

export type OnboardingIcon =
  | 'suite'
  | 'inspector'
  | 'radar'
  | 'quarantine'
  | 'deploy'
  | 'export';

export interface OnboardingHighlight {
  icon: OnboardingIcon;
  title: string;
  body: string;
}

export const ONBOARDING_HIGHLIGHTS: OnboardingHighlight[] = [
  {
    icon: 'suite',
    title: 'Defense Suite',
    body: 'Eight first-party modules for ads, privacy, Smart TV and IoT, cookie banners, social trackers, threats, URL parameters, and safe exceptions.',
  },
  {
    icon: 'inspector',
    title: 'Unified Inspector',
    body: 'Test a domain against compiled rules, allowlists, and conflicts before the list leaves this machine.',
  },
  {
    icon: 'radar',
    title: 'AI Radar',
    body: 'Mini-AI classifies domains on-device. Scan a host, a page, or a DNS query log without sending it anywhere.',
  },
  {
    icon: 'quarantine',
    title: 'Threat Quarantine',
    body: 'AI Sentinel Watchdog scouts sinkhole logs on a timer and parks suspicious domains until you block or allow them.',
  },
  {
    icon: 'deploy',
    title: 'Deploy & Sync',
    body: 'Push a compiled list to Pi-hole, AdGuard Home, Home Assistant, or a LAN feed, and reload after each compile.',
  },
  {
    icon: 'export',
    title: 'One compile, many formats',
    body: 'Deduplicate overlapping rules, keep exception bypasses, and write AdGuard, hosts, dnsmasq, and plain domain lists together.',
  },
];

export type DeployTargetId = 'adguard' | 'pihole' | 'lan' | 'later';

export interface DeploySetupOption {
  id: DeployTargetId;
  name: string;
  detail: string;
  format: FilterFormat | null;
}

export const DEPLOY_SETUP_OPTIONS: DeploySetupOption[] = [
  {
    id: 'adguard',
    name: 'AdGuard Home',
    detail: 'Direct API, Home Assistant, or a webhook. Primary file is adguard.txt. Add the address in Deploy & Sync.',
    format: 'adguard',
  },
  {
    id: 'pihole',
    name: 'Pi-hole',
    detail: 'Compile a hosts list, then trigger Gravity once the Pi-hole URL and token are saved.',
    format: 'hosts',
  },
  {
    id: 'lan',
    name: 'LAN feed',
    detail: 'Serve the compiled file on your network for routers and other blockers. Turn the feed on in Deploy & Sync.',
    format: null,
  },
  {
    id: 'later',
    name: 'Set up later',
    detail: 'Skip sinkhole setup for now. Deploy & Sync stays in the sidebar when you have an address.',
    format: null,
  },
];

export type AiSetupChoice = 'mini-ai' | 'later';

export interface AiSetupOption {
  id: AiSetupChoice;
  name: string;
  detail: string;
}

export const AI_SETUP_OPTIONS: AiSetupOption[] = [
  {
    id: 'mini-ai',
    name: 'On-device Mini-AI',
    detail: 'Classify domains on this machine. AI Radar can scan logs, run the watchdog, and review quarantine afterward.',
  },
  {
    id: 'later',
    name: 'Decide later',
    detail: 'Leave provider settings as they are. Inspector, AI Radar, and Threat Quarantine remain available.',
  },
];

export function deployTargetLabel(id: DeployTargetId | undefined): string {
  return DEPLOY_SETUP_OPTIONS.find((option) => option.id === id)?.name || 'Not chosen';
}

export function aiSetupLabel(id: AiSetupChoice | undefined): string {
  return AI_SETUP_OPTIONS.find((option) => option.id === id)?.name || 'Not chosen';
}
