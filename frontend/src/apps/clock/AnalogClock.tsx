import type { ClockSettings } from "./useClockSettings";
import { focusElapsedClock, type ClockFocusState } from "./DigitalClock";
import { handAngles, pad2, timeParts } from "./timeMath";

interface AnalogClockProps {
  now: Date;
  settings: Pick<ClockSettings, "showSeconds">;
  variant: "card" | "page";
  focus: ClockFocusState | null;
}

/** One tick mark: a rect near the dial edge, rotated to its angle. */
function Tick({ angle, major }: { angle: number; major: boolean }) {
  return (
    <rect
      className={major ? "clock-analog__tick clock-analog__tick--major" : "clock-analog__tick"}
      x={major ? 57 : 59}
      y={8}
      width={major ? 6 : 2}
      height={major ? 8 : 4}
      transform={`rotate(${angle} 60 60)`}
    />
  );
}

/**
 * Pixel analog clock, drawn as pure SVG (no third-party libraries). The whole
 * dial scales with its container via viewBox. The hour hand advances
 * continuously through the minute and second of the current hour, and the
 * second hand ticks discretely — a sweep would fight the pixel aesthetic.
 */
export function AnalogClock({ now, settings, variant, focus }: AnalogClockProps) {
  const angles = handAngles(now);
  const parts = timeParts(now);
  const ticks = Array.from({ length: 60 }, (_, index) => ({
    angle: index * 6,
    major: index % 5 === 0,
  }));
  return (
    <div
      className={[
        "clock-analog",
        `clock-analog--${variant}`,
        focus ? "clock-analog--focus" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="timer"
      aria-label={`Current time ${parts.hours24}:${parts.minutes}`}
    >
      <svg
        className="clock-analog__svg"
        viewBox="0 0 120 120"
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        {/* Focus state ring — dashed accent circle (rotates slowly, reduced-motion safe). */}
        {focus ? <circle cx="60" cy="60" r="57" className="clock-analog__ring" /> : null}
        <circle cx="60" cy="60" r="53" className="clock-analog__dial" />
        {ticks.map((tick) => (
          <Tick key={tick.angle} angle={tick.angle} major={tick.major} />
        ))}
        <text x="60" y="27" className="clock-analog__numeral">12</text>
        <text x="95" y="62" className="clock-analog__numeral">3</text>
        <text x="60" y="97" className="clock-analog__numeral">6</text>
        <text x="25" y="62" className="clock-analog__numeral">9</text>
        <g transform={`rotate(${angles.hour} 60 60)`}>
          <rect x="57" y="32" width="6" height="32" className="clock-analog__hand clock-analog__hand--hour" />
        </g>
        <g transform={`rotate(${angles.minute} 60 60)`}>
          <rect x="58" y="18" width="4" height="46" className="clock-analog__hand clock-analog__hand--minute" />
        </g>
        {settings.showSeconds ? (
          <g transform={`rotate(${angles.second} 60 60)`}>
            <rect x="59" y="13" width="2" height="52" className="clock-analog__hand clock-analog__hand--second" />
          </g>
        ) : null}
        <rect x="57" y="57" width="6" height="6" className="clock-analog__cap" />
      </svg>
      <div className="clock-analog__meta">
        {focus ? (
          <span className="clock-analog__focus-line">
            <span className="clock-analog__focus-dot" aria-hidden="true" />
            RUNNING · {focusElapsedClock(focus, now)}
          </span>
        ) : (
          <span className="clock-analog__focus-line clock-analog__focus-line--idle">
            {pad2(now.getHours())}:{parts.minutes}
          </span>
        )}
        {focus ? <span className="clock-analog__focus-title">{focus.title}</span> : null}
      </div>
    </div>
  );
}
