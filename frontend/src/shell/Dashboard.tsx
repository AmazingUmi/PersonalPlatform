import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
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
import { resolvePresentation, type PresentationOverrides } from "../shared/presentation";
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
  normalizeMeasuredSize,
  parseDashboardLayout,
  rectForPlacement,
  rectIsFree,
  resolveEffectiveLayout,
  serializeLayout,
  snapToGrid,
  sortForMobile,
  type DashboardLayoutV2,
  type DashboardWidgetPlacement,
  type ParsedDashboardLayout,
  type WidgetSize,
} from "./dashboardLayout";
import { enabledAppModules, resolveWidgets, type ResolvedWidget } from "./routes";

const LAYOUT_KEY = "dashboard.widgets";
const widgetKey = (widget: ResolvedWidget) => `${widget.appId}:${widget.widget.id}`;

/** Interactive descendants must not trigger card navigation (FP-5.2). */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, a, input, select, textarea, label") !== null;
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

/**
 * Dashboard is a pure widget container: widgets come from enabled frontend
 * app modules. The desktop canvas gives every widget an independent 2D grid
 * position (Dashboard Free Layout V2) persisted in core.settings under
 * "dashboard.widgets" as `{version: 2, items, hidden}`; legacy values (a
 * plain widget-key array) migrate on read. Narrow viewports fall back to the
 * normal flow grid.
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
  const [draft, setDraft] = useState<{ items: Record<string, DashboardWidgetPlacement>; hidden: string[] } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Record<string, WidgetSize>>({});
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [activeDrag, setActiveDrag] = useState<DragPreview | null>(null);
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

  const saveLayout = useCallback(async (layout: DashboardLayoutV2) => {
    setSaveError(null);
    try {
      await putSetting(LAYOUT_KEY, layout);
      setParsed({ kind: "v2", items: layout.items, hidden: layout.hidden });
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, []);

  const availableKeys = useMemo(() => available.map(widgetKey), [available]);
  const byKey = useMemo(() => new Map(available.map((widget) => [widgetKey(widget), widget])), [available]);
  const sizeOf = useCallback((key: string) => sizes[key] ?? normalizeMeasuredSize(0, 0), [sizes]);

  // Effective (persisted) layout: saved placements + runtime auto-placement
  // for widgets that are neither placed nor hidden.
  const effective = useMemo(
    () => (parsed === "loading" ? null : resolveEffectiveLayout(parsed, availableKeys, sizes, canvasWidth)),
    [parsed, availableKeys, sizes, canvasWidth],
  );

  // Edit mode works on a draft snapshot that is persisted on Done.
  const items = editMode && draft ? draft.items : (effective?.items ?? {});
  const hiddenKeys = editMode && draft ? draft.hidden : (effective?.hidden ?? []);
  // DOM order is always the (y, x) reading order — it must never decide the
  // desktop visual position (that comes from each widget's placement).
  const orderedKeys = useMemo(() => sortForMobile(items), [items]);
  const orderSignature = orderedKeys.join(",");
  const visible = orderedKeys.flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : []));

  // ---------- canvas + card measurement ----------
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const cardNodes = useRef(new Map<string, HTMLElement>());
  const registerCardNode = useCallback((key: string, node: HTMLElement | null) => {
    if (node) cardNodes.current.set(key, node);
    else cardNodes.current.delete(key);
  }, []);

  const measure = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      const width = canvas.getBoundingClientRect().width;
      setCanvasWidth((prev) => (Math.abs(prev - width) < 0.5 ? prev : width));
    }
    const measured: Record<string, WidgetSize> = {};
    for (const [key, node] of cardNodes.current) {
      const rect = node.getBoundingClientRect();
      measured[key] = normalizeMeasuredSize(rect.width, rect.height);
    }
    setSizes((prev) => {
      let changed = false;
      for (const [key, size] of Object.entries(measured)) {
        const before = prev[key];
        if (!before || before.width !== size.width || before.height !== size.height) {
          changed = true;
          break;
        }
      }
      return changed ? { ...prev, ...measured } : prev;
    });
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, orderSignature, editMode, desktop]);

  useEffect(() => {
    if (!desktop) return;
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [desktop, measure]);

  // ---------- free-layout drag ----------
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: gridKeyboardCoordinateGetter }),
  );

  /** Snap + clamp the origin-plus-delta position and collision-check it. */
  const evaluateCandidate = useCallback(
    (key: string, origin: DashboardWidgetPlacement, deltaPx: { x: number; y: number }) => {
      const size = sizeOf(key);
      const raw = {
        x: snapToGrid(origin.x * GRID_SIZE + deltaPx.x),
        y: snapToGrid(origin.y * GRID_SIZE + deltaPx.y),
      };
      const placement = clampPlacement(raw, size, canvasWidth);
      const others = Object.entries(items)
        .filter(([otherKey]) => otherKey !== key)
        .map(([otherKey, other]) => rectForPlacement(other, sizeOf(otherKey)));
      return { placement, valid: rectIsFree(rectForPlacement(placement, size), others) };
    },
    [items, sizeOf, canvasWidth],
  );

  const onDragStart = (event: DragStartEvent) => {
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
    const origin = items[key];
    if (origin) {
      const { placement, valid } = evaluateCandidate(key, origin, event.delta);
      // Invalid drops (overlap / out of bounds) revert to the origin; valid
      // drops move ONLY the dragged widget — never any other card.
      if (valid && (placement.x !== origin.x || placement.y !== origin.y)) {
        setDraft((current) =>
          current ? { ...current, items: { ...current.items, [key]: placement } } : current,
        );
      }
    }
    setActiveDrag(null);
  };

  const onDragCancel = () => setActiveDrag(null);

  // ---------- edit mode actions ----------
  const startEditing = () => {
    if (!effective) return;
    setDraft({ items: { ...effective.items }, hidden: [...effective.hidden] });
    setEditMode(true);
  };

  const finishEditing = async () => {
    if (!draft) return;
    if (await saveLayout(serializeLayout(draft.items, draft.hidden))) setEditMode(false);
  };

  const restoreDefault = async () => {
    const defaultItems = generateDefaultLayout(
      availableKeys.map((key) => ({ key, size: sizeOf(key) })),
      canvasWidth,
    );
    if (editMode) {
      setDraft({ items: defaultItems, hidden: [] });
    } else {
      await saveLayout(serializeLayout(defaultItems, []));
    }
  };

  const hideWidget = (key: string) => {
    setDraft((current) => {
      if (!current) return current;
      const { [key]: _removed, ...rest } = current.items;
      return { items: rest, hidden: [...current.hidden, key] };
    });
  };

  const showWidget = (key: string) => {
    setDraft((current) => {
      if (!current) return current;
      const size = sizeOf(key);
      const occupied = Object.entries(current.items).map(([otherKey, other]) =>
        rectForPlacement(other, sizeOf(otherKey)),
      );
      const placement = clampPlacement(findFirstFreePosition(size, occupied, canvasWidth), size, canvasWidth);
      return { items: { ...current.items, [key]: placement }, hidden: current.hidden.filter((k) => k !== key) };
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

  // Canvas height follows the lowest card (and the live drop preview) so the
  // canvas grows downwards instead of clipping low drops.
  const cardRects = orderedKeys.map((key) => rectForPlacement(items[key]!, sizeOf(key)));
  const previewRect =
    activeDrag && items[activeDrag.key]
      ? rectForPlacement(activeDrag.candidate, sizeOf(activeDrag.key))
      : null;
  const canvasHeight = canvasHeightFor(previewRect ? [...cardRects, previewRect] : cardRects);
  const canvasStyle: CSSProperties | undefined = desktop ? { height: `${canvasHeight}px` } : undefined;

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">Dashboard</h1>
        <p className="page-header__subtitle">System overview</p>
        <div className="page-header__actions">
          {editMode ? (
            <>
              <PixelButton size="sm" variant="secondary" onClick={() => void restoreDefault()}>
                Restore default
              </PixelButton>
              <PixelButton size="sm" onClick={() => void finishEditing()}>
                Done
              </PixelButton>
            </>
          ) : (
            <PixelButton size="sm" onClick={startEditing} disabled={available.length === 0}>
              <PixelIcon name="grip" /> Edit Layout
            </PixelButton>
          )}
        </div>
      </header>
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
                  width: `${sizeOf(activeDrag.key).width}px`,
                  height: `${sizeOf(activeDrag.key).height}px`,
                }}
                aria-hidden="true"
              />
            )}
            {visible.map((resolved) => (
              <ErrorBoundary
                key={widgetKey(resolved)}
                fallback={
                  <DashboardCard
                    resolved={resolved}
                    editMode={editMode}
                    desktop={desktop}
                    placement={items[widgetKey(resolved)] ?? { x: 0, y: 0 }}
                    registerNode={registerCardNode}
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
                  placement={items[widgetKey(resolved)] ?? { x: 0, y: 0 }}
                  registerNode={registerCardNode}
                  onNavigate={openWidget}
                  dropInvalid={activeDrag?.key === widgetKey(resolved) && !activeDrag.valid}
                  onHide={editMode ? () => hideWidget(widgetKey(resolved)) : undefined}
                >
                  {resolved.widget.render()}
                </DashboardCard>
              </ErrorBoundary>
            ))}
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
          <PixelButton variant="ghost" size="sm" onClick={() => void restoreDefault()}>
            Restore default layout
          </PixelButton>
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
  registerNode: (key: string, node: HTMLElement | null) => void;
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
 * through the explicit grip handle in the window header, so card clicks and
 * widget content stay unaffected (FP-5.2/FP-5.3). The card's visual position
 * comes from its grid placement, never from DOM order.
 */
function DashboardCard({
  resolved,
  editMode,
  desktop,
  placement,
  registerNode,
  onNavigate,
  onHide,
  accent,
  dropInvalid,
  errorFallback,
  children,
}: DashboardCardProps) {
  const key = widgetKey(resolved);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: key,
    disabled: !editMode || !desktop,
  });

  const interactive = editMode || errorFallback;
  const style: CSSProperties = desktop
    ? {
        left: `${placement.x * GRID_SIZE}px`,
        top: `${placement.y * GRID_SIZE}px`,
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
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        registerNode(key, node);
      }}
      className={classes}
      style={style}
      data-widget={key}
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
    </div>
  );
}
