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
  widgets: [{ id: "quick_note", title: "Quick Note", render: () => <QuickNoteWidget /> }],
};

export default app;
