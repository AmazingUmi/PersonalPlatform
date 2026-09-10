import { api } from "../../shared/api";
import type { FrontendAppModule } from "../../shared/appTypes";
import { computeNextAlarm, type AlarmView } from "./AlarmSection";
import { ClockPage } from "./ClockPage";
import { ClockWidget } from "./ClockWidget";

const app: FrontendAppModule = {
  id: "clock",
  routes: [{ path: "", label: "Clock", element: <ClockPage /> }],
  widgets: [
    {
      id: "clock",
      title: "Clock",
      render: (context) => <ClockWidget density={context?.layout.density ?? "normal"} />,
      layout: {
        minW: 16,
        minH: 12,
        defaultW: 20,
        defaultH: 16,
        density: {
          normal: { minW: 18, minH: 14 },
          expanded: { minW: 26, minH: 20 },
        },
      },
    },
  ],
  status: {
    // Next armed alarm ("MON 07:30") — the same computation the Clock page's
    // alarm section shows. Time-sensitive like the other chips, and updated
    // by the shell's refresh triggers (focus/route/60s) at minute precision.
    load: async () => {
      const alarms = await api<{ items: AlarmView[] }>("/api/apps/clock/alarms");
      const next = computeNextAlarm(alarms.items, new Date());
      return next
        ? [{ id: "next-alarm", label: next.label, tone: "warning", title: `Next alarm ${next.label}` }]
        : [];
    },
  },
};

export default app;
