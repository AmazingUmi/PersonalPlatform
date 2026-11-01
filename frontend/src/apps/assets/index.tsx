import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../shared/api";
import { localizeError } from "../../shared/localizeError";
import { useI18n } from "../../shared/i18n";
import { HelpPopover } from "../../shared/ui/HelpPopover";
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
import { appIconName } from "../../shared/ui/appIcons";
import { PixelInput } from "../../shared/ui/PixelInput";
import { PixelMeter } from "../../shared/ui/PixelMeter";
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
  { value: "createdAt", label: "Added", zh: "添加时间" },
  { value: "updatedAt", label: "Modified", zh: "修改时间" },
  { value: "name", label: "Name", zh: "名称" },
  { value: "quantity", label: "Quantity", zh: "数量" },
  { value: "acquiredAt", label: "Acquired", zh: "获取日期" },
  { value: "targetLocation", label: "Location", zh: "位置" },
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

function formatBytes(size: number, locale: string): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  if (size >= 1024) return `${Math.round(size / 1024).toLocaleString(locale)} KB`;
  return `${size.toLocaleString(locale)} B`;
}

/** DATE is a calendar day, so formatting must not shift it with the viewer timezone. */
function formatCalendarDate(value: string | null, locale: string): string {
  return value ? new Date(`${value}T00:00:00Z`).toLocaleDateString(locale, { timeZone: "UTC" }) : "—";
}

