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
        defaultW: 20,
        defaultH: 16,
        density: {
          normal: { minW: 16, minH: 12 },
          expanded: { minW: 22, minH: 14 },
        },
      },
    },
  ],
};

export default app;
