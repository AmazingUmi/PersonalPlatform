export function Settings() {
  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="muted">
        Platform settings are stored in <code>config/platform.yaml</code> and <code>core.settings</code>.
        Secrets always come from environment variables.
      </p>
    </div>
  );
}
