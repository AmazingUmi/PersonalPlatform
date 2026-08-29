import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
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
import { enabledAppModules, resolveWidgets, type ResolvedWidget } from "./routes";

const LAYOUT_KEY = "dashboard.widgets";
const widgetKey = (widget: ResolvedWidget) => `${widget.appId}:${widget.widget.id}`;

/** Interactive descendants must not trigger card navigation (FP-5.2). */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, a, input, select, textarea, label") !== null;
}

/**
 * Dashboard is a pure widget container: widgets come from enabled frontend
 * app modules; the visible set and its ORDER are persisted in core.settings
 * under "dashboard.widgets" (default: every available widget in module order).
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

  const [layout, setLayout] = useState<string[] | null | "loading">("loading");
  const [editMode, setEditMode] = useState(false);
  const [draftOrder, setDraftOrder] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getSetting<string[]>(LAYOUT_KEY)
      .then((value) => {
        if (active) setLayout(Array.isArray(value) ? value : null);
      })
      .catch(() => {
        if (active) setLayout(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const saveLayout = useCallback(async (keys: string[]) => {
    setSaveError(null);
    try {
      await putSetting(LAYOUT_KEY, keys);
      setLayout(keys);
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, []);

  const availableKeys = useMemo(() => available.map(widgetKey), [available]);
  const visibleKeys = useMemo(() => {
    const saved = layout === "loading" ? null : layout;
    return (saved ?? availableKeys).filter((key: string) => availableKeys.includes(key));
  }, [layout, availableKeys]);
  // In edit mode the hidden list must reflect the working draft, not the
  // currently persisted layout, so Hide/Show update it immediately.
  const hiddenKeys = useMemo(
    () => availableKeys.filter((key) => !(editMode ? draftOrder : visibleKeys).includes(key)),
    [availableKeys, editMode, draftOrder, visibleKeys],
  );

  const byKey = useMemo(() => new Map(available.map((widget) => [widgetKey(widget), widget])), [available]);
  // FP-5.1: widgets render in the persisted order, not in module registration
  // order. Edit mode works on a draft copy that is persisted on Done.
  const orderKeys = editMode ? draftOrder : visibleKeys;
  const visible = orderKeys.flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : []));

  const startEditing = () => {
    setDraftOrder(visibleKeys);
    setEditMode(true);
  };

  const finishEditing = async () => {
    if (await saveLayout(draftOrder)) setEditMode(false);
  };

  const restoreDefault = async () => {
    if (editMode) {
      setDraftOrder(availableKeys);
    } else {
      await saveLayout(availableKeys);
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setDraftOrder((current) => {
      const oldIndex = current.indexOf(String(active.id));
      const newIndex = current.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0) return current;
      return arrayMove(current, oldIndex, newIndex);
    });
  };

  const openWidget = (resolved: ResolvedWidget) => {
    navigate(resolved.widget.href ?? routesById.get(resolved.appId) ?? "/");
  };

  if (layout === "loading") {
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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={orderKeys} strategy={rectSortingStrategy}>
            <div className="dashboard-grid">
              {visible.map((resolved) => (
                <ErrorBoundary
                  key={widgetKey(resolved)}
                  fallback={
                    <SortableCard
                      resolved={resolved}
                      editMode={editMode}
                      onNavigate={openWidget}
                      errorFallback
                    >
                      <p className="dashboard-widget-error">Widget failed to render.</p>
                    </SortableCard>
                  }
                >
                  <SortableCard
                    resolved={resolved}
                    editMode={editMode}
                    accent={presentations.get(resolved.appId)?.accent}
                    onNavigate={openWidget}
                    onHide={
                      editMode
                        ? () => setDraftOrder((current) => current.filter((key) => key !== widgetKey(resolved)))
                        : undefined
                    }
                  >
                    {resolved.widget.render()}
                  </SortableCard>
                </ErrorBoundary>
              ))}
            </div>
          </SortableContext>
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
                    onClick={() => setDraftOrder((current) => [...current, widgetKey(resolved)])}
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

interface SortableCardProps {
  resolved: ResolvedWidget;
  editMode: boolean;
  accent?: ReturnType<typeof resolvePresentation>["accent"];
  onNavigate: (resolved: ResolvedWidget) => void;
  onHide?: () => void;
  errorFallback?: boolean;
  children: React.ReactNode;
}

/**
 * One dashboard card. Normal mode: the whole card navigates to the widget's
 * href (or app root). Edit mode: dragging happens ONLY through the explicit
 * grip handle in the window header, so card clicks and widget content stay
 * unaffected (FP-5.2/FP-5.3).
 */
function SortableCard({
  resolved,
  editMode,
  accent,
  onNavigate,
  onHide,
  errorFallback,
  children,
}: SortableCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: widgetKey(resolved),
    disabled: !editMode,
  });

  const interactive = editMode || errorFallback;
  const card = (
    <PixelWindow
      title={resolved.widget.title}
      icon={errorFallback ? "warning" : appIconName(resolved.appId)}
      accent={errorFallback ? "danger" : accent}
      data-widget-key={widgetKey(resolved)}
      headerPrefix={
        editMode && !errorFallback ? (
          <button
            type="button"
            className="drag-handle"
            aria-label={`Reorder ${resolved.widget.title}`}
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

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`dashboard-card${isDragging ? " dashboard-card--dragging" : ""}`}
      data-widget={widgetKey(resolved)}
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
