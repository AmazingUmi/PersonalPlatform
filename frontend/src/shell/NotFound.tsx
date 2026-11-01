import { useI18n } from "../shared/i18n";
import { Link } from "react-router-dom";
import { PixelIcon } from "../shared/ui/PixelIcon";

export function NotFound() {
  const { t } = useI18n();
  return (
    <div className="page">
      <div className="notfound">
        <span className="notfound__icon" aria-hidden="true">
          <PixelIcon name="warning" size={32} />
        </span>
        <p className="notfound__code">404</p>
        <h1 className="notfound__title">{t("Not Found", "页面不存在")}</h1>
        <p className="notfound__desc">{t("This page does not exist or its app is disabled.", "该页面不存在或对应的应用已被停用。")}</p>
        <Link to="/" className="px-button px-button--primary px-button--md notfound__back">
          <PixelIcon name="back" />{t("Back to Dashboard", "返回仪表盘")} </Link>
      </div>
    </div>
  );
}
