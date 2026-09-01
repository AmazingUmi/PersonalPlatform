import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../shared/api";
import { useAppDisplayName } from "../../shared/PresentationContext";
import { ACCENT_OPTIONS } from "../../shared/presentation";
import type { FrontendAppModule, WidgetDensity } from "../../shared/appTypes";
import { useDebouncedValue } from "../../shared/useDebouncedValue";
import { useMutation } from "../../shared/useMutation";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { EmptyState } from "../../shared/ui/EmptyState";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelBadge } from "../../shared/ui/PixelBadge";
import { PixelButton } from "../../shared/ui/PixelButton";
import { PixelIcon } from "../../shared/ui/PixelIcon";
import { PixelInput } from "../../shared/ui/PixelInput";
import type { PixelAccent } from "../../shared/ui/PixelWindow";
import { PixelWindow } from "../../shared/ui/PixelWindow";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { useAsync } from "../../shared/useAsync";

interface Category {
  id: string;
  name: string;
  color: string | null;
}

interface Item {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  acquiredAt: string | null;
  targetLocation: string | null;
  createdAt: string;
  updatedAt: string;
  /** Categories ordered by name (server-side); empty = uncategorized. */
  categories: Category[];
}

interface Attachment {
  id: string;
  itemId: string;
  filename: string;
  contentType: string | null;
  size: number;
}

/** GET /items also returns faceted counts (worklist §2.4). */
interface ItemsListResponse {
  items: Item[];
  counts: {
    all: number;
    categories: Record<string, number>;
  };
}

const SORT_OPTIONS = [
  { value: "createdAt", label: "Added" },
  { value: "updatedAt", label: "Modified" },
  { value: "name", label: "Name" },
  { value: "quantity", label: "Quantity" },
  { value: "acquiredAt", label: "Acquired" },
  { value: "targetLocation", label: "Location" },
] as const;

/** Category badges clamped on cards (detail shows all). */
const CATEGORY_BADGE_LIMIT = 3;

/** API color string -> PixelBadge accent (undefined = neutral fallback). */
function accentOf(color: string | null | undefined): PixelAccent | undefined {
  return color ? (color as PixelAccent) : undefined;
}

/** `categories` URL param: comma-separated category ids (notes `tags` precedent). */
function parseCategoryIds(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
}

/** Same set of ids regardless of order (categoryIds are an unordered set). */
function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

