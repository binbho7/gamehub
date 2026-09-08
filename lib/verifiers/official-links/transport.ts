import {
  request as nodeHttpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as nodeHttpsRequest } from "node:https";
import { isIP } from "node:net";
import type { ApprovedDestination } from "./destination";
import { ipAddressesEqual, normalizeIpAddress } from "./ip-safety";
import type { HttpMethod, VerificationAttempt } from "./types";

const DEFAULT_REQUEST_DEADLINE_MS = 8_000;
const MAX_RESPONSE_HEADER_BYTES = 16 * 1_024;

export type TransportResponse = {
  kind: "response";
  status: number;
  locations: string[];
  attempt: VerificationAttempt;
};

export type TransportFailure = {
  kind: "failure";
  code: "timeout" | "network_error" | "tls_error" | "unsafe_destination";
  attempt: VerificationAttempt;
};

export type NodeRequestFactory = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export type RequestHeaders = (
  destination: ApprovedDestination,
  method: HttpMethod,
  options?: { deadlineMs?: number; signal?: AbortSignal },
) => Promise<TransportResponse | TransportFailure>;

type BoundRequestOptions = RequestOptions & {
  autoSelectFamily: false;
};

type BoundLookup = NonNullable<RequestOptions["lookup"]>;
type BoundSocket = NonNullable<ClientRequest["socket"]>;

type HttpsRequestOptions = BoundRequestOptions & {
  rejectUnauthorized: true;
  servername?: string;
};

function boundedDeadline(deadlineMs: number | undefined): number {
  if (deadlineMs === undefined || !Number.isFinite(deadlineMs)) {
    return DEFAULT_REQUEST_DEADLINE_MS;
  }

  return Math.min(DEFAULT_REQUEST_DEADLINE_MS, Math.max(0, Math.floor(deadlineMs)));
}

function hostAuthority(hostname: string): string {
  return isIP(hostname) === 6 ? `[${hostname}]` : hostname;
}

function createBoundLookup(
  destination: ApprovedDestination,
): BoundLookup {
  const { address, family } = destination.selectedAddress;

  return (hostname, options, callback) => {
    if (hostname !== destination.hostname) {
      const error = new Error("Request-bound hostname mismatch") as NodeJS.ErrnoException;
      error.code = "EAI_FAIL";
      callback(error, "", 0);
      return;
    }

    if (options.all === true) {
      callback(null, [{ address, family }]);
      return;
    }

    callback(null, address, family);
  };
}

function rawLocationHeaders(response: IncomingMessage): string[] {
  const locations: string[] = [];
  const rawHeaders = response.rawHeaders;

  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === "location") {
      locations.push(rawHeaders[index + 1]);
    }
  }

  return locations;
}

function isTlsFailure(protocol: ApprovedDestination["protocol"], error: unknown): boolean {
  if (protocol !== "https:" || error === null || typeof error !== "object") {
    return false;
  }

  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  return code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.includes("CERT") ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "UNABLE_TO_GET_ISSUER_CERT" ||
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT";
}

function requestOptionsFor(
  destination: ApprovedDestination,
  method: HttpMethod,
): BoundRequestOptions | HttpsRequestOptions {
  const options: BoundRequestOptions = {
    protocol: destination.protocol,
    hostname: destination.hostname,
    port: destination.port,
    method,
    path: `${destination.requestUrl.pathname}${destination.requestUrl.search}`,
    headers: { Host: hostAuthority(destination.hostname) },
    family: destination.selectedAddress.family,
    lookup: createBoundLookup(destination),
    autoSelectFamily: false,
    agent: false,
    maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
  };

  if (destination.protocol === "http:") return options;

  const httpsOptions: HttpsRequestOptions = {
    ...options,
    rejectUnauthorized: true,
  };
  if (normalizeIpAddress(destination.hostname) === null) {
    httpsOptions.servername = destination.hostname;
  }
  return httpsOptions;
}

function defaultHttpRequest(
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
): ClientRequest {
  return nodeHttpRequest(options, callback);
}

function defaultHttpsRequest(
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
): ClientRequest {
  return nodeHttpsRequest(options, callback);
}

