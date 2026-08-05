'use client';

import { useEffect, useState } from 'react';

import { useReveal } from '../hooks/use-reveal';
import { Pipeline } from './pipeline';

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
    <section className="workflow-section" aria-label="Assurance workflow" ref={ref}>
      <span className="eyebrow workflow-eyebrow"><i>[01]</i> HOW A RUN MOVES</span>
      <Pipeline steps={STEPS} activeIndex={active} visible={visible} />
    </section>
  );
}