/** Build the items query string from the current URL search params. */
function itemsQueryString(params: URLSearchParams): string {
  const query = new URLSearchParams();
  for (const key of ["q", "categories", "targetLocation", "acquiredAfter", "acquiredBefore", "createdAfter", "createdBefore", "sortBy", "order"]) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** Filter keys that count towards the collapsed Filters-button badge. */
const ASSETS_FILTER_KEYS = ["q", "categories", "targetLocation", "acquiredAfter", "acquiredBefore", "createdAfter", "createdBefore"];

function countActiveFilters(params: URLSearchParams, keys: string[]): number {
  return keys.reduce((count, key) => (params.get(key) ? count + 1 : count), 0);
}

interface ItemEditorState {
  name: string;
  description: string;
  quantity: string;
  categoryIds: string[];
  acquiredAt: string;
  targetLocation: string;
}

function emptyEditorState(): ItemEditorState {
  return { name: "", description: "", quantity: "1", categoryIds: [], acquiredAt: "", targetLocation: "" };
}

function editorStateFromItem(item: Item): ItemEditorState {
  return {
    name: item.name,
    description: item.description ?? "",
    quantity: String(item.quantity),
    categoryIds: item.categories.map((category) => category.id),
    acquiredAt: item.acquiredAt ?? "",
    targetLocation: item.targetLocation ?? "",
  };
}

/** Create/edit item modal (FP-3.3). Empty string fields are omitted on create,
 * sent as null on edit so nullable columns can be cleared. Categories are a
 * multi-select chip group (worklist §4.3). */
function ItemEditor({
  item,
  categories,
  onClose,
  onSaved,
}: {
  item: Item | null;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ItemEditorState>(() =>
    item ? editorStateFromItem(item) : emptyEditorState(),
  );
  const set = <K extends keyof ItemEditorState>(key: K, value: ItemEditorState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const toggleCategory = (categoryId: string) =>
    setForm((current) => ({
      ...current,
      categoryIds: current.categoryIds.includes(categoryId)
        ? current.categoryIds.filter((id) => id !== categoryId)
        : [...current.categoryIds, categoryId],
    }));

  const save = useMutation(async () => {
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      description: form.description.trim() === "" ? null : form.description.trim(),
      quantity: Number(form.quantity) || 0,
      acquiredAt: form.acquiredAt === "" ? null : form.acquiredAt,
      targetLocation: form.targetLocation.trim() === "" ? null : form.targetLocation.trim(),
    };
    // Create always sends the set (possibly empty); edit uses the PATCH
    // three-state semantics — absent = keep, [] = clear, list = replace —
    // so an unchanged set is simply omitted (notes tagIds precedent).
    if (!item || !sameIdSet(form.categoryIds, item.categories.map((category) => category.id))) {
      body.categoryIds = form.categoryIds;
    }
    if (item) {
      await api(`/api/apps/assets/items/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } else {
      await api("/api/apps/assets/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || save.busy) return;
    if (await save.mutate()) onSaved();
  };

  return (
    <div className="px-dialog-backdrop" role="presentation">
      <PixelWindow
        title={item ? "Edit Item" : "New Item"}
        icon="box"
        className="px-dialog px-dialog--form"
        data-testid="item-editor"
      >
        <form className="px-form" onSubmit={submit} aria-label={item ? "Edit item" : "Create item"}>
          <label className="px-form__row">
            <span className="px-form__label">Name</span>
            <PixelInput
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              aria-label="Item name"
              required
              autoFocus
            />
          </label>
          <label className="px-form__row">
            <span className="px-form__label">Description</span>
            <textarea
              className="px-textarea"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              aria-label="Item description"
            />
          </label>
          <div className="px-form__row">
            <span className="px-form__label">Quantity</span>
            <PixelInput
              type="number"
              min={0}
              value={form.quantity}
              onChange={(e) => set("quantity", e.target.value)}
              aria-label="Quantity"
            />
          </div>
          <div className="px-form__row">
            <span className="px-form__label">Category</span>
            {categories.length > 0 ? (
              <div className="assets-editor__categories">
                {categories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className="px-chip"
                    aria-pressed={form.categoryIds.includes(category.id)}
                    aria-label={`Toggle category ${category.name}`}
                    onClick={() => toggleCategory(category.id)}
                  >
                    {category.color ? (
                      <span className="px-cat-dot" data-accent={category.color} aria-hidden="true" />
                    ) : null}
                    <span>{category.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="px-form__hint">No categories yet — add one below the category chips first.</p>
            )}
          </div>
          <div className="px-form__grid">
            <label className="px-form__row">
              <span className="px-form__label">Acquired date</span>
              <PixelInput
                type="date"
                value={form.acquiredAt}
                onChange={(e) => set("acquiredAt", e.target.value)}
                aria-label="Acquired date"
              />
            </label>
            <label className="px-form__row">
              <span className="px-form__label">Location</span>
              <PixelInput
                value={form.targetLocation}
                onChange={(e) => set("targetLocation", e.target.value)}
                aria-label="Target location"
                placeholder="e.g. shelf-a"
              />
            </label>
          </div>
          <p className="px-form__hint">
            Acquired date is optional — fill it in when you got the item (purchase, gift, …).
            The intake time is recorded automatically.
          </p>
          {save.error ? (
            <StatusMessage tone="error">
              <p>{save.error}</p>
            </StatusMessage>
          ) : null}
          <div className="px-dialog__actions">
            <PixelButton variant="secondary" size="sm" onClick={onClose} disabled={save.busy}>
              Cancel
            </PixelButton>
            <PixelButton type="submit" size="sm" disabled={!form.name.trim() || save.busy}>
              {save.busy ? "Saving…" : item ? "Save changes" : "Create item"}
            </PixelButton>
          </div>
        </form>
      </PixelWindow>
    </div>
  );
}

/** Edit category dialog (FP: manageability): rename + presentation color.
 * Empty color = back to the default look (sent as explicit null). */
function EditCategoryDialog({
  category,
  onClose,
  onSaved,
}: {
  category: Category;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [color, setColor] = useState<string>(category.color ?? "");
  const save = useMutation(async () => {
    await api(`/api/apps/assets/categories/${category.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), color: color === "" ? null : color }),
    });
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || save.busy) return;
    if (await save.mutate()) onSaved();
  };

  return (
    <div className="px-dialog-backdrop" role="presentation">
      <PixelWindow title="Edit Category" icon="palette" className="px-dialog px-dialog--form">
        <form className="px-form" onSubmit={submit} aria-label="Edit category">
          <label className="px-form__row">
            <span className="px-form__label">Name</span>
            <PixelInput value={name} onChange={(e) => setName(e.target.value)} aria-label="Category name" autoFocus />
          </label>
          <label className="px-form__row">
            <span className="px-form__label">Color</span>
            <select
              className="px-select"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label="Category color"
            >
              <option value="">Default</option>
              {ACCENT_OPTIONS.map((accent) => (
                <option key={accent} value={accent}>
                  {accent}
                </option>
              ))}
            </select>
          </label>
          <span className="px-cat-dot px-cat-dot--preview" data-accent={(color || category.color) ?? ""} aria-hidden="true" />
          {save.error ? (
            <StatusMessage tone="error">
              <p>{save.error}</p>
            </StatusMessage>
          ) : null}
          <div className="px-dialog__actions">
            <PixelButton variant="secondary" size="sm" onClick={onClose} disabled={save.busy}>
              Cancel
            </PixelButton>
            <PixelButton type="submit" size="sm" disabled={!name.trim() || save.busy}>
              {save.busy ? "Saving…" : "Save"}
            </PixelButton>
          </div>
        </form>
      </PixelWindow>
    </div>
  );
}

