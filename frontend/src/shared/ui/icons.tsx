/**
 * Pixel icon registry — 16×16 SVG glyphs (logo is 24×24).
 * Rules (guide §17): integer coordinates, 2px strokes or solid rects,
 * no gradients, no arcs, shape-rendering crispEdges, currentColor.
 */
import type { ReactNode } from "react";

interface PixelIconDef {
  box: string;
  node: ReactNode;
}

export const pixelIcons = {
  dashboard: {
    box: "0 0 16 16",
    node: <path d="M7 1h2v2h1v1h1v1h1v1h1v1h1v8h-5v-5h-3v5H1V7h1V6h1V5h1V4h1V3h1V1z" />,
  },
  apps: {
    box: "0 0 16 16",
    node: <path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" />,
  },
  settings: {
    box: "0 0 16 16",
    node: (
      <>
        <path fillRule="evenodd" d="M3 3h10v10H3zM7 7h2v2H7z" />
        <path d="M7 1h2v3H7zM7 12h2v3H7zM1 7h3v2H1zM12 7h3v2h-3z" />
      </>
    ),
  },
  tasks: {
    box: "0 0 16 16",
    node: (
      <>
        <path fillRule="evenodd" d="M3 3h10v12H3zM5 6h6v2H5zM5 10h4v2H5z" />
        <path d="M5 1h6v3H5z" />
      </>
    ),
  },
  box: {
    box: "0 0 16 16",
    node: (
      <>
        <path fillRule="evenodd" d="M1 4h14v10H1zM3 7h10v2H3z" />
        <path d="M2 2h12v2H2z" />
      </>
    ),
  },
  game: {
    box: "0 0 16 16",
    node: (
      <path
        fillRule="evenodd"
        d="M2 4h12v8H2zM4 6h2v4H4zM3 7h4v2H3zM10 6h2v2h-2zM11 9h2v2h-2z"
      />
    ),
  },
  search: {
    box: "0 0 16 16",
    node: (
      <>
        <path fillRule="evenodd" d="M2 2h8v8H2zM4 4h4v4H4z" />
        <path d="M9 9h2v2H9zM11 11h2v2h-2zM13 13h2v2h-2z" />
      </>
    ),
  },
  plus: {
    box: "0 0 16 16",
    node: <path d="M7 3h2v4h4v2H9v4H7V9H3V7h4V3z" />,
  },
  trash: {
    box: "0 0 16 16",
    node: (
      <>
        <path d="M6 1h4v1h4v2H2V2h4V1z" />
        <path fillRule="evenodd" d="M4 6h8v9H4zM6 8h1v5H6zM9 8h1v5H9z" />
      </>
    ),
  },
  back: {
    box: "0 0 16 16",
    node: <path d="M7 7h6v2H7v2H5V9H3V7h2V5h2v2z" />,
  },
  warning: {
    box: "0 0 16 16",
    node: (
      <path
        fillRule="evenodd"
        d="M7 2h2v1H7zM6 3h4v1H6zM5 4h6v1H5zM4 5h8v1H4zM3 6h10v1H3zM2 7h12v6H2zM7 7h2v3H7zM7 11h2v2H7z"
      />
    ),
  },
  refresh: {
    box: "0 0 16 16",
    node: (
      <>
        <path d="M4 2h8v2H4zM2 4h2v8H2zM4 12h8v2H4zM12 4h2v5h-2z" />
        <path d="M12 8l3 3h-2v3h-2v-3H9l3-3z" />
      </>
    ),
  },
  file: {
    box: "0 0 16 16",
    node: (
      <path
        fillRule="evenodd"
        d="M3 1h7l3 3v11H3zM5 7h6v2H5zM5 11h4v2H5z"
      />
    ),
  },
  folder: {
    box: "0 0 16 16",
    node: <path d="M1 3h5l2 2h7v8H1V3z" />,
  },
  check: {
    box: "0 0 16 16",
    node: <path d="M13 3l2 2-8 8-5-5 2-2 3 3 6-6z" />,
  },
  info: {
    box: "0 0 16 16",
    node: (
      <path
        fillRule="evenodd"
        d="M2 2h12v12H2zM7 4h2v2H7zM7 7h2v5H7z"
      />
    ),
  },
  upload: {
    box: "0 0 16 16",
    node: (
      <>
        <path d="M8 1l4 4H9v6H7V5H4l4-4z" />
        <path d="M3 13h10v2H3z" />
      </>
    ),
  },
  menu: {
    box: "0 0 16 16",
    node: <path d="M2 3h12v2H2zM2 7h12v2H2zM2 11h12v2H2z" />,
  },
  logo: {
    box: "0 0 24 24",
    node: <path d="M2 2h8v8H2zM14 2h8v8h-8zM2 14h8v8H2zM14 14h8v8h-8z" />,
  },
} satisfies Record<string, PixelIconDef>;

export type IconName = keyof typeof pixelIcons;
