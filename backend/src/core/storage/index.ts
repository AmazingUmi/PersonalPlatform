export interface Storage {
  save(key: string, data: Buffer | Uint8Array | string): Promise<void>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** List object keys under `prefix`, relative to the storage root. */
  list(prefix?: string): Promise<string[]>;
  /** Cheap existence check for reconciliation passes. */
  exists(key: string): Promise<boolean>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid_path" | "not_found" | "io_error",
  ) {
    super(message);
    this.name = "StorageError";
  }
}

/** Standardize a user-supplied key: POSIX separators, no traversal, no absolute paths. */
export function sanitizeKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new StorageError("storage key must be a non-empty string", "invalid_path");
  }
  if (key.includes("\0")) {
    throw new StorageError("storage key contains a null byte", "invalid_path");
  }
  // Treat backslashes as separators so Windows-style traversal cannot slip through.
  const normalized = key.replaceAll("\\", "/");
  if (normalized.startsWith("/")) {
    throw new StorageError("storage key must not be absolute", "invalid_path");
  }
  if (normalized === "") {
    throw new StorageError("storage key resolves to the storage root", "invalid_path");
  }
  const segments = normalized.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    throw new StorageError("storage key contains a traversal segment", "invalid_path");
  }
  return normalized;
}
