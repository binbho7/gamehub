import type { CronSignals, UnsettledImageWorkReason } from "./types";

export function createCronSignals(): CronSignals {
  const unsettled = new Set<UnsettledImageWorkReason>();
  let authorityLoss: "lease_lost" | "fence_lost" | null = null;
  const validReasons = new Set<UnsettledImageWorkReason>([
    "image_delivery_unknown",
    "image_deadline",
    "image_mutation_unknown",
  ]);
  return {
    markAuthorityLoss(code) {
      if (code === "fence_lost" || authorityLoss === null) authorityLoss = code;
    },
    markUnsettled(reason) {
      if (!validReasons.has(reason)) throw new TypeError("Invalid unsettled image work reason");
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