function AssetsPage() {
  const displayName = useAppDisplayName({ id: "assets", name: "Assets" });
  const [searchParams, setSearchParams] = useSearchParams();
  const [reloadKey, setReloadKey] = useState(0);
  const [editorFor, setEditorFor] = useState<Item | null | undefined>(undefined);
  const [categoryEdit, setCategoryEdit] = useState<Category | null>(null);
  const [categoryDelete, setCategoryDelete] = useState<Category | null>(null);
  // The "Manage category" button reveals that chip's inline tools; one at a time.
  const [openCategoryId, setOpenCategoryId] = useState<string | null>(null);
  // Filters collapse into a header button; a deep link with active filters
  // starts expanded.
  const [filtersOpen, setFiltersOpen] = useState(
    () => countActiveFilters(new URLSearchParams(window.location.search), ASSETS_FILTER_KEYS) > 0,
  );

  const refresh = () => setReloadKey((key) => key + 1);
  const setParam = (key: string, value: string) => {
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };

  // Search input is debounced before it reaches the URL (FP-3.5).
  const rawSearch = searchParams.get("q") ?? "";
  const [searchInput, setSearchInput] = useState(rawSearch);
  const debouncedSearch = useDebouncedValue(searchInput, 250);
  const appliedSearch = searchParams.get("q") ?? "";
  useEffect(() => {
    if (debouncedSearch !== appliedSearch) setParam("q", debouncedSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);
  // Keep the input in sync when navigation (back/forward/deep link) changes q.
  useEffect(() => {
    setSearchInput(rawSearch);
  }, [rawSearch]);

  const selectedCategoryIds = parseCategoryIds(searchParams.get("categories"));
  const sortBy = searchParams.get("sortBy") ?? "createdAt";
  const order = searchParams.get("order") ?? "desc";

  /** Toggle one category id in the URL `categories` set (worklist §4.1/4.2). */
  const toggleCategoryFilter = (categoryId: string) => {
    const next = selectedCategoryIds.includes(categoryId)
      ? selectedCategoryIds.filter((id) => id !== categoryId)
      : [...selectedCategoryIds, categoryId];
    setParam("categories", next.join(","));
  };

  const items = useAsync(
    () => api<ItemsListResponse>(`/api/apps/assets/items${itemsQueryString(searchParams)}`),
    [searchParams.toString(), reloadKey],
  );
  const categories = useAsync(() => api<{ items: Category[] }>("/api/apps/assets/categories"), [reloadKey]);

  const newCategory = useMutation(async () => {
    const name = newCategoryName.trim();
    if (!name) return;
    await api("/api/apps/assets/categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
  });
  const [newCategoryName, setNewCategoryName] = useState("");

  const deleteCategory = useMutation(async () => {
    if (!categoryDelete) return;
    await api(`/api/apps/assets/categories/${categoryDelete.id}`, { method: "DELETE" });
  });

  const resetFilters = () => {
    setSearchParams(new URLSearchParams(), { replace: true });
    setSearchInput("");
  };

  const allItems = items.data?.items ?? [];
  const counts = items.data?.counts;
  const countForCategory = (id: string) => counts?.categories[id] ?? 0;
  const activeFilterCount = countActiveFilters(searchParams, ASSETS_FILTER_KEYS);
  const hasFilters = Boolean(itemsQueryString(searchParams));

  return (
    <div className="page" data-app="assets">
      <header className="page-header">
        <h1 className="page-header__title">{displayName}</h1>
        <p className="page-header__subtitle">Personal inventory</p>
        <div className="page-header__actions">
          <PixelButton
            size="sm"
            variant="secondary"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <PixelIcon name="search" /> Filters
            {activeFilterCount > 0 ? <PixelBadge tone="warning">{activeFilterCount}</PixelBadge> : null}
          </PixelButton>
          <PixelButton size="sm" onClick={() => setEditorFor(null)}>
            <PixelIcon name="plus" /> New Item
          </PixelButton>
        </div>
      </header>

      {filtersOpen ? (
      <PixelWindow title="Filters" icon="search" className="assets-filters" actions={
        <PixelButton variant="ghost" size="sm" onClick={resetFilters} disabled={activeFilterCount === 0}>
          Reset
        </PixelButton>
      }>
        <div className="assets-filters__row">
          <div className="assets-search">
            <PixelIcon name="search" />
            <PixelInput
              placeholder="Search name or category…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              aria-label="Search items"
            />
          </div>
          <PixelInput
            placeholder="Location"
            value={searchParams.get("targetLocation") ?? ""}
            onChange={(e) => setParam("targetLocation", e.target.value)}
            aria-label="Filter by location"
            className="assets-filters__location"
          />
        </div>
        <div className="assets-filters__row">
          <label className="assets-filters__date">
            <span>Acquired from</span>
            <PixelInput
              type="date"
              value={searchParams.get("acquiredAfter") ?? ""}
              onChange={(e) => setParam("acquiredAfter", e.target.value)}
              aria-label="Acquired after"
            />
          </label>
          <label className="assets-filters__date">
            <span>to</span>
            <PixelInput
              type="date"
              value={searchParams.get("acquiredBefore") ?? ""}
              onChange={(e) => setParam("acquiredBefore", e.target.value)}
              aria-label="Acquired before"
            />
          </label>
          <label className="assets-filters__date">
            <span>Added from</span>
            <PixelInput
              type="date"
              value={searchParams.get("createdAfter") ?? ""}
              onChange={(e) => setParam("createdAfter", e.target.value ? new Date(e.target.value).toISOString() : "")}
              aria-label="Added after"
            />
          </label>
          <label className="assets-filters__date">
            <span>to</span>
            <PixelInput
              type="date"
              value={searchParams.get("createdBefore") ?? ""}
              onChange={(e) => setParam("createdBefore", e.target.value ? new Date(e.target.value).toISOString() : "")}
              aria-label="Added before"
            />
          </label>
        </div>
        <div className="assets-filters__row">
          <select
            className="px-select"
            value={sortBy}
            onChange={(e) => setParam("sortBy", e.target.value)}
            aria-label="Sort by"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                Sort: {option.label}
              </option>
            ))}
          </select>
          <PixelButton
            size="sm"
            variant="secondary"
            onClick={() => setParam("order", order === "asc" ? "desc" : "asc")}
            aria-label={`Sort order: ${order}. Click to switch.`}
          >
            <PixelIcon name={order === "asc" ? "up" : "down"} />
            {order === "asc" ? "Asc" : "Desc"}
          </PixelButton>
          <span className="assets-filters__spacer" />
          <PixelButton size="sm" variant="secondary" onClick={() => setFiltersOpen(false)}>
            Close
          </PixelButton>
        </div>
      </PixelWindow>
      ) : null}

      <section className="assets-section" aria-labelledby="assets-categories">
        <h2 id="assets-categories" className="section-title">
          Categories
        </h2>
        <div className="px-chips">
          <button
            type="button"
            className="px-chip"
            aria-pressed={selectedCategoryIds.length === 0}
            aria-label="All categories"
            onClick={() => setParam("categories", "")}
          >
            <span>All</span>
            <span className="px-chip__count">{counts?.all ?? 0}</span>
          </button>
          {(categories.data?.items ?? []).map((category) => {
            const open = openCategoryId === category.id;
            return (
              <span key={category.id} className="px-chip-group">
                <button
                  type="button"
                  className="px-chip"
                  aria-pressed={selectedCategoryIds.includes(category.id)}
                  aria-label={`Filter by category ${category.name}`}
                  onClick={() => toggleCategoryFilter(category.id)}
                >
                  {category.color ? (
                    <span className="px-cat-dot" data-accent={category.color} aria-hidden="true" />
                  ) : null}
                  <span>{category.name}</span>
                  <span className="px-chip__count">{countForCategory(category.id)}</span>
                </button>
                <PixelButton
                  variant="ghost"
                  size="sm"
                  className="px-chip-manage"
                  aria-label={`Manage category ${category.name}`}
                  aria-expanded={open}
                  onClick={() => setOpenCategoryId(open ? null : category.id)}
                >
                  <PixelIcon name="menu" />
                </PixelButton>
                {open ? (
                  <span className="px-chip__tools">
                    <PixelButton
                      variant="ghost"
                      size="sm"
                      className="px-button--icon"
                      aria-label={`Rename category ${category.name}`}
                      onClick={() => setCategoryEdit(category)}
                    >
                      <PixelIcon name="edit" />
                    </PixelButton>
                    <PixelButton
                      variant="ghost"
                      size="sm"
                      className="px-button--icon"
                      aria-label={`Delete category ${category.name}`}
                      onClick={() => setCategoryDelete(category)}
                    >
                      <PixelIcon name="trash" />
                    </PixelButton>
                  </span>
                ) : null}
              </span>
            );
          })}
          <form
            className="category-add"
            aria-label="Add a category"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!newCategoryName.trim() || newCategory.busy) return;
              if (await newCategory.mutate()) {
                setNewCategoryName("");
                refresh();
              }
            }}
          >
            <PixelInput
              className="category-add__input"
              placeholder="New category"
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              aria-label="New category name"
            />
            <PixelButton
              type="submit"
              variant="secondary"
              size="sm"
              className="px-button--icon"
              aria-label="Add category"
              disabled={!newCategoryName.trim() || newCategory.busy}
            >
              <PixelIcon name="plus" />
            </PixelButton>
          </form>
        </div>
        {newCategory.error ? (
          <StatusMessage tone="error">
            <p>{newCategory.error}</p>
          </StatusMessage>
        ) : null}
      </section>

      <section className="assets-section" aria-labelledby="assets-inventory">
        <h2 id="assets-inventory" className="section-title">
          Inventory
        </h2>
        {items.loading ? (
          <LoadingState label="Loading items…" />
        ) : items.error ? (
          <StatusMessage tone="error">
            <p>{items.error}</p>
            <PixelButton size="sm" variant="secondary" onClick={items.reload}>
              Retry
            </PixelButton>
          </StatusMessage>
        ) : allItems.length === 0 && !hasFilters ? (
          <EmptyState
            icon="box"
            title="Your inventory is empty"
            description="Create the first item to start tracking your personal assets."
            action={
              <PixelButton size="sm" onClick={() => setEditorFor(null)}>
                <PixelIcon name="plus" /> New Item
              </PixelButton>
            }
          />
        ) : allItems.length === 0 ? (
          <EmptyState
            icon="search"
            title="No matching items"
            description="Try a different search term or clear the filters."
          />
        ) : (
          <ul className="inventory-grid">
            {allItems.map((item) => {
              const overflowCategories = item.categories.slice(CATEGORY_BADGE_LIMIT);
              return (
              <li key={item.id} className="inv-card">
                {item.categories.length > 0 ? (
                  <span className="inv-card__stripe" aria-hidden="true">
                    {item.categories.map((category) => (
                      <i
                        key={category.id}
                        className="inv-card__stripe-seg"
                        data-accent={accentOf(category.color)}
                      />
                    ))}
                  </span>
                ) : null}
                <Link to={`/assets/items/${item.id}`} className="inv-card__main">
                  <span className="inv-card__thumb" aria-hidden="true">
                    <PixelIcon name="box" size={32} />
                  </span>
                  <span className="inv-card__name">{item.name}</span>
                </Link>
                <div className="inv-card__foot">
                  <span className="inv-card__qty">×{item.quantity}</span>
                  <span className="inv-card__badges">
                    {item.categories.slice(0, CATEGORY_BADGE_LIMIT).map((category) => (
                      <PixelBadge key={category.id} accent={accentOf(category.color)}>
                        {category.name}
                      </PixelBadge>
                    ))}
                    {overflowCategories.length > 0 ? (
                      <PixelBadge title={overflowCategories.map((category) => category.name).join(", ")}>
                        {`+${overflowCategories.length}`}
                      </PixelBadge>
                    ) : null}
                    {item.targetLocation ? (
                      <PixelBadge tone="info">{item.targetLocation}</PixelBadge>
                    ) : null}
                  </span>
                </div>
              </li>
              );
            })}
          </ul>
        )}
      </section>

      {editorFor !== undefined ? (
        <ItemEditor
          item={editorFor}
          categories={categories.data?.items ?? []}
          onClose={() => setEditorFor(undefined)}
          onSaved={() => {
            setEditorFor(undefined);
            refresh();
          }}
        />
      ) : null}
      {categoryEdit ? (
        <EditCategoryDialog
          category={categoryEdit}
          onClose={() => setCategoryEdit(null)}
          onSaved={() => {
            setCategoryEdit(null);
            refresh();
          }}
        />
      ) : null}
      {categoryDelete ? (
        <ConfirmDialog
          title="Delete category"
          message={`Delete "${categoryDelete.name}"? Items keep their other categories; items that only have this one become uncategorized.`}
          busy={deleteCategory.busy}
          onCancel={() => setCategoryDelete(null)}
          onConfirm={async () => {
            if (await deleteCategory.mutate()) {
              setCategoryDelete(null);
              setOpenCategoryId(null);
              if (selectedCategoryIds.includes(categoryDelete.id)) {
                setParam(
                  "categories",
                  selectedCategoryIds.filter((id) => id !== categoryDelete.id).join(","),
                );
              }
              refresh();
            }
          }}
        />
      ) : null}
      {deleteCategory.error ? (
        <StatusMessage tone="error">
          <p>{deleteCategory.error}</p>
        </StatusMessage>
      ) : null}
    </div>
  );
}

