import type { FrontendAppModule } from "../../shared/appTypes";
import { ClockPage } from "./ClockPage";
import { ClockWidget } from "./ClockWidget";

const app: FrontendAppModule = {
  id: "clock",
  routes: [{ path: "", label: "Clock", element: <ClockPage /> }],
  widgets: [{ id: "clock", title: "Clock", render: () => <ClockWidget /> }],
};

export default app;
