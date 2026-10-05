import React from 'react';

/**
 * Clear/undo affordance for a write-only secret field. The configured value never reaches
 * the renderer, so clearing is a staged intent (`clearSecrets` in the save payload), not a
 * value edit — Undo restores keep-saved behavior without ever knowing the secret.
 */
export const SecretClearButton: React.FC<{
  cleared: boolean;
  onToggle: () => void;
  deployStyle?: boolean;
}> = ({ cleared, onToggle, deployStyle }) => (
  <button
    type="button"
    className={deployStyle ? 'deploy-eye-btn' : undefined}
    style={
      deployStyle
        ? undefined
        : {
            background: 'none',
            border: 'none',
            color: 'inherit',
            opacity: cleared ? 0.9 : 0.6,
            fontSize: '0.7rem',
            cursor: 'pointer',
            padding: 0,
            whiteSpace: 'nowrap',
          }
    }
    title={cleared ? 'Undo — keep the saved value' : 'Clear the saved value on save'}
    onClick={onToggle}
  >
    {cleared ? 'Undo clear' : 'Clear saved'}
  </button>
);
