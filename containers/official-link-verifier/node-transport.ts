import { lookup as nodeLookup } from "node:dns/promises";
import { createSafeDestinationResolver } from "../../lib/verifiers/official-links/destination";
import { executeRedirectChain } from "../../lib/verifiers/official-links/redirect";
import { requestHeaders } from "../../lib/verifiers/official-links/transport";
import { verifyUrl } from "../../lib/verifiers/official-links/verifier";
import type { OfficialLinkVerificationTransport } from "../../lib/verifiers/official-links/verification-transport";

export function createLocalNodeVerificationTransport(): OfficialLinkVerificationTransport {
  const resolver = createSafeDestinationResolver({
    lookup: async hostname => (await nodeLookup(hostname, { all: true })).map(({ address, family }) => {
      if (family !== 4 && family !== 6) throw new Error("Unsupported DNS family");
      return { address, family };
    }),
  });
  return {
    verify: (url, options) => verifyUrl(url, {
      executeChain: (target, method, chainOptions) => executeRedirectChain(target, method, {
        resolveDestination: resolver, request: requestHeaders, now: () => new Date(),
      }, chainOptions),
    }, options),
  };
}
