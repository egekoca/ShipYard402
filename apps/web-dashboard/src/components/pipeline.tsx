import type { CSSProperties } from 'react';

import { RadarMark } from './logo';

export type PipelineProps = Readonly<{
  steps: readonly string[];
  /** -1 = nothing started yet; steps.length = everything done. */
  activeIndex: number;
  visible?: boolean;
  /**
   * Bump this to force the rail fill to remount at 0% instead of animating backward from a
   * filled state -- e.g. a looping demo restarting. Real (non-looping) progress, like a run's
   * actual status, never needs this since it only ever moves forward.
   */
  fillResetKey?: number | string;
  /**
   * 0..1, updated every animation frame by a continuous rAF loop (see AnimatedWorkflow). When
   * set, the fill width and each dot's lit state are both derived directly from this single
   * value every frame instead of activeIndex's discrete jumps -- there is no separate CSS
   * transition trying to chase a moving target, so they can never visibly fall out of step or
   * stutter relative to each other.
   */
  progress?: number;
  /**
   * Per-step "usually takes ~Xs" hint, same length/order as `steps`. `null` at an index means no
   * estimate is available yet (too few historical runs) -- omit the whole prop rather than pass
   * fabricated numbers, e.g. for the marketing landing-page demo, which has no real runs behind it.
   */
  stepEtas?: readonly (string | null)[];
}>;

export function Pipeline({ steps, activeIndex, visible = true, fillResetKey, progress, stepEtas }: PipelineProps) {
  const continuous = progress !== undefined;
  const filled = Math.min(Math.max(activeIndex, 0) + 1, steps.length);
  const width = continuous ? progress * 100 : activeIndex < 0 ? 0 : (filled / steps.length) * 100;
  const currentSegment = Math.min(Math.max(activeIndex, 0), steps.length - 1);

  return (
    <div className={`pipeline${visible ? ' is-visible' : ''}`}>
      <div className="pipeline-rail">
        <div
          key={fillResetKey}
          className={`pipeline-rail-fill${continuous ? ' is-continuous' : ''}`}
          style={{ width: `${width}%` }}
        />
        {steps.map((step, index) => {
          const dotPosition = (index + 0.5) / steps.length;
          const isDone = continuous ? (progress as number) >= dotPosition : index < activeIndex;
          const isActive = continuous ? !isDone && index === currentSegment : index === activeIndex;
          return (
            <span
              // Same remount-on-reset trick as the rail fill above: a cycle restart must snap
              // every dot back to unlit instantly, not fade it back out over its light-up transition.
              key={fillResetKey !== undefined ? `${fillResetKey}-${step}` : step}
              className={`pipeline-dot${isDone ? ' is-done' : ''}${isActive ? ' is-active' : ''}`}
              style={{ left: `${dotPosition * 100}%` }}
            />
          );
        })}
      </div>
      <div className="pipeline-labels">
        {steps.map((step, index) => {
          const isActive = index === activeIndex;
          return (
            <div
              key={step}
              className={`pipeline-label${index < activeIndex ? ' is-done' : ''}${isActive ? ' is-active' : ''}`}
              style={{ '--delay': `${index * 90}ms` } as CSSProperties}
            >
              <span className="pipeline-label-index">{String(index + 1).padStart(2, '0')}</span>
              <p>{step}{isActive && <RadarMark className="pipeline-label-radar" />}</p>
              {stepEtas?.[index] && <span className="pipeline-label-eta">{stepEtas[index]} typical</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
