/** Shared across service and adapters so a late read cannot start a mutation. */
export type ImageOperationContext = {
  signal: AbortSignal;
  deadlineAt: number;
  now: () => number;
};

export class ImageDeadlineError extends Error {
  constructor() {
    super("image_deadline");
    this.name = "ImageDeadlineError";
  }
}

export function assertImageOperationAlive(context?: ImageOperationContext): void {
  if (context && (context.signal.aborted || context.now() >= context.deadlineAt)) {
    throw new ImageDeadlineError();
  }
}
