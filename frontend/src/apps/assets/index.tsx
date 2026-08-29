import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../shared/api";
import { useAppDisplayName } from "../../shared/PresentationContext";
import type { FrontendAppModule } from "../../shared/appTypes";
import { useDebouncedValue } from "../../shared/useDebouncedValue";
import { useMutation } from "../../shared/useMutation";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { EmptyState } from "../../shared/ui/EmptyState";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelBadge } from "../../shared/ui/PixelBadge";
import { PixelButton } from "../../shared/ui/PixelButton";
import { PixelIcon } from "../../shared/ui/PixelIcon";
import { PixelInput } from "../../shared/ui/PixelInput";
import { PixelWindow } from "../../shared/ui/PixelWindow";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { useAsync } from "../../shared/useAsync";

interface Category {
  id: string;
  name: string;
}

interface Item {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  quantity: number;
  acquired_at: string | null;
  target_location: string | null;
  created_at: string;
  updated_at: string;
}

interface Attachment {
  id: string;
  item_id: string;
  filename: string;
  content_type: string | null;
  size: number;
}

const SORT_OPTIONS = [
  { value: "createdAt", label: "Added" },
  { value: "updatedAt", label: "Modified" },
  { value: "name", label: "Name" },
  { value: "quantity", label: "Quantity" },
  { value: "acquiredAt", label: "Acquired" },
  { value: "targetLocation", label: "Location" },
] as const;

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
  for (const key of ["q", "categoryId", "targetLocation", "acquiredAfter", "acquiredBefore", "createdAfter", "createdBefore", "sortBy", "order"]) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

interface ItemEditorState {
  name: string;
  description: string;
  quantity: string;
  categoryId: string;
  acquiredAt: string;
  targetLocation: string;
}

function emptyEditorState(): ItemEditorState {
  return { name: "", description: "", quantity: "1", categoryId: "", acquiredAt: "", targetLocation: "" };
}

function editorStateFromItem(item: Item): ItemEditorState {
  return {
    name: item.name,
    description: item.description ?? "",
    quantity: String(item.quantity),
    categoryId: item.category_id ?? "",
    acquiredAt: item.acquired_at ?? "",
    targetLocation: item.target_location ?? "",
  };
}

