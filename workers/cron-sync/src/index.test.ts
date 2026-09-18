import { expect, it, vi } from "vitest";
vi.mock("@cloudflare/containers", () => ({ Container: class {} }));
import cronWorker from "./index";

it.each(["/", "/sync", "/internal/sync", "/__scheduled"])("has no manual synchronization route: %s", async path => {
  const response = await cronWorker.fetch(new Request(`https://scheduler.invalid${path}`, { method: "POST" }));
  expect(response.status).toBe(404);
});
it("contains configuration errors and emits no credentials, authority or exception text", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await cronWorker.scheduled({ scheduledTime: 0 } as ScheduledController,
      { TWITCH_CLIENT_SECRET: "credential-canary", ownerToken: "owner-canary" } as never,
      {} as ExecutionContext);
    const text = log.mock.calls.flat().join("\n");
    expect(text).toContain("configuration_error");
    expect(text).not.toMatch(/credential-canary|owner-canary|TWITCH|ownerToken/);
    expect(log).toHaveBeenCalledTimes(2);
  } finally { log.mockRestore(); }
});
it("contains an acquisition failure without retry or exception leakage", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  let attempted = 0;
  try {
    await cronWorker.scheduled({ scheduledTime: 0 } as ScheduledController, {
      DB: { prepare() { attempted++; throw new Error("owner-canary credential-canary https://private.invalid"); }, batch() {} },
      IMAGE_INGEST: { fetch() {} }, VERIFIER_CONTAINER: { idFromName() {}, get() {} },
      TWITCH_CLIENT_ID: "client", TWITCH_CLIENT_SECRET: "credential-canary",
      VERIFIER_SERVICE_SECRET: "verifier-canary", IMAGE_INGEST_SCHEDULED_TOKEN: "image-canary",
    } as never, {} as ExecutionContext);
    expect(attempted).toBe(1);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("lease_acquire_failed");
    expect(output).not.toMatch(/canary|private.invalid/);
  } finally { log.mockRestore(); }
});
