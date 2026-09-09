import { api } from "../../shared/api";
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
  status: {
    // Dock/top-bar chip: total note count (hidden at zero).
    load: async () => {
      const summary = await api<{ total: number }>("/api/apps/notes/summary");
      return summary.total > 0
        ? [{ id: "total", label: String(summary.total), tone: "neutral", title: `${summary.total} notes` }]
        : [];
    },
  },
};

export default app;
