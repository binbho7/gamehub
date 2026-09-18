import { expect, it, vi } from "vitest";
const platform = vi.hoisted(() => ({ start: vi.fn(async () => {}), fetch: vi.fn(async () => new Response("ok")) }));
vi.mock("@cloudflare/containers", () => ({ Container: class {
  constructor(public ctx: unknown, public env: { VERIFIER_SERVICE_SECRET: string }) {}
  startAndWaitForPorts = platform.start;
  containerFetch = platform.fetch;
  renewActivityTimeout() {}
} }));
import { createPrivateVerifierBinding, OfficialLinkVerifier } from "./verifier-container";

it("passes only the verifier secret to a bounded Container startup", async () => {
  const container = new OfficialLinkVerifier({} as ConstructorParameters<typeof OfficialLinkVerifier>[0], { VERIFIER_SERVICE_SECRET: "verifier-canary" });
  await container.startVerifier(1000);
  expect(platform.start.mock.calls[0]).toMatchObject([{ ports: 8080, startOptions: { envVars: { VERIFIER_SERVICE_SECRET: "verifier-canary" } },
    cancellationOptions: { instanceGetTimeoutMS: 1000, portReadyTimeoutMS: 1000 } }]);
  await expect(container.startVerifier(10001)).rejects.toThrow();
});
it("does not restart on forwarding failure or expose transport exception secrets", async () => {
  const fetch = async () => { throw new Error("owner-canary credential-canary"); };
  const container = new OfficialLinkVerifier({ container: { getTcpPort: () => ({ fetch }) } } as never,
    { VERIFIER_SERVICE_SECRET: "verifier-canary" });
  const result = await container.fetch(new Request("http://official-link-verifier/internal"));
  expect(result.status).toBe(503);
  expect(await result.text()).not.toMatch(/canary/);
  expect(() => container.onError(new Error("credential-canary"))).toThrow("Verifier container unavailable");
});
it("replaces startup exceptions before crossing the RPC boundary", async () => {
  platform.start.mockRejectedValueOnce(new Error("credential-canary"));
  const container = new OfficialLinkVerifier({} as ConstructorParameters<typeof OfficialLinkVerifier>[0], { VERIFIER_SERVICE_SECRET: "secret" });
  await expect(container.startVerifier(1000)).rejects.toThrow("Verifier container unavailable");
});
it("selects one fixed instance and starts it only through the bounded facade", async () => {
  const names: string[] = [];
  const budgets: number[] = [];
  const binding = createPrivateVerifierBinding({ idFromName(name: string) { names.push(name); return name; },
    get() { return { startVerifier: async (ms: number) => { budgets.push(ms); }, fetch: async () => new Response("private") }; },
  } as never);
  await binding.start(999);
  expect(await (await binding.fetch(new Request("http://private/internal"))).text()).toBe("private");
  expect(names).toEqual(["official-links-v1"]);
  expect(budgets).toEqual([999]);
});
