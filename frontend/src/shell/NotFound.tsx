import { Link } from "react-router-dom";

export function NotFound() {
  return (
    <section aria-label="Not found">
      <p className="eyebrow">404</p>
      <h1>页面不存在</h1>
      <p>
        该页面不存在或对应的 App 已被禁用。<Link to="/">返回 Dashboard</Link>
      </p>
    </section>
  );
}
