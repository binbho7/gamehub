import { Container } from "@cloudflare/containers";
import type { PrivateVerifierBinding } from "../../../lib/verifiers/official-links/remote/types";

// This DO is only the supported Container lifecycle facade. It owns no lease,
// candidate, domain mutation or scheduler state. The server admits one verifier.
export class OfficialLinkVerifier extends Container<{ VERIFIER_SERVICE_SECRET: string }> {
  defaultPort = 8080;
  sleepAfter = "5m";

  async startVerifier(timeoutMs: number): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) {
      throw new Error("Invalid verifier startup budget");
    }
    try {
      await this.startAndWaitForPorts({ ports: 8080,
        startOptions: { envVars: { VERIFIER_SERVICE_SECRET: this.env.VERIFIER_SERVICE_SECRET } },
        cancellationOptions: { abort: AbortSignal.timeout(timeoutMs), instanceGetTimeoutMS: timeoutMs, portReadyTimeoutMS: timeoutMs },
      });
    } catch { throw new Error("Verifier container unavailable"); }
  }

  override async fetch(request: Request): Promise<Response> {
    // The SDK's containerFetch automatically restarts and logs raw proxy errors.
    // Startup is exclusively startVerifier; forwarding uses the platform TCP port.
    try {
      if (!this.ctx.container) throw new Error("Container unavailable");
      this.renewActivityTimeout();
      return await this.ctx.container.getTcpPort(8080).fetch(request);
    } catch {
      return new Response("Verifier container unavailable", { status: 503 });
    }
  }

  override onError(_error: unknown): never { void _error; throw new Error("Verifier container unavailable"); }
}

export function createPrivateVerifierBinding(namespace: DurableObjectNamespace<OfficialLinkVerifier>): PrivateVerifierBinding {
  // Resolve lazily: composition must not start a Container or do external I/O.
  let stub: DurableObjectStub<OfficialLinkVerifier> | undefined;
  const instance = () => stub ??= namespace.get(namespace.idFromName("official-links-v1"));
  return { start: timeoutMs => instance().startVerifier(timeoutMs), fetch: request => instance().fetch(request) };
}
