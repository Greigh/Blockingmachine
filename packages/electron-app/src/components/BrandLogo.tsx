import React from 'react';
import brandIcon from '../../assets/Blockingmachine.png';

export interface BrandLogoProps {
  size?: number;
  className?: string;
  alt?: string;
  style?: React.CSSProperties;
  glow?: boolean;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({
  size = 28,
  className = '',
  alt = 'Blockingmachine',
  style = {},
  glow = false,
}) => {
  return (
    <img
      src={brandIcon}
      width={size}
      height={size}
      className={`brand-logo-img ${glow ? 'brand-logo-glow' : ''} ${className}`.trim()}
      alt={alt}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        objectFit: 'contain',
        display: 'inline-block',
        verticalAlign: 'middle',
        flexShrink: 0,
        ...style,
      }}
    />
  );
};

export default BrandLogo;
export { brandIcon };
