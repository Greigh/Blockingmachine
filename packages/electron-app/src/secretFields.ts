import type { SinkholeConfig } from './types/index';

/**
 * Write-only secret plumbing shared by the settings forms.
 *
 * `get-sinkhole-config` returns `*Configured` presence flags, never the secret values — so
 * a form field is always blank-on-load regardless of what is saved. Blank means "keep the
 * stored secret"; replacing means typing a new value; clearing is an explicit intent the
 * renderer stages in `clearSecrets` so a save cannot wipe credentials just because the
 * fields started empty.
 */
export type SinkholeSecretKey = 'piholeApiKey' | 'adguardHomePassword' | 'haToken';

const CONFIGURED_FLAG: Record<SinkholeSecretKey, keyof SinkholeConfig> = {
  piholeApiKey: 'piholeApiKeyConfigured',
  adguardHomePassword: 'adguardHomePasswordConfigured',
  haToken: 'haTokenConfigured',
};

export function secretConfigured(config: SinkholeConfig, key: SinkholeSecretKey): boolean {
  return Boolean(config[CONFIGURED_FLAG[key]]);
}

export function secretCleared(config: SinkholeConfig, key: SinkholeSecretKey): boolean {
  return (config.clearSecrets ?? []).includes(key);
}

/** Field edit: typing a value un-stages a pending clear for that key. */
export function updateSecretField(config: SinkholeConfig, key: SinkholeSecretKey, value: string): SinkholeConfig {
  return {
    ...config,
    [key]: value,
    clearSecrets: (config.clearSecrets ?? []).filter((k) => k !== key),
  };
}

/** Clear/undo toggle: clearing empties the field and stages the key; undo restores "keep". */
export function toggleSecretCleared(config: SinkholeConfig, key: SinkholeSecretKey): SinkholeConfig {
  const current = config.clearSecrets ?? [];
  const cleared = current.includes(key);
  return {
    ...config,
    [key]: '',
    clearSecrets: cleared ? current.filter((k) => k !== key) : [...current, key],
  };
}

/** Placeholder that tells the truth about what a blank field will do on save. */
export function secretPlaceholder(config: SinkholeConfig, key: SinkholeSecretKey, emptyPlaceholder: string): string {
  if (secretCleared(config, key)) return 'Saved value will be cleared on save';
  if (secretConfigured(config, key)) return 'Saved — leave blank to keep';
  return emptyPlaceholder;
}
