import { useEffect, useState } from "react";

type BackendState = "checking" | "online" | "offline";

export function App() {
  const [backendState, setBackendState] = useState<BackendState>("checking");

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/core/health/live", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setBackendState("online");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setBackendState("offline");
      });

    return () => controller.abort();
  }, []);

  return (
    <div className="shell">
      <header className="shell__header">
        <strong>Personal Platform</strong>
        <span className={`status status--${backendState}`}>
          Backend: {backendState}
        </span>
      </header>
      <main className="shell__main">
        <p className="eyebrow">P0 · Repository Bootstrap</p>
        <h1>平台骨架已就绪</h1>
        <p>
          当前仅包含 Web Shell 占位入口和基础健康检查。App Registry、Dashboard、
          业务 App 等能力将按实现计划逐步加入。
        </p>
      </main>
    </div>
  );
}
