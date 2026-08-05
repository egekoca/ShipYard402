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
// Gap between a pass finishing and the next one beginning, on a freshly-keyed (0%-width) rail
// fill element -- this is what makes every pass sweep left-to-right only, never drain backward.
const RESET_DELAY_MS = 60;

export function AnimatedWorkflow() {
  const [ref, visible] = useReveal<HTMLElement>();
  const [active, setActive] = useState(-1);
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timeoutId: number;

    function runStep(current: number) {
      timeoutId = window.setTimeout(() => {
        if (cancelled) return;
        if (current + 1 < STEPS.length) {
          setActive(current + 1);
          runStep(current + 1);
        } else {
          // Full pass complete -- bump cycle (remounts the rail fill at 0%, see Pipeline's
          // fillResetKey) and start the next left-to-right pass after a brief reset beat.
          setCycle((count) => count + 1);
          setActive(-1);
          timeoutId = window.setTimeout(() => {
            if (cancelled) return;
            setActive(0);
            runStep(0);
          }, RESET_DELAY_MS);
        }
      }, STEP_DURATION_MS);
    }

    setActive(0);
    runStep(0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [visible]);

  return (
    <section className="workflow-section" aria-label="Assurance workflow" ref={ref}>
      <span className="eyebrow workflow-eyebrow"><i>[01]</i> HOW A RUN MOVES</span>
      <Pipeline steps={STEPS} activeIndex={active} visible={visible} fillResetKey={cycle} />
    </section>
  );
}
