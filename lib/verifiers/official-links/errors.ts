export type LinkVerificationOperationCode =
  | "invalid_game_id"
  | "game_not_found"
  | "link_limit_exceeded"
  | "database_unavailable"
  | "local_platform_unavailable"
  | "write_failed"
  | "cleanup_failed"
  | "unexpected_error";

export class LinkVerificationError extends Error {
  readonly code: LinkVerificationOperationCode;

  constructor(
    code: LinkVerificationOperationCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LinkVerificationError";
    this.code = code;
  }

  toJSON(): {
    name: "LinkVerificationError";
    code: LinkVerificationOperationCode;
    message: string;
  } {
    return {
      name: "LinkVerificationError",
      code: this.code,
      message: this.message,
    };
  }
}
