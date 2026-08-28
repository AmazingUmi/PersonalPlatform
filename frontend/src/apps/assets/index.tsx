import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../shared/api";
import type { FrontendAppModule } from "../../shared/appTypes";
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

function AssetsPage() {
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [categoryName, setCategoryName] = useState("");
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

  return (
    <div className="page">
      <h1>Assets</h1>
      <form onSubmit={createItem} className="inline-form">
        <input placeholder="Item name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">Add item</button>
      </form>
      <form onSubmit={createCategory} className="inline-form">
        <input placeholder="New category" value={categoryName} onChange={(e) => setCategoryName(e.target.value)} />
        <button type="submit">Add category</button>
      </form>
      <input
        className="search"
        placeholder="Search items…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {items.loading ? (
        <p className="muted">Loading…</p>
      ) : items.error ? (
        <p className="error-text">{items.error}</p>
      ) : (
        <ul className="item-list">
          {(items.data?.items ?? []).map((item) => (
            <li key={item.id}>
              <Link to={`/assets/items/${item.id}`}>{item.name}</Link>
              <span className="muted"> ×{item.quantity}</span>
            </li>
          ))}
        </ul>
      )}

      <h2>Categories</h2>
      <ul>
        {(categories.data?.items ?? []).map((category) => (
          <li key={category.id}>{category.name}</li>
        ))}
      </ul>
    </div>
  );
}

function AssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [reloadKey, setReloadKey] = useState(0);
  const item = useAsync(() => api<Item>(`/api/apps/assets/items/${id}`), [id, reloadKey]);
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

  if (item.loading) return <p className="muted">Loading…</p>;
  if (item.error) return <p className="error-text">{item.error}</p>;

  const data = item.data!;
  return (
    <div className="page">
      <Link to="/assets">← Assets</Link>
      <h1>{data.name}</h1>
      <p className="muted">{data.description}</p>
      <p>Quantity: {data.quantity}</p>

      <h2>Attachments</h2>
      <input type="file" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
      <ul>
        {(attachments.data?.items ?? []).map((attachment) => (
          <li key={attachment.id}>
            {attachment.filename} <span className="muted">({attachment.size} bytes)</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AssetSummaryWidget() {
  const summary = useAsync(() => api<{ items: number; categories: number }>("/api/apps/assets/summary"));
  if (summary.loading) return <p className="muted">Loading…</p>;
  if (summary.error) return <p className="error-text">{summary.error}</p>;
  return (
    <p>
      {summary.data?.items ?? 0} items · {summary.data?.categories ?? 0} categories
    </p>
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
