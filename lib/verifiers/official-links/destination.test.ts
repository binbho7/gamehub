import { afterEach, describe, expect, it, vi } from "vitest";
import type { SafeHttpUrl } from "./url-safety";
import { validateHttpUrl } from "./url-safety";
import {
  createSafeDestinationResolver,
  type DestinationResolver,
  type LookupAddress,
} from "./destination";

function safeTarget(raw = "https://example.com/path"): SafeHttpUrl {
  const result = validateHttpUrl(raw);
  if (!result.ok) throw new Error(`Invalid test URL: ${raw}`);
  return result.value;
}

function resolverReturning(addresses: LookupAddress[]): DestinationResolver {
  return vi.fn<DestinationResolver>().mockResolvedValue(addresses);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSafeDestinationResolver", () => {
  it("resolves every address verbatim and selects the first normalized safe answer", async () => {
    const target = safeTarget();
    const lookup = resolverReturning([
      { address: "2606:4700:4700:0000:0000:0000:0000:1111", family: 6 },
      { address: "8.8.8.8", family: 4 },
    ]);

    const result = await createSafeDestinationResolver({ lookup })(target);

    expect(result).toEqual({
      ok: true,
      value: {
        ...target,
        selectedAddress: { address: "2606:4700:4700::1111", family: 6 },
      },
    });
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith("example.com", {
      all: true,
      order: "verbatim",
    });
  });

  it("preserves resolver order when IPv4 precedes IPv6", async () => {
    const target = safeTarget();
    const lookup = resolverReturning([
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);

    await expect(createSafeDestinationResolver({ lookup })(target)).resolves.toEqual({
      ok: true,
      value: {
        ...target,
        selectedAddress: { address: "1.1.1.1", family: 4 },
      },
    });
  });

  it("accepts duplicate semantic addresses after normalization without reordering", async () => {
    const target = safeTarget();
    const lookup = resolverReturning([
      { address: "2606:4700:4700:0000:0000:0000:0000:1111", family: 6 },
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "8.8.4.4", family: 4 },
    ]);

    await expect(createSafeDestinationResolver({ lookup })(target)).resolves.toEqual({
      ok: true,
      value: {
        ...target,
        selectedAddress: { address: "2606:4700:4700::1111", family: 6 },
      },
    });
  });

  it("rejects a destination whose only answer is unsafe", async () => {
    const lookup = resolverReturning([{ address: "127.0.0.1", family: 4 }]);

    await expect(
      createSafeDestinationResolver({ lookup })(safeTarget()),
    ).resolves.toEqual({ ok: false, code: "unsafe_destination" });
  });

  it("rejects the whole destination when an unsafe answer follows a public answer", async () => {
    const lookup = resolverReturning([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);

    await expect(
      createSafeDestinationResolver({ lookup })(safeTarget()),
    ).resolves.toEqual({ ok: false, code: "unsafe_destination" });
  });

  it("returns dns_failure when the resolver provides no answers", async () => {
    const lookup = resolverReturning([]);

    await expect(
      createSafeDestinationResolver({ lookup })(safeTarget()),
    ).resolves.toEqual({ ok: false, code: "dns_failure" });
  });

  it.each([
    ["unparseable address", [{ address: "not-an-ip", family: 4 }]],
    ["IPv4 address with IPv6 family", [{ address: "8.8.8.8", family: 6 }]],
    ["IPv6 address with IPv4 family", [{ address: "2606:4700:4700::1111", family: 4 }]],
    ["unsupported family", [{ address: "8.8.8.8", family: 5 }]],
    ["missing address", [{ family: 4 }]],
  ] as const)("fails closed for a malformed %s record", async (_label, records) => {
    const lookup = resolverReturning(records as unknown as LookupAddress[]);

    await expect(
      createSafeDestinationResolver({ lookup })(safeTarget()),
    ).resolves.toEqual({ ok: false, code: "unsafe_destination" });
  });

  it("accepts exactly 16 safe resolver records", async () => {
    const lookup = resolverReturning(
      Array.from({ length: 16 }, (_, index) => ({
        address: `8.8.8.${index + 1}`,
        family: 4 as const,
      })),
    );
    const target = safeTarget();

    await expect(createSafeDestinationResolver({ lookup })(target)).resolves.toEqual({
      ok: true,
      value: {
        ...target,
        selectedAddress: { address: "8.8.8.1", family: 4 },
      },
    });
  });

  it("rejects 17 resolver records before selecting their public first answer", async () => {
    const lookup = resolverReturning(
      Array.from({ length: 17 }, (_, index) => ({
        address: `8.8.8.${index + 1}`,
        family: 4 as const,
      })),
    );

    await expect(
      createSafeDestinationResolver({ lookup })(safeTarget()),
    ).resolves.toEqual({ ok: false, code: "dns_failure" });
  });

  it("maps resolver rejection to dns_failure without exposing the error", async () => {
    const lookup = vi.fn<DestinationResolver>().mockRejectedValue(
      new Error("raw resolver detail"),
    );

    await expect(
      createSafeDestinationResolver({ lookup })(safeTarget()),
    ).resolves.toEqual({ ok: false, code: "dns_failure" });
  });

  it("times out at the default three-second DNS deadline and ignores late completion", async () => {
    vi.useFakeTimers();
    let completeLookup: ((addresses: LookupAddress[]) => void) | undefined;
    const lookup = vi.fn<DestinationResolver>().mockImplementation(
      () => new Promise((resolve) => {
        completeLookup = resolve;
      }),
    );
    const pending = createSafeDestinationResolver({ lookup })(safeTarget());

    await vi.advanceTimersByTimeAsync(2_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: false, code: "timeout" });

    completeLookup?.([{ address: "8.8.8.8", family: 4 }]);
    await Promise.resolve();
    await expect(pending).resolves.toEqual({ ok: false, code: "timeout" });
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("returns timeout when cancellation aborts an in-flight lookup", async () => {
    const controller = new AbortController();
    const lookup = vi.fn<DestinationResolver>().mockImplementation(
      () => new Promise(() => undefined),
    );
    const pending = createSafeDestinationResolver({ lookup })(
      safeTarget(),
      controller.signal,
    );

    controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, code: "timeout" });
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("does not start a lookup when cancellation already occurred", async () => {
    const controller = new AbortController();
    controller.abort();
    const lookup = resolverReturning([{ address: "8.8.8.8", family: 4 }]);

    await expect(
      createSafeDestinationResolver({ lookup })(safeTarget(), controller.signal),
    ).resolves.toEqual({ ok: false, code: "timeout" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["https://8.8.8.8/path", { ok: true, address: "8.8.8.8", family: 4 }],
    [
      "https://[2606:4700:4700:0000:0000:0000:0000:1111]/path",
      { ok: true, address: "2606:4700:4700::1111", family: 6 },
    ],
    ["http://127.0.0.1/path", { ok: false }],
    ["https://[::1]/path", { ok: false }],
  ] as const)("classifies IP literal %s directly without DNS", async (raw, expected) => {
    const target = safeTarget(raw);
    const lookup = resolverReturning([{ address: "1.1.1.1", family: 4 }]);

    const result = await createSafeDestinationResolver({ lookup })(target);

    if (expected.ok) {
      expect(result).toEqual({
        ok: true,
        value: {
          ...target,
          selectedAddress: {
            address: expected.address,
            family: expected.family,
          },
        },
      });
    } else {
      expect(result).toEqual({ ok: false, code: "unsafe_destination" });
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});
