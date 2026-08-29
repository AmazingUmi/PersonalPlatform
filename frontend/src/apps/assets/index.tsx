import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../shared/api";
import type { FrontendAppModule } from "../../shared/appTypes";
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
}

interface Attachment {
  id: string;
  item_id: string;
  filename: string;
  content_type: string | null;
  size: number;
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function AssetsPage() {
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const items = useAsync(
    () => api<{ items: Item[] }>(`/api/apps/assets/items${search ? `?q=${encodeURIComponent(search)}` : ""}`),
    [search, reloadKey],
  );
  const categories = useAsync(() => api<{ items: Category[] }>("/api/apps/assets/categories"), [reloadKey]);

  async function createItem(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    await api("/api/apps/assets/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    setName("");
    setReloadKey((k) => k + 1);
  }

  async function createCategory(event: React.FormEvent) {
    event.preventDefault();
    if (!categoryName.trim()) return;
    await api("/api/apps/assets/categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: categoryName.trim() }),
    });
    setCategoryName("");
    setReloadKey((k) => k + 1);
  }

  const allItems = items.data?.items ?? [];
  const filtered = activeCategory
    ? allItems.filter((item) => item.category_id === activeCategory)
    : allItems;
  const categoryNames = new Map((categories.data?.items ?? []).map((c) => [c.id, c.name]));
  const countFor = (id: string | null) =>
    id ? allItems.filter((item) => item.category_id === id).length : allItems.length;

  return (
    <div className="page" data-app="assets">
      <header className="page-header">
        <h1 className="page-header__title">Assets</h1>
        <p className="page-header__subtitle">Personal inventory</p>
      </header>

      <PixelWindow title="Add Item" icon="plus">
        <form onSubmit={createItem} className="assets-add" aria-label="Add an item">
          <PixelInput
            placeholder="Item name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Item name"
          />
          <PixelButton type="submit" disabled={!name.trim()}>
            Add item
          </PixelButton>
        </form>
      </PixelWindow>

      <div className="assets-search">
        <PixelIcon name="search" />
        <PixelInput
          placeholder="Search items…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search items"
        />
      </div>

      <section className="assets-section" aria-labelledby="assets-categories">
        <h2 id="assets-categories" className="section-title">
          Categories
        </h2>
        <div className="px-chips">
          <button
            type="button"
            className="px-chip"
            aria-pressed={activeCategory === null}
            onClick={() => setActiveCategory(null)}
          >
            <span>All</span>
            <span className="px-chip__count">{countFor(null)}</span>
          </button>
          {(categories.data?.items ?? []).map((category) => (
            <button
              key={category.id}
              type="button"
              className="px-chip"
              aria-pressed={activeCategory === category.id}
              onClick={() =>
                setActiveCategory((current) => (current === category.id ? null : category.id))
              }
            >
              <span>{category.name}</span>
              <span className="px-chip__count">{countFor(category.id)}</span>
            </button>
          ))}
          <form onSubmit={createCategory} className="category-add" aria-label="Add a category">
            <PixelInput
              className="category-add__input"
              placeholder="New category"
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              aria-label="New category name"
            />
            <PixelButton
              type="submit"
              variant="secondary"
              size="sm"
              className="px-button--icon"
              aria-label="Add category"
              disabled={!categoryName.trim()}
            >
              <PixelIcon name="plus" />
            </PixelButton>
          </form>
        </div>
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
        ) : allItems.length === 0 ? (
          <EmptyState
            icon="box"
            title="Your inventory is empty"
            description="Add the first item above to start tracking your personal assets."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="search"
            title="No matching items"
            description="Try a different search term or category filter."
          />
        ) : (
          <ul className="inventory-grid">
            {filtered.map((item) => (
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
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [reloadKey, setReloadKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const item = useAsync(() => api<Item>(`/api/apps/assets/items/${id}`), [id, reloadKey]);
  const categories = useAsync(
    () => api<{ items: Category[] }>("/api/apps/assets/categories"),
    [reloadKey],
  );
  const attachments = useAsync(
    () => api<{ items: Attachment[] }>(`/api/apps/assets/items/${id}/attachments`),
    [id, reloadKey],
  );

  async function upload(file: File) {
    const dataBase64 = await fileToBase64(file);
    await api(`/api/apps/assets/items/${id}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: file.name, contentType: file.type, dataBase64 }),
    });
    setReloadKey((k) => k + 1);
  }

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

      <PixelWindow title={data.name} icon="box" headingLevel={1}>
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
            <dt>Acquired</dt>
            <dd>{data.acquired_at ? new Date(data.acquired_at).toLocaleDateString() : "—"}</dd>
          </div>
        </dl>
        {data.description ? <p className="asset-detail__desc">{data.description}</p> : null}
      </PixelWindow>

      <PixelWindow title="Attachments" icon="file">
        {(attachments.data?.items ?? []).length === 0 ? (
          <p className="muted">No attachments yet.</p>
        ) : (
          <ul className="attachment-list">
            {(attachments.data?.items ?? []).map((attachment) => (
              <li key={attachment.id} className="attachment-row">
                <PixelIcon name="file" />
                <span className="attachment-row__name">{attachment.filename}</span>
                <span className="attachment-row__size">{formatBytes(attachment.size)}</span>
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
              setUploading(true);
              void upload(file).finally(() => setUploading(false));
              e.target.value = "";
            }}
          />
        </label>
        {attachments.error ? (
          <StatusMessage tone="error">
            <p>{attachments.error}</p>
          </StatusMessage>
        ) : null}
      </PixelWindow>
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
