import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { getSetting, putSetting, type AppInfo } from "../shared/api";
import type { WidgetDensity, WidgetLayoutSpec, WidgetRenderContext } from "../shared/appTypes";
import { resolvePresentation, type PresentationOverrides } from "../shared/presentation";
import { ConfirmDialog } from "../shared/ui/ConfirmDialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { LoadingState } from "../shared/ui/LoadingState";
import { PixelButton } from "../shared/ui/PixelButton";
import { PixelIcon } from "../shared/ui/PixelIcon";
import { PixelWindow } from "../shared/ui/PixelWindow";
import { StatusMessage } from "../shared/ui/StatusMessage";
import { appAccent, appIconName } from "../shared/ui/appIcons";
import {
  DASHBOARD_DESKTOP_MEDIA_QUERY,
  GRID_SIZE,
  canvasHeightFor,
  clampPlacement,
  findFirstFreePosition,
  generateDefaultLayout,
  gridKeyboardCoordinateGetter,
  parseDashboardLayout,
  placementRect,
  rectIsFree,
  resolveEffectiveLayout,
  resolveWidgetDefaults,
  resolveWidgetDensity,
  resizePlacement,
  serializeLayout,
  snapToGrid,
  sortForMobile,
  type DashboardLayoutV2,
  type DashboardWidgetPlacement,
  type ParsedDashboardLayout,
  type ResolvedWidgetLayout,
  type SizeUnits,
} from "./dashboardLayout";
import { enabledAppModules, resolveWidgets, type ResolvedWidget } from "./routes";

const LAYOUT_KEY = "dashboard.widgets";
const widgetKey = (widget: ResolvedWidget) => `${widget.appId}:${widget.widget.id}`;

/** Interactive descendants must not trigger card navigation (FP-5.2). */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, a, input, select, textarea, label") !== null;
}

/** Grid rect for a placement at a concrete (possibly live-preview) size. */
function rectOfSize(placement: DashboardWidgetPlacement, size: SizeUnits) {
  return { x: placement.x, y: placement.y, w: size.w, h: size.h };
}

/**
 * Desktop free-layout mode. Guards environments without matchMedia (jsdom
 * without a stub): they deterministically get the narrow flow layout.
 */
function subscribeDesktopMedia(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(DASHBOARD_DESKTOP_MEDIA_QUERY);
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", callback);
    return () => mql.removeEventListener("change", callback);
  }
  // Older engines only expose the deprecated listener pair.
  if (typeof mql.addListener === "function") {
    mql.addListener(callback);
    return () => mql.removeListener(callback);
  }
  return () => {};
}

function desktopMediaSnapshot(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(DASHBOARD_DESKTOP_MEDIA_QUERY).matches
  );
}

function useDesktopLayoutMode(): boolean {
  return useSyncExternalStore(subscribeDesktopMedia, desktopMediaSnapshot, () => false);
}

interface DragPreview {
  key: string;
  candidate: DashboardWidgetPlacement;
  valid: boolean;
}

/** Live bottom-right resize state (pointer or keyboard driven). */
interface ResizePreview {
  key: string;
  /** Pointer position at resize start (client coords). */
  startPx: { x: number; y: number };
  /** Size when the resize began — the revert target for invalid releases. */
  startSize: SizeUnits;
  size: SizeUnits;
  valid: boolean;
}

/** Working copy of the persisted layout while Edit Layout is open. */
interface DraftLayout {
  items: Record<string, DashboardWidgetPlacement>;
  hidden: string[];
}

/**
 * Dashboard is a pure widget container: widgets come from enabled frontend
 * app modules. The desktop canvas gives every widget an independent 2D grid
 * placement `{x, y, w, h}` (Free Layout V2 + Phase 10 adaptive resize)
 * persisted in core.settings under "dashboard.widgets" as
 * `{version: 2, items, hidden}`; legacy values (a plain widget-key array)
 * migrate on read. Card geometry comes from the placement itself — never
 * from measured content — and widgets adapt to their size through density
 * levels resolved from their declared thresholds. Narrow viewports fall back
 * to the normal flow grid with density "normal".
 */
