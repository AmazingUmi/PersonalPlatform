import type { FrontendAppModule } from "../../shared/appTypes";
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
};

export default app;
