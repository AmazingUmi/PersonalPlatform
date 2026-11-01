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

### Completion notices and optional alerts

The Focus page and dashboard widget show a persistent **Focus complete**, **Short Break complete**, or **Long Break complete** notice after the server confirms that an observed session ended naturally. The next READY timer is a separate session; it does not start automatically. Dismiss the notice with **Dismiss completion**, or start the next session. Pausing and manually stopping do not produce a completion notice. Opening an already idle app does not replay old history.

The mounted timer reconciles at its server deadline, with polling and visibility-return recovery if the network or browser delays execution. A countdown displaying `00:00` is not sufficient evidence of completion. If the terminal record cannot yet be verified, the app retries without announcing success.

- In the dashboard widget, **Alerts** opens **Alert settings**; the compact completion notice and timer actions remain available, and expanded options scroll inside small cards.
- **Enable sound** activates browser audio from your click. **Test sound** plays a short chime; **Mute sound** turns completion audio off. A recovered session also has these controls. Sound readiness and failures appear below the controls.
- **Enable notifications** explicitly requests browser permission; no permission prompt appears on load or expiry. **Disable notifications** turns delivery off. Permission denial, unsupported/insecure contexts, and browser delivery failures leave the visible completion notice available.
- Preferences are held in memory for the current document and authenticated user, with no local-storage requirement. Simultaneous page/widget observers share alert preferences and deduplicate external alerts by user and session. A bounded ledger retains the latest 512 handled sessions per retained user (up to 16 inactive/recent user controllers); sound resources are closed when the last observer unmounts. Separate tabs may each alert; cross-tab or cross-device exactly-once delivery is not promised.

Alerts require a mounted Focus page or widget. Navigating away from both surfaces, closing or suspending the browser, device sleep, network loss, background throttling, muted audio, browser permission restrictions, and OS Do Not Disturb can delay or prevent external alerts. Returning to an open mounted timer can reconcile its observed session. This is not a push service or a guaranteed wakeup alarm.

Browser behavior references: [Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API), [Web Audio autoplay policy](https://developer.chrome.com/blog/autoplay), and [background timer throttling](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API).