export function Dashboard({ apps, presentation }: { apps: AppInfo[]; presentation?: PresentationOverrides }) {
  const navigate = useNavigate();
  const modules = enabledAppModules(apps);
  const available = useMemo(() => resolveWidgets(modules), [modules]);
  const routesById = useMemo(() => new Map(apps.map((app) => [app.id, app.route])), [apps]);
  const presentations = useMemo(
    () => new Map(apps.map((app) => [app.id, resolvePresentation(app, presentation ?? {})])),
    [apps, presentation],
  );

  const [parsed, setParsed] = useState<ParsedDashboardLayout | "loading">("loading");
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<DraftLayout | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [activeDrag, setActiveDrag] = useState<DragPreview | null>(null);
  const [activeResize, setActiveResize] = useState<ResizePreview | null>(null);
  /** Mirror of activeResize so pointer-up handlers never read a stale closure. */
  const activeResizeRef = useRef<ResizePreview | null>(null);
  /**
   * Mirror of the draft so discrete action handlers (resize keys, pointer up)
   * always read/commit the freshest items without functional updaters — the
   * updater must stay pure because it can trigger a save.
   */
  const draftRef = useRef<DraftLayout | null>(null);
  const desktop = useDesktopLayoutMode();

  useEffect(() => {
    let active = true;
    getSetting<unknown>(LAYOUT_KEY)
      .then((value) => {
        if (active) setParsed(parseDashboardLayout(value));
      })
      .catch(() => {
        if (active) setParsed({ kind: "none" });
      });
    return () => {
      active = false;
    };
  }, []);

  /**
   * Single persistence path (Phase 11): every save — Done, resize auto-save,
   * Reset — goes through here. Saves are serialized in call order so rapid
   * auto-saves (held arrow keys) can never apply responses out of order and
   * overwrite newer geometry with stale state. Failures keep the local layout
   * and surface a banner (optimistic-local, no rollback).
   */
  const saveChainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const saveLayout = useCallback((layout: DashboardLayoutV2): Promise<boolean> => {
    const attempt = saveChainRef.current.then(async () => {
      setSaveError(null);
      try {
        await putSetting(LAYOUT_KEY, layout);
        setParsed({ kind: "v2", items: layout.items, hidden: layout.hidden });
        return true;
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error));
        return false;
      }
    });
    saveChainRef.current = attempt.catch(() => false);
    return attempt;
  }, []);

  /** Commit a new draft (ref + state in lockstep); returns the committed value. */
  const applyDraft = useCallback((next: DraftLayout): DraftLayout => {
    draftRef.current = next;
    setDraft(next);
    return next;
  }, []);

  const availableKeys = useMemo(() => available.map(widgetKey), [available]);
  const byKey = useMemo(() => new Map(available.map((widget) => [widgetKey(widget), widget])), [available]);

  const updateResize = useCallback((next: ResizePreview | null) => {
    activeResizeRef.current = next;
    setActiveResize(next);
  }, []);

  // Widget layout contracts (grid units) resolved against platform defaults.
  const specs = useMemo(() => {
    const map: Record<string, WidgetLayoutSpec | undefined> = {};
    for (const resolved of available) map[widgetKey(resolved)] = resolved.widget.layout;
    return map;
  }, [available]);
  const layouts = useMemo(() => {
    const map: Record<string, ResolvedWidgetLayout> = {};
    for (const key of availableKeys) map[key] = resolveWidgetDefaults(specs[key]);
    return map;
  }, [availableKeys, specs]);
  const layoutOf = useCallback(
    (key: string) => layouts[key] ?? resolveWidgetDefaults(undefined),
    [layouts],
  );
  const defaultsOf = useCallback(
    (key: string): SizeUnits => {
      const layout = layoutOf(key);
      return { w: layout.defaultW, h: layout.defaultH };
    },
    [layoutOf],
  );

  // Effective (persisted) layout: saved placements + runtime auto-placement
  // for widgets that are neither placed nor hidden. Every placement carries
  // explicit w/h; nothing is written back until the next user save.
  const effective = useMemo(
    () => (parsed === "loading" ? null : resolveEffectiveLayout(parsed, availableKeys, specs, canvasWidth)),
    [parsed, availableKeys, specs, canvasWidth],
  );

  // Edit mode works on a draft snapshot that is persisted on Done.
  const items = editMode && draft ? draft.items : (effective?.items ?? {});
  const hiddenKeys = editMode && draft ? draft.hidden : (effective?.hidden ?? []);
  // DOM order is always the (y, x) reading order — it must never decide the
  // desktop visual position (that comes from each widget's placement).
  const orderedKeys = useMemo(() => sortForMobile(items), [items]);
  const orderSignature = orderedKeys.join(",");
  const visible = orderedKeys.flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : []));

  // ---------- canvas measurement ----------
  // Only the canvas WIDTH is measured (for capacity clamping). Card geometry
  // comes from placements, so per-card DOM measurement — and its feedback
  // loops — no longer exists.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const measureCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.getBoundingClientRect().width;
    setCanvasWidth((prev) => (Math.abs(prev - width) < 0.5 ? prev : width));
  }, []);

  useLayoutEffect(() => {
    measureCanvas();
  }, [measureCanvas, orderSignature, editMode, desktop]);

  useEffect(() => {
    if (!desktop) return;
    const onWindowResize = () => measureCanvas();
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, [desktop, measureCanvas]);

  // Leaving edit mode (or the desktop layout) must never strand a live
  // resize preview on a normal-mode card.
  useEffect(() => {
    if (!editMode || !desktop) updateResize(null);
  }, [editMode, desktop, updateResize]);

  // ---------- free-layout drag ----------

  const othersFor = useCallback(
    (key: string) =>
      Object.entries(items)
        .filter(([otherKey]) => otherKey !== key)
        .map(([otherKey, other]) => placementRect(other, defaultsOf(otherKey))),
    [items, defaultsOf],
  );

  /** Snap + clamp the origin-plus-delta position and collision-check it. */
  const evaluateCandidate = useCallback(
    (key: string, origin: DashboardWidgetPlacement, deltaPx: { x: number; y: number }) => {
      const defaults = defaultsOf(key);
      const raw: DashboardWidgetPlacement = {
        x: snapToGrid(origin.x * GRID_SIZE + deltaPx.x),
        y: snapToGrid(origin.y * GRID_SIZE + deltaPx.y),
        w: origin.w,
        h: origin.h,
      };
      const placement = clampPlacement(raw, defaults, canvasWidth);
      return { placement, valid: rectIsFree(placementRect(placement, defaults), othersFor(key)) };
    },
    [canvasWidth, defaultsOf, othersFor],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: gridKeyboardCoordinateGetter }),
  );

  const onDragStart = (event: DragStartEvent) => {
    // Global interaction mutex (Phase 11): a live resize locks all drags.
    if (activeResizeRef.current) return;
    const key = String(event.active.id);
    const origin = items[key];
    if (origin) setActiveDrag({ key, candidate: origin, valid: true });
  };

  const onDragMove = (event: DragMoveEvent) => {
    const key = String(event.active.id);
    const origin = items[key];
    if (!origin) return;
    const { placement, valid } = evaluateCandidate(key, origin, event.delta);
    setActiveDrag((prev) =>
      prev && prev.key === key && prev.valid === valid &&
        prev.candidate.x === placement.x && prev.candidate.y === placement.y
        ? prev
        : { key, candidate: placement, valid },
    );
  };

  const onDragEnd = (event: DragEndEvent) => {
    const key = String(event.active.id);
    // Mutex defense: a drag that somehow started under a live resize never
    // commits (the draggable is disabled; this guards the race).
    if (activeResizeRef.current) {
      setActiveDrag(null);
      return;
    }
    const origin = items[key];
    if (origin) {
      const { placement, valid } = evaluateCandidate(key, origin, event.delta);
      // Invalid drops (overlap / out of bounds) revert to the origin; valid
      // drops move ONLY the dragged widget — never any other card. Like
      // resize, a committed drag persists at action end (dnd-kit swallows
      // clicks for ~50ms after a pointer drag, so deferring the save to Done
      // made the very next click unreliable).
      if (valid && (placement.x !== origin.x || placement.y !== origin.y)) {
        const current = draftRef.current;
        if (current) {
          const next: DraftLayout = {
            ...current,
            items: { ...current.items, [key]: placement },
          };
          applyDraft(next);
          void saveLayout(serializeLayout(next.items, next.hidden));
        }
      }
    }
    setActiveDrag(null);
  };

  const onDragCancel = () => setActiveDrag(null);

  // ---------- bottom-right resize ----------

  const onResizeStart = (key: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    // Global interaction mutex (Phase 11): no resize under a live drag or a
    // second live resize (multi-pointer edge cases).
    if (activeDrag || activeResizeRef.current) return;
    if (event.button !== 0) return;
    const origin = items[key];
    if (!origin) return;
    event.preventDefault();
    // Pointer capture keeps move/up on the handle even outside the card;
    // jsdom lacks the API, so feature-detect (keyboard path covers jsdom).
    if (typeof event.currentTarget.setPointerCapture === "function") {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Capture races with a released pointer are harmless.
      }
    }
    const layout = layoutOf(key);
    const startSize = { w: origin.w ?? layout.defaultW, h: origin.h ?? layout.defaultH };
    updateResize({ key, startPx: { x: event.clientX, y: event.clientY }, startSize, size: startSize, valid: true });
  };

  const onResizeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = activeResizeRef.current;
    if (!current) return;
    const origin = items[current.key];
    if (!origin) return;
    const attempted = {
      w: snapToGrid(current.startSize.w * GRID_SIZE + (event.clientX - current.startPx.x)),
      h: snapToGrid(current.startSize.h * GRID_SIZE + (event.clientY - current.startPx.y)),
    };
    const { placement, valid } = resizePlacement(
      { x: origin.x, y: origin.y, w: current.startSize.w, h: current.startSize.h },
      attempted,
      layoutOf(current.key),
      canvasWidth,
      othersFor(current.key),
    );
    if (current.size.w === placement.w && current.size.h === placement.h && current.valid === valid) return;
    updateResize({ ...current, size: { w: placement.w, h: placement.h }, valid });
  };

  /**
   * Apply a valid resize result to the draft and auto-save it (Phase 11:
   * resize persists at action end — Done is no longer required). Resize
   * changes ONLY the resized widget's w/h — x/y and every other card stay
   * untouched (Free Layout V2 isolation rule).
   */
  const commitResize = (key: string, size: SizeUnits) => {
    const current = draftRef.current;
    if (!current) return;
    const origin = current.items[key];
    if (!origin || (origin.w === size.w && origin.h === size.h)) return;
    const next: DraftLayout = {
      ...current,
      items: { ...current.items, [key]: { x: origin.x, y: origin.y, w: size.w, h: size.h } },
    };
    applyDraft(next);
    void saveLayout(serializeLayout(next.items, next.hidden));
  };

  /** commit=true applies a valid candidate and auto-saves; invalid reverts. */
  const onResizeEnd = (commit: boolean) => {
    const current = activeResizeRef.current;
    updateResize(null);
    if (!current || !commit || !current.valid) return;
    commitResize(current.key, current.size);
  };

  const onResizeKeyDown = (key: string, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const deltas: Record<string, SizeUnits> = {
      ArrowLeft: { w: -1, h: 0 },
      ArrowRight: { w: 1, h: 0 },
      ArrowUp: { w: 0, h: -1 },
      ArrowDown: { w: 0, h: 1 },
    };
    const delta = deltas[event.code];
    if (!delta) return;
    // Mutex defense: no keyboard resize under a live drag/resize.
    if (activeDrag || activeResizeRef.current) return;
    // Stop the arrow from scrolling or reaching the dnd-kit drag sensor.
    event.preventDefault();
    event.stopPropagation();
    const draft = draftRef.current;
    const origin = draft?.items[key] ?? items[key];
    if (!origin || !draft) return;
    const layout = layoutOf(key);
    const attempted = {
      w: (origin.w ?? layout.defaultW) + delta.w,
      h: (origin.h ?? layout.defaultH) + delta.h,
    };
    const { placement, valid } = resizePlacement(origin, attempted, layout, canvasWidth, othersFor(key));
    // Invalid targets (collision) and targets that clamp to the current
    // size are no-ops — the keyboard never moves an invalid resize.
    if (!valid || (placement.w === origin.w && placement.h === origin.h)) return;
    const next: DraftLayout = {
      ...draft,
      items: { ...draft.items, [key]: { x: origin.x, y: origin.y, w: placement.w, h: placement.h } },
    };
    applyDraft(next);
    void saveLayout(serializeLayout(next.items, next.hidden));
  };

  // ---------- widget render context (density) ----------

  const sizeOfItem = useCallback(
    (key: string): SizeUnits => {
      if (activeResize?.key === key) return activeResize.size;
      const layout = layoutOf(key);
      const p = items[key];
      return { w: p?.w ?? layout.defaultW, h: p?.h ?? layout.defaultH };
    },
    [activeResize, items, layoutOf],
  );

  const renderContextFor = useCallback(
    (key: string): WidgetRenderContext => {
      const layout = layoutOf(key);
      // Mobile flow ignores desktop sizes: widgets render at their defaults
      // in normal density, so saved w/h never leaks into the narrow layout.
      const size = desktop ? sizeOfItem(key) : { w: layout.defaultW, h: layout.defaultH };
      const density: WidgetDensity = desktop
        ? resolveWidgetDensity(layout, size.w, size.h)
        : "normal";
      return {
        layout: {
          widthUnits: size.w,
          heightUnits: size.h,
          widthPx: size.w * GRID_SIZE,
          heightPx: size.h * GRID_SIZE,
          density,
        },
      };
    },
    [desktop, layoutOf, sizeOfItem],
  );

  // ---------- edit mode actions ----------

  const startEditing = () => {
    if (!effective) return;
    applyDraft({ items: { ...effective.items }, hidden: [...effective.hidden] });
    setEditMode(true);
  };

  const finishEditing = async () => {
    const current = draftRef.current;
    if (!current) return;
    // Done persists any still-unsaved draft changes (drags, hides) and exits.
    // After an auto-saved resize this re-persists the identical state.
    if (await saveLayout(serializeLayout(current.items, current.hidden))) setEditMode(false);
  };

  /** Deterministic default layout: every available widget at its default size. */
  const defaultLayout = (): DraftLayout => ({
    items: generateDefaultLayout(
      availableKeys.map((key) => ({ key, size: defaultsOf(key) })),
      canvasWidth,
    ),
    hidden: [],
  });

  /** Reset is one explicit action: defaults + all widgets shown, persisted
   * immediately — never deferred to Done (Phase 11 reset contract). */
  const performReset = async () => {
    setResetConfirmOpen(false);
    // Any live drag/resize preview was validated against the pre-reset
    // occupancy — drop it so it cannot commit on top of the new defaults.
    setActiveDrag(null);
    updateResize(null);
    const next = defaultLayout();
    if (editMode) applyDraft(next);
    await saveLayout(serializeLayout(next.items, next.hidden));
  };

  const hideWidget = (key: string) => {
    const current = draftRef.current;
    if (!current) return;
    const { [key]: _removed, ...rest } = current.items;
    applyDraft({ items: rest, hidden: [...current.hidden, key] });
  };

  const showWidget = (key: string) => {
    const current = draftRef.current;
    if (!current) return;
    const size = defaultsOf(key);
    const occupied = Object.entries(current.items).map(([otherKey, other]) =>
      placementRect(other, defaultsOf(otherKey)),
    );
    applyDraft({
      items: { ...current.items, [key]: findFirstFreePosition(size, occupied, canvasWidth) },
      hidden: current.hidden.filter((k) => k !== key),
    });
  };

  const openWidget = (resolved: ResolvedWidget) => {
    navigate(resolved.widget.href ?? routesById.get(resolved.appId) ?? "/");
  };

  if (parsed === "loading" || !effective) {
    return (
      <div className="page">
        <header className="page-header">
          <h1 className="page-header__title">Dashboard</h1>
          <p className="page-header__subtitle">System overview</p>
        </header>
        <LoadingState label="Loading widgets…" />
      </div>
    );
  }

  const hidden = hiddenKeys
    .map((key) => byKey.get(key))
    .filter((widget): widget is ResolvedWidget => widget !== undefined);

  // Canvas height follows the lowest card — including the live drag preview
  // and the live resize candidate — so it grows downwards instead of
  // clipping low geometry. Rects are built from the EFFECTIVE size (which
  // reflects the live resize), never from the stale placement.w.
  const cardRects = orderedKeys.map((key) => ({ ...rectOfSize(items[key]!, sizeOfItem(key)) }));
  const previewRect =
    activeDrag && items[activeDrag.key]
      ? placementRect(activeDrag.candidate, sizeOfItem(activeDrag.key))
      : null;
  const canvasHeight = canvasHeightFor(previewRect ? [...cardRects, previewRect] : cardRects);
  const canvasStyle: CSSProperties | undefined = desktop ? { height: `${canvasHeight}px` } : undefined;

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">Dashboard</h1>
        <p className="page-header__subtitle">System overview</p>
        <div className="page-header__actions">
          {/* Reset Layout is available in BOTH modes (Phase 11): one explicit
           * action back to the deterministic collision-free defaults. */}
          <PixelButton
            size="sm"
            variant="secondary"
            onClick={() => setResetConfirmOpen(true)}
            disabled={available.length === 0}
          >
            <PixelIcon name="refresh" /> Reset Layout
          </PixelButton>
          {editMode ? (
            <PixelButton size="sm" onClick={() => void finishEditing()}>
              Done
            </PixelButton>
          ) : (
            <PixelButton size="sm" onClick={startEditing} disabled={available.length === 0}>
              <PixelIcon name="grip" /> Edit Layout
            </PixelButton>
          )}
        </div>
      </header>
      {resetConfirmOpen ? (
        <ConfirmDialog
          title="Reset dashboard layout?"
          message="This restores default widget positions and sizes."
          confirmLabel="Reset Layout"
          onConfirm={() => void performReset()}
          onCancel={() => setResetConfirmOpen(false)}
        />
      ) : null}
      {saveError && (
        <StatusMessage tone="error">
          <p>Layout save failed: {saveError}</p>
        </StatusMessage>
      )}
      {visible.length === 0 && hidden.length === 0 ? (
        <EmptyState
          icon="apps"
          title="No widgets available"
          description="Enable apps in the App Center to populate the dashboard."
          action={
            <Link to="/apps" className="px-button px-button--primary px-button--md">
              Open App Center
            </Link>
          }
        />
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <div
            ref={canvasRef}
            className={`dashboard-canvas${editMode ? " dashboard-canvas--editing" : ""}`}
            style={canvasStyle}
            data-desktop={desktop ? "true" : undefined}
          >
            {activeDrag && (
              <div
                className={`dashboard-drop-ghost${activeDrag.valid ? "" : " dashboard-drop-ghost--invalid"}`}
                style={{
                  left: `${activeDrag.candidate.x * GRID_SIZE}px`,
                  top: `${activeDrag.candidate.y * GRID_SIZE}px`,
                  width: `${(activeDrag.candidate.w ?? defaultsOf(activeDrag.key).w) * GRID_SIZE}px`,
                  height: `${(activeDrag.candidate.h ?? defaultsOf(activeDrag.key).h) * GRID_SIZE}px`,
                }}
                aria-hidden="true"
              />
            )}
            {visible.map((resolved) => {
              const key = widgetKey(resolved);
              const context = renderContextFor(key);
              const resizing = activeResize?.key === key ? activeResize : null;
              return (
                <ErrorBoundary
                  key={key}
                  fallback={
                    <DashboardCard
                      resolved={resolved}
                      editMode={editMode}
                      desktop={desktop}
                      placement={items[key] ?? { x: 0, y: 0 }}
                      size={sizeOfItem(key)}
                      density={context.layout.density}
                      onNavigate={openWidget}
                      errorFallback
                    >
                      <p className="dashboard-widget-error">Widget failed to render.</p>
                    </DashboardCard>
                  }
                >
                  <DashboardCard
                    resolved={resolved}
                    editMode={editMode}
                    desktop={desktop}
                    accent={presentations.get(resolved.appId)?.accent}
                    placement={items[key] ?? { x: 0, y: 0 }}
                    size={sizeOfItem(key)}
                    density={context.layout.density}
                    resizing={resizing ? { valid: resizing.valid } : undefined}
                    dragLocked={activeResize !== null}
                    resizeLocked={activeDrag !== null}
                    onResizeStart={onResizeStart}
                    onResizeMove={onResizeMove}
                    onResizeEnd={onResizeEnd}
                    onResizeKeyDown={onResizeKeyDown}
                    onNavigate={openWidget}
                    onHide={editMode ? () => hideWidget(key) : undefined}
                    dropInvalid={activeDrag?.key === key && !activeDrag.valid}
                  >
                    {resolved.widget.render(context)}
                  </DashboardCard>
                </ErrorBoundary>
              );
            })}
          </div>
        </DndContext>
      )}

      {editMode ? (
        <section className="dashboard-hidden" aria-label="Hidden widgets">
          {hidden.length === 0 ? (
            <span>No hidden widgets.</span>
          ) : (
            <>
              <span>Hidden widgets:</span>
              <span className="px-chips">
                {hidden.map((resolved) => (
                  <button
                    key={widgetKey(resolved)}
                    type="button"
                    className="px-chip"
                    onClick={() => showWidget(widgetKey(resolved))}
                  >
                    <PixelIcon name="eyeOff" />
                    <span>{resolved.widget.title}</span>
                    <span className="px-chip__count">Show</span>
                  </button>
                ))}
              </span>
            </>
          )}
        </section>
      ) : hidden.length > 0 ? (
        <p className="dashboard-hidden">
          <span>{hidden.length} widget(s) hidden.</span>
        </p>
      ) : null}
    </div>
  );
}

