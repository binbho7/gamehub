const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function isSafeBatchId(value: string): boolean {
  return BATCH_ID_PATTERN.test(value) && !value.includes("..");
}

export function assertSafeBatchId(value: string): void {
  if (!isSafeBatchId(value)) throw new Error("batch-id must start alphanumeric, contain only letters, numbers, _, -, or ., and cannot contain ..");
}