function formatTimestamp(value: string | null, locale: string): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(locale);
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
  const { t } = useI18n();
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
        title={item ? t("Edit Item", "编辑物品") : t("New Item", "新建物品")}
        icon="box"
        className="px-dialog px-dialog--form"
        data-testid="item-editor"
      >
        <form className="px-form" onSubmit={submit} aria-label={item ? t("Edit item", "编辑物品") : t("Create item", "创建物品")}>
          <label className="px-form__row">
            <span className="px-form__label">{t("Name", "名称")}</span>
            <PixelInput
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              aria-label={t("Item name", "物品名称")}
              required
              autoFocus
            />
          </label>
          <label className="px-form__row">
            <span className="px-form__label">{t("Description", "描述")}</span>
            <textarea
              className="px-textarea"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              aria-label={t("Item description", "物品描述")}
            />
          </label>
          <div className="px-form__row">
            <span className="px-form__label">{t("Quantity", "数量")}</span>
            <PixelInput
              type="number"
              min={0}
              value={form.quantity}
              onChange={(e) => set("quantity", e.target.value)}
              aria-label={t("Quantity", "数量")}
            />
          </div>
          <div className="px-form__row">
            <span className="px-form__label">{t("Category", "分类")}</span>
            {categories.length > 0 ? (
              <div className="assets-editor__categories">
                {categories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className="px-chip"
                    aria-pressed={form.categoryIds.includes(category.id)}
                    aria-label={t(`Toggle category ${category.name}`, `切换分类 ${category.name}`)}
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
              <p className="px-form__hint">{t("No categories yet — add one below the category chips first.", "暂无分类，请先在分类区域添加。")}</p>
            )}
          </div>
          <div className="px-form__grid">
            <label className="px-form__row">
              <span className="px-form__label">{t("Acquired date", "获取日期")}</span>
              <PixelInput
                type="date"
                value={form.acquiredAt}
                onChange={(e) => set("acquiredAt", e.target.value)}
                aria-label={t("Acquired date", "获取日期")}
              />
            </label>
            <label className="px-form__row">
              <span className="px-form__label">{t("Location", "位置")}</span>
              <PixelInput
                value={form.targetLocation}
                onChange={(e) => set("targetLocation", e.target.value)}
                aria-label={t("Target location", "存放位置")}
                placeholder={t("e.g. shelf-a", "例如：书架 A")}
              />
            </label>
          </div>
          <HelpPopover label={t("Acquired date", "获取日期")}><p>{t("Acquired date is optional — fill it in when you got the item (purchase, gift, …). The intake time is recorded automatically.", "获取日期可选，填写购入、获赠等实际取得物品的日期。添加时间会自动记录。")}</p></HelpPopover>
          {save.error ? (
            <StatusMessage tone="error">
              <p>{save.error}</p>
            </StatusMessage>
          ) : null}
          <div className="px-dialog__actions">
            <PixelButton variant="secondary" size="sm" onClick={onClose} disabled={save.busy}>
              {t("Cancel", "取消")}</PixelButton>
            <PixelButton type="submit" size="sm" disabled={!form.name.trim() || save.busy}>
              {save.busy ? t("Saving…", "正在保存…") : item ? t("Save changes", "保存修改") : t("Create item", "创建物品")}
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
  const { t } = useI18n();
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
      <PixelWindow title={t("Edit Category", "编辑分类")} icon="palette" className="px-dialog px-dialog--form">
        <form className="px-form" onSubmit={submit} aria-label={t("Edit category", "编辑分类")}>
          <label className="px-form__row">
            <span className="px-form__label">{t("Name", "名称")}</span>
            <PixelInput value={name} onChange={(e) => setName(e.target.value)} aria-label={t("Category name", "分类名称")} autoFocus />
          </label>
          <label className="px-form__row">
            <span className="px-form__label">{t("Color", "颜色")}</span>
            <select
              className="px-select"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label={t("Category color", "分类颜色")}
            >
              <option value="">{t("Default", "默认")}</option>
              {ACCENT_OPTIONS.map((accent) => (
                <option key={accent} value={accent}>
                  {t(accent, {"primary": "主色", "success": "成功绿", "warning": "警告黄", "danger": "危险红", "info": "信息蓝", "mint": "薄荷绿", "yellow": "黄色", "violet": "紫色", "coral": "珊瑚色"}[accent])}
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
              {t("Cancel", "取消")}</PixelButton>
            <PixelButton type="submit" size="sm" disabled={!name.trim() || save.busy}>
              {save.busy ? t("Saving…", "正在保存…") : t("Save", "保存")}
            </PixelButton>
          </div>
        </form>
      </PixelWindow>
    </div>
  );
}

function AssetsPage() {
  const { t, locale } = useI18n();
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
        <h1 className="page-header__title">
          <PixelIcon name={appIconName("assets")} size={20} className="page-header__app-icon" aria-hidden="true" /> {displayName}
        </h1>
        <HelpPopover label={t("About assets", "关于资产")}><p>{t("Personal inventory", "管理个人物品、分类、位置与附件。")}</p></HelpPopover>
        <div className="page-header__actions">
          <PixelButton
            size="sm"
            variant="secondary"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <PixelIcon name="search" /> {t("Filters", "筛选")}{activeFilterCount > 0 ? <PixelBadge tone="warning">{activeFilterCount.toLocaleString(locale)}</PixelBadge> : null}
          </PixelButton>
          <PixelButton size="sm" onClick={() => setEditorFor(null)}>
            <PixelIcon name="plus" /> {t("New Item", "新建物品")}</PixelButton>
        </div>
      </header>

      {filtersOpen ? (
      <PixelWindow title={t("Filters", "筛选")} icon="search" className="assets-filters" actions={
        <PixelButton variant="ghost" size="sm" onClick={resetFilters} disabled={activeFilterCount === 0}>
          {t("Reset", "重置")}</PixelButton>
      }>
        <div className="assets-filters__row">
          <div className="assets-search">
            <PixelIcon name="search" />
            <PixelInput
              placeholder={t("Search name or category…", "搜索名称或分类…")}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              aria-label={t("Search items", "搜索物品")}
            />
          </div>
          <PixelInput
            placeholder={t("Location", "位置")}
            value={searchParams.get("targetLocation") ?? ""}
            onChange={(e) => setParam("targetLocation", e.target.value)}
            aria-label={t("Filter by location", "按位置筛选")}
            className="assets-filters__location"
          />
        </div>
        <div className="assets-filters__row">
          <label className="assets-filters__date">
            <span>{t("Acquired from", "获取日期从")}</span>
            <PixelInput
              type="date"
              value={searchParams.get("acquiredAfter") ?? ""}
              onChange={(e) => setParam("acquiredAfter", e.target.value)}
              aria-label={t("Acquired after", "获取日期起点")}
            />
          </label>
          <label className="assets-filters__date">
            <span>{t("to", "至")}</span>
            <PixelInput
              type="date"
              value={searchParams.get("acquiredBefore") ?? ""}
              onChange={(e) => setParam("acquiredBefore", e.target.value)}
              aria-label={t("Acquired before", "获取日期终点")}
            />
          </label>
          <label className="assets-filters__date">
            <span>{t("Added from", "添加日期从")}</span>
            <PixelInput
              type="date"
              value={searchParams.get("createdAfter") ?? ""}
              onChange={(e) => setParam("createdAfter", e.target.value ? new Date(e.target.value).toISOString() : "")}
              aria-label={t("Added after", "添加日期起点")}
            />
          </label>
          <label className="assets-filters__date">
            <span>{t("to", "至")}</span>
            <PixelInput
              type="date"
              value={searchParams.get("createdBefore") ?? ""}
              onChange={(e) => setParam("createdBefore", e.target.value ? new Date(e.target.value).toISOString() : "")}
              aria-label={t("Added before", "添加日期终点")}
            />
          </label>
        </div>
        <div className="assets-filters__row">
          <select
            className="px-select"
            value={sortBy}
            onChange={(e) => setParam("sortBy", e.target.value)}
            aria-label={t("Sort by", "排序依据")}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(`Sort: ${option.label}`, `排序：${option.zh}`)}
              </option>
            ))}
          </select>
          <PixelButton
            size="sm"
            variant="secondary"
            onClick={() => setParam("order", order === "asc" ? "desc" : "asc")}
            aria-label={t(`Sort order: ${order}. Click to switch.`, `排序方向：${order === "asc" ? "升序" : "降序"}，点击切换。`)}
          >
            <PixelIcon name={order === "asc" ? "up" : "down"} />
            {order === "asc" ? t("Asc", "升序") : t("Desc", "降序")}
          </PixelButton>
          <span className="assets-filters__spacer" />
          <PixelButton size="sm" variant="secondary" onClick={() => setFiltersOpen(false)}>
            {t("Close", "关闭")}</PixelButton>
        </div>
      </PixelWindow>
      ) : null}

      <section className="assets-section" aria-labelledby="assets-categories">
        <h2 id="assets-categories" className="section-title">
          {t("Categories", "分类")}</h2>
        <div className="px-chips">
          <button
            type="button"
            className="px-chip"
            aria-pressed={selectedCategoryIds.length === 0}
            aria-label={t("All categories", "全部分类")}
            onClick={() => setParam("categories", "")}
          >
            <span>{t("All", "全部")}</span>
            <span className="px-chip__count">{(counts?.all ?? 0).toLocaleString(locale)}</span>
          </button>
          {(categories.data?.items ?? []).map((category) => {
            const open = openCategoryId === category.id;
            return (
              <span key={category.id} className="px-chip-group">
                <button
                  type="button"
                  className="px-chip"
                  aria-pressed={selectedCategoryIds.includes(category.id)}
                  aria-label={t(`Filter by category ${category.name}`, `按分类 ${category.name} 筛选`)}
                  onClick={() => toggleCategoryFilter(category.id)}
                >
                  {category.color ? (
                    <span className="px-cat-dot" data-accent={category.color} aria-hidden="true" />
                  ) : null}
                  <span>{category.name}</span>
                  <span className="px-chip__count">{countForCategory(category.id).toLocaleString(locale)}</span>
                </button>
                <PixelButton
                  variant="ghost"
                  size="sm"
                  className="px-chip-manage"
                  aria-label={t(`Manage category ${category.name}`, `管理分类 ${category.name}`)}
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
                      aria-label={t(`Rename category ${category.name}`, `重命名分类 ${category.name}`)}
                      onClick={() => setCategoryEdit(category)}
                    >
                      <PixelIcon name="edit" />
                    </PixelButton>
                    <PixelButton
                      variant="ghost"
                      size="sm"
                      className="px-button--icon"
                      aria-label={t(`Delete category ${category.name}`, `删除分类 ${category.name}`)}
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
            aria-label={t("Add a category", "添加分类")}
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
              placeholder={t("New category", "新分类")}
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              aria-label={t("New category name", "新分类名称")}
            />
            <PixelButton
              type="submit"
              variant="secondary"
              size="sm"
              className="px-button--icon"
              aria-label={t("Add category", "添加分类")}
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
          {t("Inventory", "物品清单")}</h2>
        {items.loading ? (
          <LoadingState label={t("Loading items…", "正在加载物品…")} />
        ) : items.error ? (
          <StatusMessage tone="error">
            <p>{items.error}</p>
            <PixelButton size="sm" variant="secondary" onClick={items.reload}>
              {t("Retry", "重试")}</PixelButton>
          </StatusMessage>
        ) : allItems.length === 0 && !hasFilters ? (
          <EmptyState
            icon="box"
            title={t("Your inventory is empty", "物品清单为空")}
            description={t("Create the first item to start tracking your personal assets.", "创建第一个物品，开始记录个人资产。")}
            action={
              <PixelButton size="sm" onClick={() => setEditorFor(null)}>
                <PixelIcon name="plus" /> {t("New Item", "新建物品")}</PixelButton>
            }
          />
        ) : allItems.length === 0 ? (
          <EmptyState
            icon="search"
            title={t("No matching items", "没有匹配的物品")}
            description={t("Try a different search term or clear the filters.", "尝试其他搜索词或清除筛选条件。")}
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
                  <span className="inv-card__qty">×{(item.quantity).toLocaleString(locale)}</span>
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
          title={t("Delete category", "删除分类")}
          message={t(`Delete "${categoryDelete.name}"? Items keep their other categories; items that only have this one become uncategorized.`, `删除分类“${categoryDelete.name}”？物品的其他分类将保留，仅属于此分类的物品将变为未分类。`)}
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
  const { t, locale, language } = useI18n();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [reloadKey, setReloadKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<unknown>(null);
  const [oversizedFile, setOversizedFile] = useState<string | null>(null);
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
    setOversizedFile(null);
    try {
      if (file.size > ATTACHMENT_MAX_BYTES) {
        setOversizedFile(file.name);
        return;
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
      setUploadError(error);
    } finally {
      setUploading(false);
    }
  };

  if (item.loading) {
    return (
      <div className="page" data-app="assets">
        <LoadingState label={t("Loading item…", "正在加载物品…")} />
      </div>
    );
  }
  if (item.error) {
    return (
      <div className="page" data-app="assets">
        <StatusMessage tone="error">
          <p>{item.error}</p>
          <PixelButton size="sm" variant="secondary" onClick={item.reload}>
            {t("Retry", "重试")}</PixelButton>
        </StatusMessage>
      </div>
    );
  }

  const data = item.data!;

  return (
    <div className="page page--detail" data-app="assets">
      <Link to="/assets" className="back-link">
        <PixelIcon name="back" />
        {t("Assets", "资产")}</Link>

      <PixelWindow
        title={data.name}
        icon="box"
        headingLevel={1}
        actions={
          <>
            <PixelButton size="sm" variant="secondary" onClick={() => setEditing(true)}>
              <PixelIcon name="edit" /> {t("Edit", "编辑")}</PixelButton>
            <PixelButton size="sm" variant="danger" onClick={() => setDeleting(true)}>
              <PixelIcon name="trash" /> {t("Delete", "删除")}</PixelButton>
          </>
        }
      >
        <dl className="px-deflist">
          <div>
            <dt>{t("Quantity", "数量")}</dt>
            <dd>×{(data.quantity).toLocaleString(locale)}</dd>
          </div>
          <div>
            <dt>{t("Category", "分类")}</dt>
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
            <dt>{t("Location", "位置")}</dt>
            <dd>{data.targetLocation ?? "—"}</dd>
          </div>
          <div>
            <dt>{t("Acquired", "获取日期")}</dt>
            <dd>{formatCalendarDate(data.acquiredAt, locale)}</dd>
          </div>
          <div>
            <dt>{t("Added (auto)", "添加时间（自动）")}</dt>
            <dd>{formatTimestamp(data.createdAt, locale)}</dd>
          </div>
          <div>
            <dt>{t("Last modified", "最后修改时间")}</dt>
            <dd>{formatTimestamp(data.updatedAt, locale)}</dd>
          </div>
        </dl>
        {data.description ? <p className="asset-detail__desc">{data.description}</p> : null}
        {deleteItem.error ? (
          <StatusMessage tone="error">
            <p>{deleteItem.error}</p>
          </StatusMessage>
        ) : null}
      </PixelWindow>

      <PixelWindow title={t("Attachments", "附件")} icon="file">
        {(attachments.data?.items ?? []).length === 0 ? (
          <p className="muted">{t("No attachments yet.", "暂无附件。")}</p>
        ) : (
          <ul className="attachment-list">
            {(attachments.data?.items ?? []).map((attachment) => (
              <li key={attachment.id} className="attachment-row">
                <PixelIcon name="file" />
                <a
                  className="attachment-row__name"
                  href={`/api/apps/assets/items/${id}/attachments/${attachment.id}`}
                  download
                  title={t(`Download ${attachment.filename}`, `下载 ${attachment.filename}`)}
                >
                  {attachment.filename}
                </a>
                <span className="attachment-row__size">{formatBytes(attachment.size, locale)}</span>
                <PixelButton
                  variant="ghost"
                  size="sm"
                  className="px-button--icon"
                  aria-label={t(`Delete attachment ${attachment.filename}`, `删除附件 ${attachment.filename}`)}
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
          <span>{uploading ? t("Uploading…", "正在上传…") : t("Upload a file", "上传文件")}</span>
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
        {uploadError || oversizedFile !== null ? (
          <StatusMessage tone="error">
            <p>{oversizedFile !== null ? t(`${oversizedFile} is larger than the 10 MB attachment limit`, `${oversizedFile} 超过附件大小上限 10 MB`) : localizeError(uploadError, language)}</p>
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
          title={t("Delete item", "删除物品")}
          message={t(`Delete "${data.name}" and all of its attachments? This cannot be undone.`, `删除“${data.name}”及其全部附件？此操作无法撤销。`)}
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
          title={t("Delete attachment", "删除附件")}
          message={t(`Delete attachment "${attachmentDelete.filename}"?`, `删除附件“${attachmentDelete.filename}”？`)}
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
 * faceted counts and add recent items — three rows at normal, four at
 * expanded (fits the default 26x18 card without clipping). Never a
 * management page: rows are name + quantity only.
 */
function AssetSummaryWidget({ density = "normal" }: { density?: WidgetDensity }) {
  const { t, locale } = useI18n();
  const compact = density === "compact";
  const recentLimit = density === "expanded" ? 4 : 3;
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
  // Names for the top-category meters (counts are keyed by category id).
  const categories = useAsync(
    () =>
      compact
        ? Promise.resolve(null)
        : api<{ items: Category[] }>("/api/apps/assets/categories"),
    [density],
  );
  if ((compact && summary.loading) || (!compact && (list.loading || categories.loading))) {
    return <LoadingState label={t("Loading…", "正在加载…")} />;
  }
  const error =
    (compact ? summary.error : null) ?? (compact ? null : (list.error ?? categories.error));
  if (error) {
    return (
      <div className="widget-fallback">
        <StatusMessage tone="error">
          <p>{error}</p>
        </StatusMessage>
        <PixelButton
          size="sm"
          variant="secondary"
          onClick={compact ? summary.reload : (list.error ? list.reload : categories.reload)}
        >
          {t("Retry", "重试")}</PixelButton>
      </div>
    );
  }

  if (compact) {
    const data = summary.data ?? { items: 0, categories: 0 };
    return (
      <div className="px-stats">
        <div className="px-stat">
          <span className="px-stat__label">{t("Items", "物品")}</span>
          <span className="px-stat__value">{(data.items).toLocaleString(locale)}</span>
        </div>
        <div className="px-stat">
          <span className="px-stat__label">{t("Categories", "分类")}</span>
          <span className="px-stat__value">{data.categories.toLocaleString(locale)}</span>
        </div>
      </div>
    );
  }
  const data = list.data ?? { items: [], counts: { all: 0, categories: {} } };
  const categoryNames = new Map((categories.data?.items ?? []).map((category) => [category.id, category.name]));
  // Top-3 category distribution (guide §18 low-density viz): relative to the
  // leading category, names resolved from the categories endpoint. Degrades
  // to nothing when no categorized items exist.
  const topCategories = Object.entries(data.counts.categories)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, count]) => ({ id, name: categoryNames.get(id) ?? t("Unknown", "未知"), count }));
  const leadingCount = topCategories[0]?.count ?? 1;
  const recent = data.items.slice(0, recentLimit);
  return (
    <div className="assets-widget">
      {/* Ledger index strip (PXOS 2.1 §7): quantities as one ruled catalog
       * header — value first, label as the small index caption — instead of
       * boxed stat cards; the drawer label plate above already names the
       * widget, the rows below carry the data density. */}
      <div className="assets-widget__index">
        <span className="assets-widget__index-entry">
          <span className="assets-widget__index-value">{(data.counts.all).toLocaleString(locale)}</span>
          <span className="assets-widget__index-label">{t("Items", "物品")}</span>
        </span>
        <span className="assets-widget__index-entry">
          <span className="assets-widget__index-value">{(Object.keys(data.counts.categories).length).toLocaleString(locale)}</span>
          <span className="assets-widget__index-label">{t("Categories", "分类")}</span>
        </span>
      </div>
      {topCategories.length > 0 ? (
        <ul className="assets-widget__categories">
          {topCategories.map((category) => (
            <li key={category.id} className="assets-widget__category-row">
              <span className="assets-widget__category-name">{category.name}</span>
              <PixelMeter
                value={category.count}
                max={leadingCount}
                accent="yellow"
                label={t(`${category.name}: ${(category.count).toLocaleString(locale)} items, most is ${leadingCount.toLocaleString(locale)}`, `${category.name}：${(category.count).toLocaleString(locale)} 件物品，最多为 ${leadingCount.toLocaleString(locale)} 件`)}
              />
              <span className="assets-widget__category-count">{(category.count).toLocaleString(locale)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {recent.length > 0 ? (
        <ul className="assets-widget__recent">
          {recent.map((item) => (
            <li key={item.id} className="assets-widget__recent-row">
              <span className="assets-widget__recent-name">{item.name}</span>
              <span className="assets-widget__recent-leader" aria-hidden="true" />
              <span className="assets-widget__recent-qty">×{(item.quantity).toLocaleString(locale)}</span>
            </li>
          ))}
        </ul>
      ) : (
        /* Ledger keeps its ruled silhouette even when empty (dashboard
         * empty-state rule): ghost leader lines instead of blank space. */
        <div className="assets-widget__empty">
          <p className="assets-widget__empty-title">{t("NOTHING TRACKED YET", "尚未记录物品")}</p>
          <span className="assets-widget__recent-leader assets-widget__recent-leader--ghost" aria-hidden="true" />
          <span className="assets-widget__recent-leader assets-widget__recent-leader--ghost" aria-hidden="true" />
          <span className="assets-widget__recent-leader assets-widget__recent-leader--ghost" aria-hidden="true" />
        </div>
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
        defaultW: 26,
        defaultH: 18,
        defaultOrder: 22,
        density: {
          normal: { minW: 16, minH: 12 },
          expanded: { minW: 24, minH: 16 },
        },
      },
    },
  ],
  // No `status` provider on purpose: shell chips are for time-sensitive
  // signals (due counts, running sessions, next alarm). A slowly drifting
  // inventory total is not a notification — Assets stays badge-free.
};

export default app;
