import type { CSSProperties, ReactNode } from 'react';

import { SpecularButton, type SpecularButtonSize } from './specular-button';

export function AppLinkButton({
  children,
  size = 'sm',
  className = '',
  style,
}: Readonly<{
  children: ReactNode;
  size?: SpecularButtonSize;
  className?: string;
  style?: CSSProperties;
}>) {
  return (
    <SpecularButton
      href="/app"
      size={size}
      radius={999}
      tint="#000000"
      tintOpacity={0.6}
      textColor="#f0c419"
      lineColor="#14a17e"
      baseColor="#000000"
      intensity={1.05}
      shineSize={14}
      shineFade={45}
      speed={0.2}
      proximity={200}
      autoAnimate
      className={className}
      {...(style ? { style } : {})}
    >
      {children}
    </SpecularButton>
  );
}