/** Mirrors the backend upload cap (FP-12.2). */
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

function AssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [reloadKey, setReloadKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [attachmentDelete, setAttachmentDelete] = useState<Attachment | null>(null);

  const item = useAsync(() => api<Item>(`/api/apps/assets/items/${id}`), [id, reloadKey]);
  const categories = useAsync(() => api<{ items: Category[] }>("/api/apps/assets/categories"), [reloadKey]);
  const attachments = useAsync(
    () => api<{ items: Attachment[] }>(`/api/apps/assets/items/${id}/attachments`),
    [id, reloadKey],
  );

  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  const deleteItem = useMutation(async () => {
    await api(`/api/apps/assets/items/${id}`, { method: "DELETE" });
  });

  const deleteAttachment = useMutation(async () => {
    if (!attachmentDelete) return;
    await api(`/api/apps/assets/items/${id}/attachments/${attachmentDelete.id}`, { method: "DELETE" });
  });

  const upload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      if (file.size > ATTACHMENT_MAX_BYTES) {
        throw new Error(`${file.name} is larger than the 10 MB attachment limit`);
      }
      // Multipart upload (FP-12.2): no Base64 inflation, one streaming part.
      const form = new FormData();
      form.append("file", file, file.name);
      // Let the browser set content-type (it must include the boundary).
      await api(`/api/apps/assets/items/${id}/attachments`, {
        method: "POST",
        body: form,
      });
      refresh();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  };

  if (item.loading) {
    return (
      <div className="page" data-app="assets">
        <LoadingState label="Loading item…" />
      </div>
    );
  }
  if (item.error) {
    return (
      <div className="page" data-app="assets">
        <StatusMessage tone="error">
          <p>{item.error}</p>
          <PixelButton size="sm" variant="secondary" onClick={item.reload}>
            Retry
          </PixelButton>
        </StatusMessage>
      </div>
    );
  }

  const data = item.data!;

  return (
    <div className="page page--detail" data-app="assets">
      <Link to="/assets" className="back-link">
        <PixelIcon name="back" />
        Assets
      </Link>

      <PixelWindow
        title={data.name}
        icon="box"
        headingLevel={1}
        actions={
          <>
            <PixelButton size="sm" variant="secondary" onClick={() => setEditing(true)}>
              <PixelIcon name="edit" /> Edit
            </PixelButton>
            <PixelButton size="sm" variant="danger" onClick={() => setDeleting(true)}>
              <PixelIcon name="trash" /> Delete
            </PixelButton>
          </>
        }
      >
        <dl className="px-deflist">
          <div>
            <dt>Quantity</dt>
            <dd>×{data.quantity}</dd>
          </div>
          <div>
            <dt>Category</dt>
            <dd>
              {data.categories.length > 0 ? (
                <span className="asset-detail__categories">
                  {data.categories.map((category) => (
                    <PixelBadge key={category.id} accent={accentOf(category.color)}>
                      {category.name}
                    </PixelBadge>
                  ))}
                </span>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>Location</dt>
            <dd>{data.targetLocation ?? "—"}</dd>
          </div>
          <div>
            <dt>Acquired</dt>
            <dd>{data.acquiredAt ?? "—"}</dd>
          </div>
          <div>
            <dt>Added (auto)</dt>
            <dd>{formatTimestamp(data.createdAt)}</dd>
          </div>
          <div>
            <dt>Last modified</dt>
            <dd>{formatTimestamp(data.updatedAt)}</dd>
          </div>
        </dl>
        {data.description ? <p className="asset-detail__desc">{data.description}</p> : null}
        {deleteItem.error ? (
          <StatusMessage tone="error">
            <p>{deleteItem.error}</p>
          </StatusMessage>
        ) : null}
      </PixelWindow>

      <PixelWindow title="Attachments" icon="file">
        {(attachments.data?.items ?? []).length === 0 ? (
          <p className="muted">No attachments yet.</p>
        ) : (
          <ul className="attachment-list">
            {(attachments.data?.items ?? []).map((attachment) => (
              <li key={attachment.id} className="attachment-row">
                <PixelIcon name="file" />
                <a
                  className="attachment-row__name"
                  href={`/api/apps/assets/items/${id}/attachments/${attachment.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {attachment.filename}
                </a>
                <span className="attachment-row__size">{formatBytes(attachment.size)}</span>
                <PixelButton
                  variant="ghost"
                  size="sm"
                  className="px-button--icon"
                  aria-label={`Delete attachment ${attachment.filename}`}
                  onClick={() => setAttachmentDelete(attachment)}
                >
                  <PixelIcon name="trash" />
                </PixelButton>
              </li>
            ))}
          </ul>
        )}
        <label className="attachment-upload">
          <PixelIcon name="upload" />
          <span>{uploading ? "Uploading…" : "Upload a file"}</span>
          <input
            type="file"
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void upload(file);
              e.target.value = "";
            }}
          />
        </label>
        {uploadError ? (
          <StatusMessage tone="error">
            <p>{uploadError}</p>
          </StatusMessage>
        ) : null}
        {attachments.error ? (
          <StatusMessage tone="error">
            <p>{attachments.error}</p>
          </StatusMessage>
        ) : null}
      </PixelWindow>

      {editing ? (
        <ItemEditor
          item={data}
          categories={categories.data?.items ?? []}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refresh();
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete item"
          message={`Delete "${data.name}" and all of its attachments? This cannot be undone.`}
          busy={deleteItem.busy}
          onCancel={() => setDeleting(false)}
          onConfirm={async () => {
            if (await deleteItem.mutate()) {
              navigate("/assets");
            }
          }}
        />
      ) : null}
      {attachmentDelete ? (
        <ConfirmDialog
          title="Delete attachment"
          message={`Delete attachment "${attachmentDelete.filename}"?`}
          busy={deleteAttachment.busy}
          onCancel={() => setAttachmentDelete(null)}
          onConfirm={async () => {
            if (await deleteAttachment.mutate()) {
              setAttachmentDelete(null);
              refresh();
            }
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Asset Summary dashboard card. compact keeps the two counters (summary
 * endpoint only); normal/expanded derive the counters from the item list's
 * faceted counts and add recent items — three rows at normal, five at
 * expanded. Never a management page: rows are name + quantity only.
 */
function AssetSummaryWidget({ density = "normal" }: { density?: WidgetDensity }) {
  const compact = density === "compact";
  const recentLimit = density === "expanded" ? 5 : 3;
  const summary = useAsync(
    () =>
      compact
        ? api<{ items: number; categories: number }>("/api/apps/assets/summary")
        : Promise.resolve(null),
    [density],
  );
  const list = useAsync(
    () =>
      compact
        ? Promise.resolve(null)
        : api<ItemsListResponse>("/api/apps/assets/items?sortBy=createdAt&order=desc"),
    [density],
  );
  if ((compact && summary.loading) || (!compact && list.loading)) {
    return <LoadingState label="Loading…" />;
  }
  const error = (compact ? summary.error : null) ?? (compact ? null : list.error);
  if (error) {
    return (
      <div className="widget-fallback">
        <StatusMessage tone="error">
          <p>{error}</p>
        </StatusMessage>
        <PixelButton size="sm" variant="secondary" onClick={compact ? summary.reload : list.reload}>
          Retry
        </PixelButton>
      </div>
    );
  }

  if (compact) {
    const data = summary.data ?? { items: 0, categories: 0 };
    return (
      <div className="px-stats">
        <div className="px-stat">
          <span className="px-stat__label">Items</span>
          <span className="px-stat__value">{data.items}</span>
        </div>
        <div className="px-stat">
          <span className="px-stat__label">Categories</span>
          <span className="px-stat__value">{data.categories}</span>
        </div>
      </div>
    );
  }

  const data = list.data ?? { items: [], counts: { all: 0, categories: {} } };
  const recent = data.items.slice(0, recentLimit);
  return (
    <div className="assets-widget">
      <div className="px-stats">
        <div className="px-stat">
          <span className="px-stat__label">Items</span>
          <span className="px-stat__value">{data.counts.all}</span>
        </div>
        <div className="px-stat">
          <span className="px-stat__label">Categories</span>
          <span className="px-stat__value">{Object.keys(data.counts.categories).length}</span>
        </div>
      </div>
      {recent.length > 0 ? (
        <ul className="assets-widget__recent">
          {recent.map((item) => (
            <li key={item.id} className="assets-widget__recent-row">
              <span className="assets-widget__recent-name">{item.name}</span>
              <span className="assets-widget__recent-qty">×{item.quantity}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="assets-widget__empty">No items tracked yet.</p>
      )}
    </div>
  );
}

const app: FrontendAppModule = {
  id: "assets",
  routes: [
    { path: "", label: "Assets", element: <AssetsPage /> },
    { path: "/items/:id", label: "Asset Detail", element: <AssetDetailPage /> },
  ],
  widgets: [
    {
      id: "summary",
      title: "Asset Summary",
      render: (context) => <AssetSummaryWidget density={context?.layout.density ?? "normal"} />,
      layout: {
        minW: 14,
        minH: 10,
        defaultW: 20,
        defaultH: 16,
        density: {
          normal: { minW: 16, minH: 12 },
          expanded: { minW: 24, minH: 16 },
        },
      },
    },
  ],
};

export default app;
