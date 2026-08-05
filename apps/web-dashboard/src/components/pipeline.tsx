import type { CSSProperties } from 'react';

export type PipelineProps = Readonly<{
  steps: readonly string[];
  /** -1 = nothing started yet; steps.length = everything done. */
  activeIndex: number;
  visible?: boolean;
}>;

export function Pipeline({ steps, activeIndex, visible = true }: PipelineProps) {
  const filled = Math.min(Math.max(activeIndex, 0) + 1, steps.length);
  const progress = (filled / steps.length) * 100;

  return (
    <div className={`pipeline${visible ? ' is-visible' : ''}`}>
      <div className="pipeline-rail">
        <div className="pipeline-rail-fill" style={{ width: `${progress}%` }} />
        {steps.map((step, index) => (
          <span
            key={step}
            className={`pipeline-dot${index < activeIndex ? ' is-done' : ''}${index === activeIndex ? ' is-active' : ''}`}
            style={{ left: `${((index + 0.5) / steps.length) * 100}%` }}
          />
        ))}
      </div>
      <div className="pipeline-labels">
        {steps.map((step, index) => (
          <div
            key={step}
            className={`pipeline-label${index < activeIndex ? ' is-done' : ''}${index === activeIndex ? ' is-active' : ''}`}
            style={{ '--delay': `${index * 90}ms` } as CSSProperties}
          >
            <span className="pipeline-label-index">{String(index + 1).padStart(2, '0')}</span>
            <p>{step}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
