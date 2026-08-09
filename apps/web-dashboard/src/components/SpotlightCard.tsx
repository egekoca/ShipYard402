'use client';

import type { CSSProperties, MouseEventHandler, PropsWithChildren } from 'react';
import { useRef } from 'react';

import './SpotlightCard.css';

interface SpotlightCardProps extends PropsWithChildren {
  className?: string;
  spotlightColor?: string;
  style?: CSSProperties;
}

export default function SpotlightCard({
  children,
  className = '',
  spotlightColor = 'rgba(255, 255, 255, 0.25)',
  style,
}: Readonly<SpotlightCardProps>) {
  const divRef = useRef<HTMLDivElement>(null);

  const handlePointerMove: MouseEventHandler<HTMLDivElement> = (event) => {
    if (!divRef.current) return;

    const rect = divRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    divRef.current.style.setProperty('--mouse-x', `${x}px`);
    divRef.current.style.setProperty('--mouse-y', `${y}px`);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer movement only positions a decorative light
    <div
      ref={divRef}
      onMouseMove={handlePointerMove}
      className={`card-spotlight ${className}`.trim()}
      style={{ ...style, '--spotlight-color': spotlightColor } as CSSProperties}
    >
      {children}
    </div>
  );
}
