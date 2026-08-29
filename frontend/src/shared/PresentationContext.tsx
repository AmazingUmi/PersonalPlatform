import { createContext, useContext, type ReactNode } from "react";
import { resolvePresentation, type PresentationOverrides } from "./presentation";
import type { AppInfo } from "./api";

const PresentationContext = createContext<PresentationOverrides>({});

export function PresentationProvider({
  value,
  children,
}: {
  value: PresentationOverrides;
  children: ReactNode;
}) {
  return <PresentationContext.Provider value={value}>{children}</PresentationContext.Provider>;
}

/**
 * Resolved display name for one app (FP-6.2) — used by app page headers so a
 * nickname set in the App Center shows everywhere the app is presented.
 */
export function useAppDisplayName(app: Pick<AppInfo, "id" | "name">): string {
  const overrides = useContext(PresentationContext);
  return resolvePresentation(app, overrides).displayName;
}
