import { describe, expect, it, vi } from "vitest";
import { emitCronEvent } from "./logging";

describe("allowlisted Cron logs", () => {
  it("serializes one bounded scalar event and swallows a sink failure without retry", () => {
    const sink = vi.fn((_line: string) => { void _line; throw new Error("sink failed"); });
    expect(() => emitCronEvent({ event: "cron_started", executionId: "run", timestamp: 0 }, sink)).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sink.mock.calls[0][0])).toEqual({ event: "cron_started", executionId: "run", timestamp: 0 });
  });
  it.each([
    { ownerToken: "owner-canary" }, { url: "https://credential-canary.invalid" }, { games: [] },
    { timestamp: -1 }, { executionId: "https://secret.invalid" }, { executionId: "x".repeat(129) },
    { stage: "steam" }, { event: "unknown" }, { timestamp: Number.NaN },
  ])("rejects unsafe or event-inappropriate fields before serialization: %j", extra => {
    const lines: string[] = [];
    const event = { event: "cron_started", executionId: "run", timestamp: 0, ...extra };
    // Exercise the runtime trust boundary, including callers outside TypeScript.
    expect(() => emitCronEvent(event as Parameters<typeof emitCronEvent>[0], line => lines.push(line))).not.toThrow();
    expect(lines).toEqual([]);
  });
});
