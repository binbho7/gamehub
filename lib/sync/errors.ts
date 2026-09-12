import type { PublicError } from "./types";

export const FATAL_MESSAGES = {
  configuration_error: "Bulk sync input or configuration is invalid.",
  platform_unavailable: "The local bulk sync platform could not be acquired.",
  composition_failed: "Bulk sync stage dependencies could not be created.",
  batch_execution_failed: "Bulk sync could not produce a complete batch result.",
  cleanup_failed: "The local bulk sync platform could not be disposed.",
  output_format_failed: "The bulk sync result could not be formatted.",
  output_write_failed: "The bulk sync result could not be written.",
} as const;

export type FatalCode = keyof typeof FATAL_MESSAGES;

export function publicError<C extends FatalCode>(code: C): PublicError {
  return Object.freeze({ code, message: FATAL_MESSAGES[code] });
}
