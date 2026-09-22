import React, { useState, useEffect } from 'react';
import type { FilterFormat, FilterSource } from '../types/';
import { PRESET_BUNDLES, type PresetBundle } from './PresetsModal';
import { ACCENT_PALETTE, applyAccentColor } from '../theme';
import { BrandLogo } from '../components/BrandLogo';
import {
  AI_SETUP_OPTIONS,
  DEPLOY_SETUP_OPTIONS,
  ONBOARDING_HIGHLIGHTS,
  ONBOARDING_STEPS,
  aiSetupLabel,
  deployTargetLabel,
  type AiSetupChoice,
  type DeployTargetId,
  type OnboardingIcon,
} from './onboardingContent';

export interface OnboardingConfig {
  selectedBundleId?: string;
  exportFormat: FilterFormat;
  accentColor: string;
  shouldCompileImmediately: boolean;
  deployTarget?: DeployTargetId;
  aiSetup?: AiSetupChoice;
}

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentSources: FilterSource[];
  onComplete: (config: OnboardingConfig) => void;
}

const FORMAT_OPTIONS: Array<{
  id: FilterFormat;
  name: string;
  target: string;
  badge: string;
}> = [
  {
    id: 'adguard',
    name: 'AdGuard Home',
    target: 'adguard.txt',
    badge: 'Popular',
  },
  {
    id: 'hosts',
    name: 'Pi-hole / Standard Hosts',
    target: 'hosts.txt',
    badge: 'Standard',
  },
  {
    id: 'dnsmasq',
    name: 'Dnsmasq Server',
    target: 'dnsmasq.conf',
    badge: 'Advanced',
  },
  {
    id: 'domains',
    name: 'Plain Domain List',
    target: 'domains.txt',
    badge: 'Simple',
  },
];

