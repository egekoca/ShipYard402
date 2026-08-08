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

const TOTAL_DURATION_MS = 2200 * STEPS.length;
// Held at 100% before snapping back to 0% and starting the next pass -- lets "GOAT attestation"
// actually register as reached instead of resetting the instant it lights up.
const HOLD_AT_END_MS = 900;

export function AnimatedWorkflow() {
  const [ref, visible] = useReveal<HTMLElement>();
  const [progress, setProgress] = useState(0);
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    if (!visible) return;
    let frameId: number;
    let timeoutId: number;
    let cancelled = false;

    function playPass() {
      const startTime = performance.now();
      function frame(now: number) {
        if (cancelled) return;
        const elapsed = now - startTime;
        if (elapsed >= TOTAL_DURATION_MS) {
          setProgress(1);
          timeoutId = window.setTimeout(() => {
            if (cancelled) return;
            setCycle((count) => count + 1);
            setProgress(0);
            playPass();
          }, HOLD_AT_END_MS);
          return;
        }
        setProgress(elapsed / TOTAL_DURATION_MS);
        frameId = requestAnimationFrame(frame);
      }
      frameId = requestAnimationFrame(frame);
    }

    playPass();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [visible]);

  const activeIndex = Math.min(Math.floor(progress * STEPS.length), STEPS.length - 1);

  return (
    <section className="workflow-section" aria-label="Assurance workflow" ref={ref}>
      <span className="eyebrow workflow-eyebrow">
        <i>[03]</i> HOW A RUN MOVES
      </span>
      <Pipeline steps={STEPS} activeIndex={activeIndex} visible={visible} fillResetKey={cycle} progress={progress} />
    </section>
  );
}
