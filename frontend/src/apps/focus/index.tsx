import type { FrontendAppModule } from "../../shared/appTypes";
import { fetchFocusState } from "./api";
import { FocusPage } from "./FocusPage";
import { FocusWidget } from "./FocusWidget";
import { FOCUS_CHANNEL } from "./useFocusState";

const app: FrontendAppModule = {
  id: "focus",
  routes: [{ path: "", label: "Focus", element: <FocusPage /> }],
  widgets: [
    {
      id: "timer",
      title: "Focus Timer",
      render: () => <FocusWidget />,
      /* Slightly wider than the other satellites so its countdown panel
       * breathes and the first dashboard row fills edge to edge. */
      layout: { minW: 16, minH: 12, defaultW: 22, defaultH: 16 },
    },
  ],
  status: {
    // ● while a session is live — the same channel useFocusState broadcasts
    // on after every mutation flips the badge in every open tab at once.
    load: async () => {
      const state = await fetchFocusState();
      return state.active !== null
        ? [{ id: "running", label: "●", tone: "success", title: "Focus session in progress" }]
        : [];
    },
    subscribe: (onChange) => {
      if (typeof BroadcastChannel === "undefined") return () => {};
      const channel = new BroadcastChannel(FOCUS_CHANNEL);
      channel.onmessage = () => onChange();
      return () => {
        channel.onmessage = null;
        channel.close();
      };
    },
  },
};

export default app;
