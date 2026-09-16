import type { CronSignals, UnsettledImageWorkReason } from "./types";

export function createCronSignals(): CronSignals {
  const unsettled = new Set<UnsettledImageWorkReason>();
  let authorityLoss: "lease_lost" | "fence_lost" | null = null;
  return {
    markAuthorityLoss(code) {
      if (code === "fence_lost" || authorityLoss === null) authorityLoss = code;
    },
    markUnsettled(reason) {
      unsettled.add(reason);
    },
    readAuthorityLoss() {
      return authorityLoss;
    },
    readUnsettledImageWork() {
      return Object.freeze(Array.from(unsettled));
    },
  };
}
