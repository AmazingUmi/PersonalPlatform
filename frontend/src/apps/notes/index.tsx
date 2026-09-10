import type { FrontendAppModule } from "../../shared/appTypes";
import { NoteEditorPage } from "./NoteEditorPage";
import { NotesPage } from "./NotesPage";
import { QuickNoteWidget } from "./QuickNoteWidget";

const app: FrontendAppModule = {
  id: "notes",
  routes: [
    { path: "", label: "Notes", element: <NotesPage /> },
    { path: "new", label: "New Note", element: <NoteEditorPage /> },
    { path: ":id", label: "Edit Note", element: <NoteEditorPage /> },
  ],
  widgets: [
    {
      id: "quick_note",
      title: "Quick Note",
      render: (context) => <QuickNoteWidget density={context?.layout.density ?? "normal"} />,
      layout: {
        minW: 14,
        minH: 10,
        /* Wide band under the data row: the input plus the expanded recent
         * list share a row with the 2048 score card. */
        defaultW: 48,
        defaultH: 18,
        defaultOrder: 30,
        density: {
          normal: { minW: 16, minH: 12 },
          expanded: { minW: 22, minH: 14 },
        },
      },
    },
  ],
  // No `status` provider on purpose: a total note count is a slowly
  // drifting aggregate, not a time-sensitive chip (same call as Assets).
};

export default app;