const OnboardingHighlightIcon: React.FC<{ name: OnboardingIcon }> = ({ name }) => {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  if (name === 'suite') {
    return (
      <svg {...common}>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    );
  }
  if (name === 'inspector') {
    return (
      <svg {...common}>
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </svg>
    );
  }
  if (name === 'radar') {
    return (
      <svg {...common}>
        <path d="M4 11a9 9 0 0 1 9 9" />
        <path d="M4 4a16 16 0 0 1 16 16" />
        <circle cx="5" cy="19" r="1" />
      </svg>
    );
  }
  if (name === 'quarantine') {
    return (
      <svg {...common}>
        <path d="M12 3l7 3v5c0 4.5-2.8 7.6-7 9-4.2-1.4-7-4.5-7-9V6l7-3z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    );
  }
  if (name === 'deploy') {
    return (
      <svg {...common}>
        <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
        <path d="M12 3v12" />
        <path d="M8 11l4 4 4-4" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
};

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  isOpen,
  onClose,
  currentSources: _currentSources,
  onComplete,
}) => {
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [selectedBundleId, setSelectedBundleId] = useState<string>('essential');
  const [exportFormat, setExportFormat] = useState<FilterFormat>('adguard');
  const [accentColor, setAccentColor] = useState<string>(() => {
    try {
      return localStorage.getItem('bm-accent-color') || 'blue';
    } catch {
      return 'blue';
    }
  });
  const [shouldCompileImmediately, setShouldCompileImmediately] = useState<boolean>(true);
  const [deployTarget, setDeployTarget] = useState<DeployTargetId>('adguard');
  const [aiSetup, setAiSetup] = useState<AiSetupChoice>('mini-ai');

  // Sync format from store on mount and align the deploy choice with it.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.electron?.getExportFormat) {
      window.electron.getExportFormat().then((fmt) => {
        if (!fmt) return;
        setExportFormat(fmt);
        if (fmt === 'hosts') setDeployTarget('pihole');
        else if (fmt === 'adguard') setDeployTarget('adguard');
        else setDeployTarget('lan');
      });
    }
  }, []);

  const dialogRef = React.useRef<HTMLDivElement>(null);

  // Focus trap inside the modal dialog & keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    // Auto-focus primary action or first interactive element on open/step-change
    const focusTimer = setTimeout(() => {
      if (dialogRef.current) {
        const nextBtn = dialogRef.current.querySelector<HTMLElement>(
          '.onboarding-next-btn, .onboarding-finish-btn'
        );
        if (nextBtn) {
          nextBtn.focus();
        } else {
          const firstFocusable = dialogRef.current.querySelector<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          );
          if (firstFocusable) {
            firstFocusable.focus();
          }
        }
      }
    }, 40);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleSkip();
        return;
      }

      // Intercept Tab to trap focus strictly inside the dialog
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => el.offsetParent !== null); // Only visible elements

        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }

        const firstEl = focusables[0];
        const lastEl = focusables[focusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstEl || !dialogRef.current.contains(document.activeElement)) {
            e.preventDefault();
            lastEl.focus();
          }
        } else {
          if (document.activeElement === lastEl || !dialogRef.current.contains(document.activeElement)) {
            e.preventDefault();
            firstEl.focus();
          }
        }
        return;
      }

      if (e.key === 'Enter' && currentStep < ONBOARDING_STEPS.length) {
        const target = e.target as HTMLElement | null;
        // Do not intercept enter on buttons/inputs that have their own action
        if (target && (target.tagName === 'BUTTON' || target.tagName === 'INPUT')) {
          return;
        }
        setCurrentStep((prev) => prev + 1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, currentStep]);

  if (!isOpen) return null;

  const handleAccentPick = (id: string) => {
    setAccentColor(id);
    applyAccentColor(id);
  };

  const handleDeployPick = (id: DeployTargetId) => {
    setDeployTarget(id);
    const suggested = DEPLOY_SETUP_OPTIONS.find((option) => option.id === id)?.format;
    if (suggested) setExportFormat(suggested);
  };

  const handleFinish = () => {
    onComplete({
      selectedBundleId: selectedBundleId === 'current' ? undefined : selectedBundleId,
      exportFormat,
      accentColor,
      shouldCompileImmediately,
      deployTarget,
      aiSetup,
    });
    onClose();
  };

  const handleSkip = () => {
    onComplete({
      exportFormat,
      accentColor,
      shouldCompileImmediately: false,
    });
    onClose();
  };

  const totalSteps = ONBOARDING_STEPS.length;
  const selectedBundleName =
    selectedBundleId === 'current'
      ? 'Custom / Default Feeds'
      : PRESET_BUNDLES.find((b) => b.id === selectedBundleId)?.name || 'Standard';

  return (
    <div className="modal-overlay onboarding-overlay" onClick={handleSkip}>
      <div
        ref={dialogRef}
        className="modal-dialog onboarding-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Top Header & Step Progress Bar */}
        <div className="onboarding-header">
          <div className="onboarding-stepper">
            {ONBOARDING_STEPS.map((step) => (
              <div
                key={step.id}
                className={`onboarding-step-pill ${
                  currentStep === step.id
                    ? 'active'
                    : currentStep > step.id
                      ? 'completed'
                      : ''
                }`}
                onClick={() => setCurrentStep(step.id)}
              >
                <span className="step-number">{currentStep > step.id ? '✓' : step.id}</span>
                <span className="step-label">{step.label}</span>
              </div>
            ))}
          </div>
          <button
            className="onboarding-skip-btn"
            onClick={handleSkip}
            title="Skip onboarding tour"
          >
            Skip Tour
          </button>
        </div>

        {/* Step Content */}
        <div className="onboarding-body">
          {/* STEP 1: Welcome & Engine Highlights */}
          {currentStep === 1 && (
            <div className="onboarding-step-panel step-welcome">
              <div className="onboarding-hero">
                <div className="onboarding-badge-icon">
                  <BrandLogo size={46} glow />
                </div>
                <h2 className="onboarding-title">Welcome to Blockingmachine</h2>
                <p className="onboarding-desc">
                  Compile blocklists, turn on Defense Suite modules, and use on-device AI
                  to inspect threats before you deploy them to your network.
                </p>
              </div>

              <div className="onboarding-highlights-grid">
                {ONBOARDING_HIGHLIGHTS.map((highlight) => (
                  <div className="onboarding-highlight-card" key={highlight.title}>
                    <div className="highlight-icon-box" aria-hidden="true">
                      <OnboardingHighlightIcon name={highlight.icon} />
                    </div>
                    <h4>{highlight.title}</h4>
                    <p>{highlight.body}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP 2: Choose Starter Protection Pack */}
          {currentStep === 2 && (
            <div className="onboarding-step-panel step-protection">
              <div className="onboarding-step-intro">
                <h3 className="step-title">Choose Your Initial Defense Profile</h3>
                <p className="step-subtitle">
                  Select a starter pack to automatically curate your initial feed subscriptions.
                  You can fine-tune or add custom feeds at any time.
                </p>
              </div>

              <div className="onboarding-packs-grid">
                {PRESET_BUNDLES.map((bundle: PresetBundle) => (
                  <div
                    key={bundle.id}
                    className={`onboarding-pack-card ${
                      selectedBundleId === bundle.id ? 'selected' : ''
                    }`}
                    onClick={() => setSelectedBundleId(bundle.id)}
                  >
                    <div className="pack-card-top">
                      <div>
                        <div className="pack-name-row">
                          <span className="pack-name">{bundle.name}</span>
                          <span className="pack-badge">{bundle.badge}</span>
                        </div>
                        <span className="pack-cat">{bundle.category}</span>
                      </div>
                      <div
                        className={`pack-radio-indicator ${
                          selectedBundleId === bundle.id ? 'active' : ''
                        }`}
                        aria-hidden="true"
                      >
                        <span className="pack-radio-dot" />
                      </div>
                    </div>
                    <p className="pack-desc">{bundle.description}</p>
                    <div className="pack-feeds-preview">
                      {bundle.items.map((it) => (
                        <span key={it.name} className="pack-mini-tag">
                          {it.name}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}

                <div
                  className={`onboarding-pack-card ${
                    selectedBundleId === 'current' ? 'selected' : ''
                  }`}
                  onClick={() => setSelectedBundleId('current')}
                >
                  <div className="pack-card-top">
                    <div>
                      <div className="pack-name-row">
                        <span className="pack-name">Custom / Default Feeds</span>
                        <span className="pack-badge secondary">Manual</span>
                      </div>
                      <span className="pack-cat">Pre-installed Feeds</span>
                    </div>
                    <div
                      className={`pack-radio-indicator ${
                        selectedBundleId === 'current' ? 'active' : ''
                      }`}
                      aria-hidden="true"
                    >
                      <span className="pack-radio-dot" />
                    </div>
                  </div>
                  <p className="pack-desc">
                    Keep your currently configured feeds without subscribing to an extra starter bundle.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: Defense profile, deploy, and optional AI */}
          {currentStep === 3 && (
            <div className="onboarding-step-panel step-setup">
              <div className="onboarding-step-intro">
                <h3 className="step-title">Set Up Defense, Deploy, and AI</h3>
                <p className="step-subtitle">
                  A working setup is three moves: keep the defense profile, point the compiled
                  list at a sinkhole, then decide whether AI runs on this machine.
                </p>
              </div>

              <div className="onboarding-setup-list">
                <div className="onboarding-setup-block">
                  <span className="onboarding-setup-index">1</span>
                  <div className="onboarding-setup-copy">
                    <h4>Defense profile</h4>
                    <p>
                      <strong>{selectedBundleName}</strong> is selected. Change it on the Protection
                      step. Its feeds are subscribed when you finish this tour.
                    </p>
                  </div>
                </div>

                <div className="onboarding-setup-block">
                  <span className="onboarding-setup-index">2</span>
                  <div className="onboarding-setup-copy">
                    <h4>Deploy and sync</h4>
                    <p>
                      Choose where the compiled list should go. Addresses, tokens, and reload-on-compile
                      are entered in Deploy & Sync after the tour.
                    </p>
                    <div className="onboarding-choice-grid">
                      {DEPLOY_SETUP_OPTIONS.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className={`format-tile onboarding-choice ${
                            deployTarget === option.id ? 'selected' : ''
                          }`}
                          onClick={() => handleDeployPick(option.id)}
                        >
                          <div className="format-tile-header">
                            <span className="format-name">{option.name}</span>
                          </div>
                          <span className="format-target">{option.detail}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="onboarding-setup-block">
                  <span className="onboarding-setup-index">3</span>
                  <div className="onboarding-setup-copy">
                    <h4>Optional AI</h4>
                    <p>
                      Mini-AI stays on-device. AI Radar scans domains and query logs, AI Sentinel
                      Watchdog scouts on a timer, and Threat Quarantine holds verdicts until you
                      block or allow them. The Unified Inspector checks coverage before you compile.
                    </p>
                    <div className="onboarding-choice-grid">
                      {AI_SETUP_OPTIONS.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className={`format-tile onboarding-choice ${
                            aiSetup === option.id ? 'selected' : ''
                          }`}
                          onClick={() => setAiSetup(option.id)}
                        >
                          <div className="format-tile-header">
                            <span className="format-name">{option.name}</span>
                          </div>
                          <span className="format-target">{option.detail}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 4: Output Format & Visual Accent Customizer */}
          {currentStep === 4 && (
            <div className="onboarding-step-panel step-personalize">
              <div className="onboarding-step-intro">
                <h3 className="step-title">Configure Output & Personal Style</h3>
                <p className="step-subtitle">
                  Pick your primary target format and select an accent tint tailored to your desktop.
                </p>
              </div>

              {/* Format selection */}
              <div className="onboarding-section">
                <h4 className="section-label">Primary Export Format</h4>
                <div className="onboarding-format-grid">
                  {FORMAT_OPTIONS.map((fmt) => (
                    <div
                      key={fmt.id}
                      className={`format-tile ${exportFormat === fmt.id ? 'selected' : ''}`}
                      onClick={() => setExportFormat(fmt.id)}
                    >
                      <div className="format-tile-header">
                        <span className="format-name">{fmt.name}</span>
                        <span className="format-badge">{fmt.badge}</span>
                      </div>
                      <span className="format-target">Target: {fmt.target}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Accent Color Selection */}
              <div className="onboarding-section">
                <h4 className="section-label">Accent Color Palette</h4>
                <div className="onboarding-accent-grid">
                  {ACCENT_PALETTE.map((accent) => (
                    <button
                      key={accent.id}
                      type="button"
                      className={`onboarding-accent-chip ${accentColor === accent.id ? 'selected' : ''}`}
                      onClick={() => handleAccentPick(accent.id)}
                      title={accent.name}
                    >
                      <span
                        className="accent-swatch-circle"
                        style={{ backgroundColor: accent.primary }}
                      />
                      <span className="accent-chip-label">{accent.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* STEP 5: Ready to Compile Launchpad */}
          {currentStep === 5 && (
            <div className="onboarding-step-panel step-launch">
              <div className="onboarding-hero">
                <div className="onboarding-badge-icon ready-pulse">
                  <svg
                    viewBox="0 0 24 24"
                    width="32"
                    height="32"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
                <h2 className="onboarding-title">You're All Set!</h2>
                <p className="onboarding-desc">
                  Your workspace is ready. Compile a list, then open Deploy & Sync to connect
                  the sinkhole. AI Radar, Threat Quarantine, and the Unified Inspector stay in the sidebar.
                </p>
              </div>

              {/* Summary recap card */}
              <div className="onboarding-summary-card">
                <div className="summary-item">
                  <span className="summary-label">Protection Profile:</span>
                  <span className="summary-value">{selectedBundleName}</span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Deploy Target:</span>
                  <span className="summary-value">{deployTargetLabel(deployTarget)}</span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">AI Preference:</span>
                  <span className="summary-value">{aiSetupLabel(aiSetup)}</span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Primary Format:</span>
                  <span className="summary-value">
                    {FORMAT_OPTIONS.find((f) => f.id === exportFormat)?.name}
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Accent Tint:</span>
                  <span className="summary-value">
                    {ACCENT_PALETTE.find((a) => a.id === accentColor)?.name}
                  </span>
                </div>
              </div>

              {/* Checkbox for initial compilation */}
              <label className="onboarding-compile-checkbox">
                <input
                  type="checkbox"
                  checked={shouldCompileImmediately}
                  onChange={(e) => setShouldCompileImmediately(e.target.checked)}
                />
                <span>Trigger first compilation immediately on entry</span>
              </label>
            </div>
          )}
        </div>

        {/* Modal Navigation Footer */}
        <div className="onboarding-footer">
          <div className="onboarding-footer-left">
            <span className="step-counter">
              Step {currentStep} of {totalSteps}
            </span>
          </div>
          <div className="onboarding-footer-right">
            {currentStep > 1 && (
              <button
                className="secondary-button"
                onClick={() => setCurrentStep((prev) => prev - 1)}
              >
                Back
              </button>
            )}
            {currentStep < totalSteps ? (
              <button
                className="primary-button onboarding-next-btn"
                onClick={() => setCurrentStep((prev) => prev + 1)}
              >
                Continue →
              </button>
            ) : (
              <button
                className="primary-button onboarding-finish-btn"
                onClick={handleFinish}
              >
                {shouldCompileImmediately ? 'Compile & Open Dashboard' : 'Open Dashboard'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
