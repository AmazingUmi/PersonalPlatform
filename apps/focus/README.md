# Focus

Pomodoro timer app: run focus/break sessions, browse focus history and
statistics, and control the timer from a dashboard quick widget.

- Tables: `sessions` (one-active-session pomodoro runs) and `settings` (jsonb
  key-value app settings)
- Schema: `focus.*`
- See [doc/APP_DEVELOPMENT.md](../../doc/APP_DEVELOPMENT.md) for the app
  contract and development workflow.

Client reads share request ordering and mount/mutation guards. Starting a
mutation invalidates older reads; only the latest issued read can update the
state or error. Mutation responses and typed HTTP 409 conflict states take
precedence, and accepted results settle loading. Background failures preserve
valid state; a failed first load remains visible and retryable. Cleanup makes
outstanding requests inert, including StrictMode effect replays.

The countdown anchors the server's `now` to `performance.now()` on each
accepted state and advances from that monotonic delta. Client wall-clock
offsets or adjustments do not change it; paused time stays fixed and running
time stops at zero. Visibility changes, cross-tab messages and visible-only
15-second polling refresh the server state. This is not clock synchronization:
response transit latency remains an error source until the next calibration.
