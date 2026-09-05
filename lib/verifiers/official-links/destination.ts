import {
  classifyIpAddress,
  type NormalizedIpAddress,
} from "./ip-safety";
import type { SafeHttpUrl } from "./url-safety";

const DEFAULT_DNS_DEADLINE_MS = 3_000;
const MAX_DNS_RESULTS = 16;

export type LookupAddress = { address: string; family: 4 | 6 };

export type DestinationResolver = (
  hostname: string,
  options: { all: true; order: "verbatim" },
) => Promise<LookupAddress[]>;

export type ApprovedDestination = SafeHttpUrl & {
  selectedAddress: NormalizedIpAddress;
};

export type DestinationResult =
  | { ok: true; value: ApprovedDestination }
  | { ok: false; code: "dns_failure" | "timeout" | "unsafe_destination" };

export type ResolveSafeDestination = (
  target: SafeHttpUrl,
  signal?: AbortSignal,
) => Promise<DestinationResult>;

type LookupOutcome =
  | { type: "resolved"; addresses: LookupAddress[] }
  | { type: "dns_failure" }
  | { type: "timeout" };

type AddressClassification =
  | { ok: true; selectedAddress: NormalizedIpAddress }
  | { ok: false; code: "dns_failure" | "unsafe_destination" };

function lookupWithDeadline(
  lookup: DestinationResolver,
  hostname: string,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<LookupOutcome> {
  if (signal?.aborted) return Promise.resolve({ type: "timeout" });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: LookupOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish({ type: "timeout" });
    const timer = setTimeout(() => finish({ type: "timeout" }), deadlineMs);

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      void lookup(hostname, { all: true, order: "verbatim" }).then(
        (addresses) => finish({ type: "resolved", addresses }),
        () => finish({ type: "dns_failure" }),
      );
    } catch {
      finish({ type: "dns_failure" });
    }
  });
}

function classifyLookupAddresses(addresses: LookupAddress[]): AddressClassification {
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > MAX_DNS_RESULTS) {
    return { ok: false, code: "dns_failure" };
  }

  const normalizedAddresses: NormalizedIpAddress[] = [];
  const seen = new Set<string>();

  for (const record of addresses) {
    if (
      record === null ||
      typeof record !== "object" ||
      typeof record.address !== "string" ||
      (record.family !== 4 && record.family !== 6)
    ) {
      return { ok: false, code: "unsafe_destination" };
    }

    const decision = classifyIpAddress(record.address);
    if (!decision.safe || decision.value.family !== record.family) {
      return { ok: false, code: "unsafe_destination" };
    }

    const key = `${decision.value.family}:${decision.value.address}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalizedAddresses.push(decision.value);
    }
  }

  const selectedAddress = normalizedAddresses[0];
  if (selectedAddress === undefined) return { ok: false, code: "dns_failure" };

  return {
    ok: true,
    selectedAddress,
  };
}

export function createSafeDestinationResolver(dependencies: {
  lookup: DestinationResolver;
  dnsDeadlineMs?: number;
}): ResolveSafeDestination {
  const dnsDeadlineMs = dependencies.dnsDeadlineMs ?? DEFAULT_DNS_DEADLINE_MS;

  return async (target, signal) => {
    if (signal?.aborted) return { ok: false, code: "timeout" };

    const literalDecision = classifyIpAddress(target.hostname);
    if (literalDecision.value !== null) {
      return literalDecision.safe
        ? {
            ok: true,
            value: { ...target, selectedAddress: literalDecision.value },
          }
        : { ok: false, code: "unsafe_destination" };
    }

    const outcome = await lookupWithDeadline(
      dependencies.lookup,
      target.hostname,
      dnsDeadlineMs,
      signal,
    );
    if (outcome.type === "timeout") return { ok: false, code: "timeout" };
    if (outcome.type === "dns_failure") return { ok: false, code: "dns_failure" };

    const classified = classifyLookupAddresses(outcome.addresses);
    if (!classified.ok) return classified;

    return {
      ok: true,
      value: { ...target, selectedAddress: classified.selectedAddress },
    };
  };
}
