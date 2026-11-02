import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { editorBaseHash, singletonBaseHash } from "../../src/core/data-management/sync-fence.js";
import { semanticHash } from "../../src/core/data-management/sync-protocol.js";

describe("editor base hash", () => {
  it("matches semanticHash for one snapshot row and ignores API camelCase", () => {
    const row = { id: "11111111-1111-1111-1111-111111111111", title: "A", updated_at: "2026-01-01T00:00:00.000Z", user_id: "u" };
    assert.equal(editorBaseHash([{ table: "tasks.tasks", row }]), semanticHash(row));
    const view = { id: row.id, title: row.title, updatedAt: row.updated_at };
    assert.notEqual(editorBaseHash([{ table: "tasks.tasks", row: view }]), semanticHash(row));
  });

  it("changes when only a link row changes", () => {
    const note = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", title: "n", content: "c" };
    const link = { note_id: note.id, tag_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" };
    const alone = editorBaseHash([{ table: "notes.notes", row: note }]);
    const withLink = editorBaseHash([
      { table: "notes.notes", row: note },
      { table: "notes.note_tags", row: link },
    ]);
    assert.notEqual(alone, withLink);
    const reversed = editorBaseHash([
      { table: "notes.note_tags", row: link },
      { table: "notes.notes", row: note },
    ]);
    assert.equal(withLink, reversed);
  });

  it("uses one absence hash for a missing settings row", () => {
    const row = { id: "current", value: { displayMode: "digital", showSeconds: true, showDate: true, hourFormat: 24 } };
    assert.equal(singletonBaseHash("clock.settings", row), singletonBaseHash("clock.settings", { ...row }));
  });
});
