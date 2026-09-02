export type SteamImportErrorCode =
  | "taxonomy_conflict"
  | "company_conflict"
  | "write_conflict"
  | "write_incomplete";

export class SteamImportError extends Error {
  constructor(
    public readonly code: SteamImportErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SteamImportError";
  }
}
