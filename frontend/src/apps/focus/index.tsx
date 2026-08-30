import type { FrontendAppModule } from "../../shared/appTypes";
import { FocusPage } from "./FocusPage";
import { FocusWidget } from "./FocusWidget";

const app: FrontendAppModule = {
  id: "focus",
  routes: [{ path: "", label: "Focus", element: <FocusPage /> }],
  widgets: [{ id: "timer", title: "Focus Timer", render: () => <FocusWidget /> }],
};

export default app;
