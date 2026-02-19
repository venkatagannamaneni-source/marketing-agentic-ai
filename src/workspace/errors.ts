// ── Workspace Error Codes ────────────────────────────────────────────────────

export type WorkspaceErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "WRITE_FAILED"
  | "READ_FAILED"
  | "INVALID_PATH"
  | "LOCK_TIMEOUT"
  | "PARSE_ERROR"
  | "VALIDATION_ERROR"
  | "WORKSPACE_NOT_INITIALIZED";

// ── Workspace Error ──────────────────────────────────────────────────────────

export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly code: WorkspaceErrorCode,
    public readonly path?: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}
