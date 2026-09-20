import React, { useState, useEffect } from 'react';
import type { FilterFormat, FilterSource } from '../types/';
import { PRESET_BUNDLES, type PresetBundle } from './PresetsModal';
import { ACCENT_PALETTE, applyAccentColor } from '../theme';
import { BrandLogo } from '../components/BrandLogo';

export interface OnboardingConfig {
  selectedBundleId?: string;
  exportFormat: FilterFormat;
  accentColor: string;
  shouldCompileImmediately: boolean;
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

  // Sync format from store on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && window.electron?.getExportFormat) {
      window.electron.getExportFormat().then((fmt) => {
        if (fmt) setExportFormat(fmt);
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

      if (e.key === 'Enter' && currentStep < 4) {
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

  const handleFinish = () => {
    onComplete({
      selectedBundleId: selectedBundleId === 'current' ? undefined : selectedBundleId,
      exportFormat,
      accentColor,
      shouldCompileImmediately,
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

  const totalSteps = 4;

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
            {[1, 2, 3, 4].map((step) => (
              <div
                key={step}
                className={`onboarding-step-pill ${
                  currentStep === step
                    ? 'active'
                    : currentStep > step
                      ? 'completed'
                      : ''
                }`}
                onClick={() => setCurrentStep(step)}
              >
                <span className="step-number">{currentStep > step ? '✓' : step}</span>
                <span className="step-label">
                  {step === 1 && 'Welcome'}
                  {step === 2 && 'Protection'}
                  {step === 3 && 'Personalize'}
                  {step === 4 && 'Launch'}
                </span>
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
                  Your native, high-performance compiler and management workspace for
                  network-wide adblock, privacy, and malware filter lists.
                </p>
              </div>

              <div className="onboarding-highlights-grid">
                <div className="onboarding-highlight-card">
                  <div className="highlight-icon-box" aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </svg>
                  </div>
                  <h4>Universal Multi-Format Export</h4>
                  <p>
                    Compile once, deploy everywhere. Generates optimized lists for
                    AdGuard Home, Pi-hole, hosts files, dnsmasq, and plain domains.
                  </p>
                </div>
                <div className="onboarding-highlight-card">
                  <div className="highlight-icon-box" aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                  </div>
                  <h4>Intelligent Deduplication</h4>
                  <p>
                    Consolidates overlapping loopback rules, prunes redundant subdomains,
                    and preserves important exception bypasses.
                  </p>
                </div>
                <div className="onboarding-highlight-card">
                  <div className="highlight-icon-box" aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="23 4 23 10 17 10" />
                      <polyline points="1 20 1 14 7 14" />
                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                  </div>
                  <h4>Direct Sinkhole Sync</h4>
                  <p>
                    Automatically push fresh rule bundles straight into your local Pi-hole
                    or AdGuard Home instance with live API reload.
                  </p>
                </div>
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

          {/* STEP 3: Output Format & Visual Accent Customizer */}
          {currentStep === 3 && (
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

          {/* STEP 4: Ready to Compile Launchpad */}
          {currentStep === 4 && (
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
                  Your customized Blockingmachine workspace is configured and ready.
                </p>
              </div>

              {/* Summary recap card */}
              <div className="onboarding-summary-card">
                <div className="summary-item">
                  <span className="summary-label">Protection Profile:</span>
                  <span className="summary-value">
                    {selectedBundleId === 'current'
                      ? 'Custom / Default Feeds'
                      : PRESET_BUNDLES.find((b) => b.id === selectedBundleId)?.name || 'Standard'}
                  </span>
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
