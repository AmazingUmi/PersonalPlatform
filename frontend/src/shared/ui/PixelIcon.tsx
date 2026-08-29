import { pixelIcons, type IconName } from "./icons";

interface PixelIconProps {
  name: IconName;
  /** Rendered size in px; the glyph stays crisp because it scales a 16px grid. */
  size?: number;
  className?: string;
}

/** Decorative pixel glyph (aria-hidden); labels come from the surrounding UI. */
export function PixelIcon({ name, size = 16, className }: PixelIconProps) {
  const def = pixelIcons[name];
  return (
    <svg
      className={className ? `px-icon ${className}` : "px-icon"}
      viewBox={def.box}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {def.node}
    </svg>
  );
}

export type { IconName };
