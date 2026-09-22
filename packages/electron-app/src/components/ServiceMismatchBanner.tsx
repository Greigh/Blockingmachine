import React from 'react';
import { ADGUARD_ON_HA_API_DETAILS, HA_ON_DIRECT_DETAILS } from '../sinkholeIdentity';

interface ServiceMismatchBannerProps {
  details?: string;
  message?: string;
  onUseDirect?: () => void;
  onUseHaApi?: () => void;
}

export const ServiceMismatchBanner: React.FC<ServiceMismatchBannerProps> = ({
  details,
  message,
  onUseDirect,
  onUseHaApi,
}) => {
  if (!message || (details !== ADGUARD_ON_HA_API_DETAILS && details !== HA_ON_DIRECT_DETAILS)) {
    return null;
  }
  const useDirect = details === ADGUARD_ON_HA_API_DETAILS;
  return (
    <div className="service-mismatch-banner" role="alert">
      <div className="service-mismatch-copy">
        <strong>{useDirect ? 'This address is AdGuard Home' : 'This address is Home Assistant'}</strong>
        <p>{message}</p>
      </div>
      {useDirect && onUseDirect && (
        <button type="button" className="primary-button service-mismatch-action" onClick={onUseDirect}>
          Switch to Direct AdGuard
        </button>
      )}
      {!useDirect && onUseHaApi && (
        <button type="button" className="primary-button service-mismatch-action" onClick={onUseHaApi}>
          Switch to Home Assistant REST API
        </button>
      )}
    </div>
  );
};
