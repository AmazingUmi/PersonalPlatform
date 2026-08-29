import type { InputHTMLAttributes } from "react";

/** Modern square pixel form field (guide §14) — not a game-style input. */
export function PixelInput({
  className = "",
  type = "text",
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type={type}
      className={`px-input${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
}
