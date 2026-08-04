'use client';

import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';

import { useReveal } from '../hooks/use-reveal';

const STEPS = [
  'Customer payment',
  'AI risk plan',
  'Paid tool procurement',
  'Deterministic evidence',
  'GOAT attestation',
];

const STEP_DURATION_MS = 2200;

export function AnimatedWorkflow() {
  const [ref, visible] = useReveal<HTMLElement>();
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => {
      setActive((current) => (current + 1) % STEPS.length);
    }, STEP_DURATION_MS);
    return () => window.clearInterval(id);
  }, [visible]);

  return (
    <section className={`workflow${visible ? ' is-visible' : ''}`} aria-label="Assurance workflow" ref={ref}>
      <div className="workflow-track" style={{ '--progress': `${((active + 1) / STEPS.length) * 100}%` } as CSSProperties} />
      {STEPS.map((step, index) => (
        <div
          className={`workflow-step${index === active ? ' is-active' : ''}${index < active ? ' is-done' : ''}`}
          key={step}
          style={{ '--delay': `${index * 90}ms` } as CSSProperties}
        >
          <span>{String(index + 1).padStart(2, '0')}</span>
          <p>{step}</p>
        </div>
      ))}
    </section>
  );
}
