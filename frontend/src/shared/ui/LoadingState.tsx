interface LoadingStateProps {
  label?: string;
}

/** Unified 3-block pixel loading indicator (guide §27). Animation is disabled
 * under prefers-reduced-motion via the global media query. */
export function LoadingState({ label = "Loading…" }: LoadingStateProps) {
  return (
    <div className="px-loading" role="status" aria-live="polite">
      <span className="px-loading__blocks" aria-hidden="true">
        <span className="px-loading__block" />
        <span className="px-loading__block" />
        <span className="px-loading__block" />
      </span>
      <span className="px-loading__label">{label}</span>
    </div>
  );
}
