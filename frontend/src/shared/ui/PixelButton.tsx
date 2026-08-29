import type { ButtonHTMLAttributes } from "react";

export type PixelButtonVariant = "primary" | "secondary" | "danger" | "ghost";

interface PixelButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: PixelButtonVariant;
  size?: "sm" | "md";
}

/** Pixel action button (guide §13): hard border, hard shadow, press offset. */
export function PixelButton({
  variant = "primary",
  size = "md",
  type = "button",
  className = "",
  ...rest
}: PixelButtonProps) {
  return (
    <button
      type={type}
      className={`px-button px-button--${variant} px-button--${size}${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
}