/** Create/edit item modal (FP-3.3). Empty string fields are omitted on create,
 * sent as null on edit so nullable columns can be cleared. */
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

  const save = useMutation(async () => {
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      description: form.description.trim() === "" ? null : form.description.trim(),
      quantity: Number(form.quantity) || 0,
      categoryId: form.categoryId === "" ? null : form.categoryId,
      acquiredAt: form.acquiredAt === "" ? null : form.acquiredAt,
      targetLocation: form.targetLocation.trim() === "" ? null : form.targetLocation.trim(),
    };
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
          <div className="px-form__grid">
            <label className="px-form__row">
              <span className="px-form__label">Quantity</span>
              <PixelInput
                type="number"
                min={0}
                value={form.quantity}
                onChange={(e) => set("quantity", e.target.value)}
                aria-label="Quantity"
              />
            </label>
            <label className="px-form__row">
              <span className="px-form__label">Category</span>
              <select
                className="px-select"
                value={form.categoryId}
                onChange={(e) => set("categoryId", e.target.value)}
                aria-label="Category"
              >
                <option value="">—</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
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

function RenameCategoryDialog({
  category,
  onClose,
  onSaved,
}: {
  category: Category;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(category.name);
  const rename = useMutation(async () => {
    await api(`/api/apps/assets/categories/${category.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || rename.busy) return;
    if (await rename.mutate()) onSaved();
  };

  return (
    <div className="px-dialog-backdrop" role="presentation">
      <PixelWindow title="Rename Category" icon="box" className="px-dialog px-dialog--form">
        <form className="px-form" onSubmit={submit} aria-label="Rename category">
          <label className="px-form__row">
            <span className="px-form__label">Name</span>
            <PixelInput value={name} onChange={(e) => setName(e.target.value)} aria-label="Category name" autoFocus />
          </label>
          {rename.error ? (
            <StatusMessage tone="error">
              <p>{rename.error}</p>
            </StatusMessage>
          ) : null}
          <div className="px-dialog__actions">
            <PixelButton variant="secondary" size="sm" onClick={onClose} disabled={rename.busy}>
              Cancel
            </PixelButton>
            <PixelButton type="submit" size="sm" disabled={!name.trim() || rename.busy}>
              {rename.busy ? "Saving…" : "Rename"}
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
  const [categoryRename, setCategoryRename] = useState<Category | null>(null);
  const [categoryDelete, setCategoryDelete] = useState<Category | null>(null);

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

  const activeCategory = searchParams.get("categoryId") ?? "";
  const sortBy = searchParams.get("sortBy") ?? "createdAt";
  const order = searchParams.get("order") ?? "desc";

  const items = useAsync(
    () => api<{ items: Item[] }>(`/api/apps/assets/items${itemsQueryString(searchParams)}`),
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

  const allItems = items.data?.items ?? [];
  const hasFilters = Boolean(itemsQueryString(searchParams));
  const categoryNames = new Map((categories.data?.items ?? []).map((c) => [c.id, c.name]));
  const countFor = (id: string | null) =>
    id ? allItems.filter((item) => item.category_id === id).length : allItems.length;

  return (
    <div className="page" data-app="assets">
      <header className="page-header">
        <h1 className="page-header__title">{displayName}</h1>
        <p className="page-header__subtitle">Personal inventory</p>
        <div className="page-header__actions">
          <PixelButton size="sm" onClick={() => setEditorFor(null)}>
            <PixelIcon name="plus" /> New Item
          </PixelButton>
        </div>
      </header>

      <PixelWindow title="Filters" icon="search" className="assets-filters">
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
          <select
            className="px-select"
            value={activeCategory}
            onChange={(e) => setParam("categoryId", e.target.value)}
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            {(categories.data?.items ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
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
        </div>
      </PixelWindow>

      <section className="assets-section" aria-labelledby="assets-categories">
        <h2 id="assets-categories" className="section-title">
          Categories
        </h2>
        <div className="px-chips">
          <button
            type="button"
            className="px-chip"
            aria-pressed={activeCategory === ""}
            onClick={() => setParam("categoryId", "")}
          >
            <span>All</span>
            <span className="px-chip__count">{countFor(null)}</span>
          </button>
          {(categories.data?.items ?? []).map((category) => (
            <span key={category.id} className="px-chip-group">
              <button
                type="button"
                className="px-chip"
                aria-pressed={activeCategory === category.id}
                onClick={() => setParam("categoryId", category.id)}
              >
                <span>{category.name}</span>
                <span className="px-chip__count">{countFor(category.id)}</span>
              </button>
              <span className="px-chip__tools">
                <PixelButton
                  variant="ghost"
                  size="sm"
                  className="px-button--icon"
                  aria-label={`Rename category ${category.name}`}
                  onClick={() => setCategoryRename(category)}
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
            </span>
          ))}
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
            {allItems.map((item) => (
              <li key={item.id} className="inv-card">
                <Link to={`/assets/items/${item.id}`} className="inv-card__main">
                  <span className="inv-card__thumb" aria-hidden="true">
                    <PixelIcon name="box" size={32} />
                  </span>
                  <span className="inv-card__name">{item.name}</span>
                </Link>
                <div className="inv-card__foot">
                  <span className="inv-card__qty">×{item.quantity}</span>
                  {item.category_id && categoryNames.has(item.category_id) ? (
                    <PixelBadge tone="neutral">{categoryNames.get(item.category_id)}</PixelBadge>
                  ) : null}
                  {item.target_location ? (
                    <PixelBadge tone="info">{item.target_location}</PixelBadge>
                  ) : null}
                </div>
              </li>
            ))}
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
      {categoryRename ? (
        <RenameCategoryDialog
          category={categoryRename}
          onClose={() => setCategoryRename(null)}
          onSaved={() => {
            setCategoryRename(null);
            refresh();
          }}
        />
      ) : null}
      {categoryDelete ? (
        <ConfirmDialog
          title="Delete category"
          message={`Delete "${categoryDelete.name}"? Items in this category are kept but become uncategorized.`}
          busy={deleteCategory.busy}
          onCancel={() => setCategoryDelete(null)}
          onConfirm={async () => {
            if (await deleteCategory.mutate()) {
              setCategoryDelete(null);
              if (activeCategory === categoryDelete.id) setParam("categoryId", "");
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
    const dataBase64 = await fileToBase64(file);
    setUploading(true);
    setUploadError(null);
    try {
      await api(`/api/apps/assets/items/${id}/attachments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type, dataBase64 }),
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
  const categoryName = data.category_id
    ? (categories.data?.items ?? []).find((c) => c.id === data.category_id)?.name
    : undefined;

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
            <dd>{categoryName ?? "—"}</dd>
          </div>
          <div>
            <dt>Location</dt>
            <dd>{data.target_location ?? "—"}</dd>
          </div>
          <div>
            <dt>Acquired</dt>
            <dd>{data.acquired_at ?? "—"}</dd>
          </div>
          <div>
            <dt>Added (auto)</dt>
            <dd>{formatTimestamp(data.created_at)}</dd>
          </div>
          <div>
            <dt>Last modified</dt>
            <dd>{formatTimestamp(data.updated_at)}</dd>
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

function AssetSummaryWidget() {
  const summary = useAsync(() => api<{ items: number; categories: number }>("/api/apps/assets/summary"));
  if (summary.loading) return <LoadingState label="Loading…" />;
  if (summary.error) {
    return (
      <div className="widget-fallback">
        <StatusMessage tone="error">
          <p>{summary.error}</p>
        </StatusMessage>
        <PixelButton size="sm" variant="secondary" onClick={summary.reload}>
          Retry
        </PixelButton>
      </div>
    );
  }
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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const app: FrontendAppModule = {
  id: "assets",
  routes: [
    { path: "", label: "Assets", element: <AssetsPage /> },
    { path: "/items/:id", label: "Asset Detail", element: <AssetDetailPage /> },
  ],
  widgets: [{ id: "summary", title: "Asset Summary", render: () => <AssetSummaryWidget /> }],
};

export default app;
