/** Read schema declarations from trusted pg_dump SQL, never from COPY rows or function bodies. */
export function extractRestoreSchemas(sql: string): string[] {
  const schemas = new Set<string>();
  let statement = "";
  let position = 0;
  let copyData = false;

  while (position < sql.length) {
    if (copyData) {
      const end = sql.indexOf("\n", position);
      const line = sql.slice(position, end < 0 ? sql.length : end).replace(/\r$/, "");
      if (line === "\\.") copyData = false;
      position = end < 0 ? sql.length : end + 1;
      continue;
    }
    const character = sql[position]!;
    if (sql.startsWith("--", position)) {
      const end = sql.indexOf("\n", position);
      position = end < 0 ? sql.length : end + 1;
      statement += " ";
      continue;
    }
    if (sql.startsWith("/*", position)) {
      let depth = 1;
      position += 2;
      while (position < sql.length && depth > 0) {
        if (sql.startsWith("/*", position)) { depth++; position += 2; }
        else if (sql.startsWith("*/", position)) { depth--; position += 2; }
        else position++;
      }
      if (depth) throw new Error("unterminated SQL comment in backup");
      statement += " ";
      continue;
    }
    // pg_dump emits psql directives such as \restrict/\unrestrict outside SQL.
    if (character === "\\" && !statement.trim()) {
      const end = sql.indexOf("\n", position);
      position = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (character === "'" || character === '"') {
      // pg_dump sets standard_conforming_strings=on. Only E'...' treats
      // backslash as an escape; an ordinary string may end in a backslash.
      const backslashEscapes = character === "'" && /e/i.test(sql[position - 1] ?? "")
        && !/[a-z0-9_$]/i.test(sql[position - 2] ?? "");
      const start = position++;
      let closed = false;
      while (position < sql.length) {
        if (backslashEscapes && sql[position] === "\\") { position += 2; continue; }
        if (sql[position] === character) {
          position++;
          if (sql[position] === character) { position++; continue; }
          closed = true;
          break;
        }
        position++;
      }
      if (!closed) throw new Error("unterminated SQL quote in backup");
      statement += sql.slice(start, position);
      continue;
    }
    if (character === "$") {
      const tag = sql.slice(position).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, position + tag.length);
        if (end < 0) throw new Error("unterminated SQL dollar quote in backup");
        statement += " $$body$$ ";
        position = end + tag.length;
        continue;
      }
    }
    statement += character;
    position++;
    if (character !== ";") continue;

    const complete = statement.trim();
    if (/^CREATE\s+SCHEMA\b/i.test(complete)) {
      const declaration = complete.match(/^CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))\s*;$/i);
      if (!declaration) throw new Error("unsupported schema declaration in backup (canonical identifiers required)");
      const name = declaration[1] ?? declaration[2]!.toLowerCase();
      if (!name.startsWith("pg_") && name !== "information_schema") schemas.add(name);
    }
    copyData = /^COPY\b[\s\S]*\bFROM\s+stdin\s*;$/i.test(complete);
    statement = "";
  }
  if (copyData) throw new Error("unterminated COPY data in backup");
  return [...schemas];
}