export function createRequestHeaders(dependencies: {
  httpRequest: NodeRequestFactory;
  httpsRequest: NodeRequestFactory;
  now?: () => Date;
}): RequestHeaders {
  const now = dependencies.now ?? (() => new Date());

  return (destination, method, options = {}) => {
    const startedAt = now();
    const selectedAddress = normalizeIpAddress(destination.selectedAddress.address);
    const attempt = (httpStatus: number | null): VerificationAttempt => ({
      method,
      url: destination.exactUrl,
      resolvedAddress: selectedAddress?.address ?? null,
      addressFamily: selectedAddress?.family ?? null,
      httpStatus,
      startedAt,
      finishedAt: now(),
    });

    if (
      selectedAddress === null ||
      selectedAddress.family !== destination.selectedAddress.family ||
      !ipAddressesEqual(selectedAddress.address, destination.selectedAddress.address)
    ) {
      return Promise.resolve({
        kind: "failure",
        code: "unsafe_destination",
        attempt: attempt(null),
      });
    }

    if (options.signal?.aborted) {
      return Promise.resolve({
        kind: "failure",
        code: "timeout",
        attempt: attempt(null),
      });
    }

    return new Promise<TransportResponse | TransportFailure>((resolve) => {
      let request: ClientRequest | null = null;
      let socket: BoundSocket | null = null;
      let response: IncomingMessage | null = null;
      let connectionApproved = false;
      let settled = false;

      const destroyResources = () => {
        response?.destroy();
        socket?.destroy();
        request?.destroy();
      };
      const settle = (result: TransportResponse | TransportFailure) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        destroyResources();
        resolve(result);
      };
      const fail = (code: TransportFailure["code"], error?: unknown) => {
        const sanitizedCode = code === "network_error" && isTlsFailure(destination.protocol, error)
          ? "tls_error"
          : code;
        settle({ kind: "failure", code: sanitizedCode, attempt: attempt(null) });
      };
      const onAbort = () => fail("timeout");
      const onError = (error: unknown) => fail("network_error", error);
      const onResponse = (incoming: IncomingMessage) => {
        if (settled) {
          incoming.destroy();
          return;
        }

        response = incoming;
        if (!connectionApproved) {
          fail("unsafe_destination");
          return;
        }

        const status = incoming.statusCode;
        if (
          typeof status !== "number" ||
          !Number.isInteger(status) ||
          status < 100 ||
          status > 599
        ) {
          fail("network_error");
          return;
        }

        settle({
          kind: "response",
          status,
          locations: rawLocationHeaders(incoming),
          attempt: attempt(status),
        });
      };
      const onSocket = (connectedSocket: BoundSocket) => {
        socket = connectedSocket;
        if (settled) {
          connectedSocket.destroy();
          return;
        }

        const connectionEvent = destination.protocol === "https:"
          ? "secureConnect"
          : "connect";
        connectedSocket.once(connectionEvent, () => {
          if (settled) return;

          const remoteAddress = connectedSocket.remoteAddress;
          const normalizedRemote = typeof remoteAddress === "string"
            ? normalizeIpAddress(remoteAddress)
            : null;
          if (
            normalizedRemote === null ||
            normalizedRemote.family !== selectedAddress.family ||
            !ipAddressesEqual(normalizedRemote.address, selectedAddress.address)
          ) {
            fail("unsafe_destination");
            return;
          }

          connectionApproved = true;
        });
        connectedSocket.once("error", onError);
      };

      const timer = setTimeout(onAbort, boundedDeadline(options.deadlineMs));
      options.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const factory = destination.protocol === "https:"
          ? dependencies.httpsRequest
          : dependencies.httpRequest;
        request = factory(requestOptionsFor(destination, method), onResponse);
        if (settled) {
          request.destroy();
          return;
        }

        request.once("socket", onSocket);
        request.once("error", onError);
        request.once("close", () => {
          if (!settled) fail("network_error");
        });
        request.end();
      } catch (error) {
        onError(error);
      }
    });
  };
}

export const requestHeaders: RequestHeaders = createRequestHeaders({
  httpRequest: defaultHttpRequest,
  httpsRequest: defaultHttpsRequest,
});
