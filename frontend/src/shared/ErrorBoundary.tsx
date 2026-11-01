import { useI18n } from "./i18n";
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

/** Catches render errors so one bad widget/app page cannot break the shell. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("ErrorBoundary caught:", error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? <ErrorFallback />;
    }
    return this.props.children;
  }
}

function ErrorFallback() { const { t } = useI18n(); return <div className="error-boundary">{t("Something went wrong.", "出现错误，请重试。")}</div>; }
