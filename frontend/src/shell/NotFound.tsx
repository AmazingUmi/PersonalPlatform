import { Link } from "react-router-dom";
import { PixelIcon } from "../shared/ui/PixelIcon";

export function NotFound() {
  return (
    <div className="page">
      <div className="notfound">
        <span className="notfound__icon" aria-hidden="true">
          <PixelIcon name="warning" size={32} />
        </span>
        <p className="notfound__code">404</p>
        <h1 className="notfound__title">Not Found</h1>
        <p className="notfound__desc">该页面不存在或对应的 App 已被禁用。</p>
        <Link to="/" className="px-button px-button--primary px-button--md notfound__back">
          <PixelIcon name="back" />
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