interface DashboardCardProps {
  resolved: ResolvedWidget;
  editMode: boolean;
  desktop: boolean;
  placement: DashboardWidgetPlacement;
  /** Effective card size in grid units (includes the live resize preview). */
  size: SizeUnits;
  density: WidgetDensity;
  resizing?: { valid: boolean };
  /** Global mutex (Phase 11): a live resize disables every drag handle. */
  dragLocked?: boolean;
  /** Global mutex (Phase 11): a live drag disables every resize handle. */
  resizeLocked?: boolean;
  onResizeStart?: (key: string, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onResizeMove?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onResizeEnd?: (commit: boolean) => void;
  onResizeKeyDown?: (key: string, event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onNavigate: (resolved: ResolvedWidget) => void;
  onHide?: () => void;
  accent?: ReturnType<typeof resolvePresentation>["accent"];
  dropInvalid?: boolean;
  errorFallback?: boolean;
  children: React.ReactNode;
}

/**
 * One dashboard card. Normal mode: the whole card navigates to the widget's
 * href (or app root). Edit mode on desktop: free dragging happens ONLY
 * through the explicit grip handle in the window header, and resizing ONLY
 * through the bottom-right grip — card clicks and widget content stay
 * unaffected (FP-5.2/FP-5.3). Position and size come from the grid
 * placement, never from DOM order or measured content.
 */
function DashboardCard({
  resolved,
  editMode,
  desktop,
  placement,
  size,
  density,
  resizing,
  dragLocked,
  resizeLocked,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onResizeKeyDown,
  onNavigate,
  onHide,
  accent,
  dropInvalid,
  errorFallback,
  children,
}: DashboardCardProps) {
  const key = widgetKey(resolved);
  const isResizing = resizing !== undefined;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: key,
    disabled: !editMode || !desktop || isResizing || dragLocked,
  });

  const interactive = editMode || errorFallback;
  const style: CSSProperties = desktop
    ? {
        left: `${placement.x * GRID_SIZE}px`,
        top: `${placement.y * GRID_SIZE}px`,
        width: `${size.w * GRID_SIZE}px`,
        height: `${size.h * GRID_SIZE}px`,
        ...(isDragging && transform ? { transform: CSS.Translate.toString(transform) } : {}),
      }
    : {};

  const card = (
    <PixelWindow
      title={resolved.widget.title}
      icon={errorFallback ? "warning" : appIconName(resolved.appId)}
      accent={errorFallback ? "danger" : accent}
      data-widget-key={key}
      headerPrefix={
        editMode && !errorFallback ? (
          <button
            type="button"
            className="drag-handle"
            aria-label={`Move ${resolved.widget.title}`}
            {...attributes}
            {...listeners}
          >
            <PixelIcon name="grip" />
          </button>
        ) : undefined
      }
      actions={
        onHide ? (
          <PixelButton size="sm" variant="ghost" onClick={onHide} aria-label={`Hide ${resolved.widget.title}`}>
            <PixelIcon name="eyeOff" />
          </PixelButton>
        ) : undefined
      }
    >
      {children}
    </PixelWindow>
  );

  const classes = [
    "dashboard-card",
    isDragging ? "dashboard-card--dragging" : "",
    isDragging && dropInvalid ? "dashboard-card--drop-invalid" : "",
    isResizing ? "dashboard-card--resizing" : "",
    isResizing && !resizing!.valid ? "dashboard-card--resize-invalid" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={setNodeRef}
      className={classes}
      style={style}
      data-widget={key}
      data-density={density}
    >
      {interactive ? (
        card
      ) : (
        <div
          role="button"
          tabIndex={0}
          className="dashboard-card__hit"
          aria-label={`Open ${resolved.widget.title}`}
          onClick={(event) => {
            if (isInteractiveTarget(event.target)) return;
            onNavigate(resolved);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            // Same guard as the click path (FP-14.1): Enter/Space pressed on
            // an inner control (hide button, drag handle) must not also
            // navigate to the app.
            if (isInteractiveTarget(event.target)) return;
            event.preventDefault();
            onNavigate(resolved);
          }}
        >
          {card}
        </div>
      )}
      {isResizing ? (
        <span className="dashboard-resize-badge" aria-hidden="true">
          {size.w} × {size.h}
        </span>
      ) : null}
      {editMode && desktop && !errorFallback && onResizeStart && onResizeMove && onResizeEnd && onResizeKeyDown ? (
        <>
          {/* Current size announced on focus (a button role carries no value
           * semantics, so the state lives in the described-by text). */}
          <span id={`resize-status-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`} className="visually-hidden">
            {size.w} by {size.h} grid units
          </span>
          <button
            type="button"
            className="resize-handle"
            aria-label={`Resize ${resolved.widget.title}`}
            aria-describedby={`resize-status-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`}
            disabled={resizeLocked}
            onPointerDown={(event) => onResizeStart(key, event)}
            onPointerMove={(event) => onResizeMove(event)}
            onPointerUp={() => onResizeEnd(true)}
            onPointerCancel={() => onResizeEnd(false)}
            onKeyDown={(event) => onResizeKeyDown(key, event)}
          />
        </>
      ) : null}
    </div>
  );
}
