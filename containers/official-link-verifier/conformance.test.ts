import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as nodeRequest, type ClientRequest, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer, request as nodeHttpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, type TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalNodeVerificationTransport } from "./node-transport";
import { createVerifierServer } from "./server";
import { createRemoteVerifierTransport } from "../../lib/verifiers/official-links/remote/client";
import { VERIFIER_CONFORMANCE_VECTORS } from "../../lib/verifiers/official-links/remote/conformance-vectors";
import { createSafeDestinationResolver, type ApprovedDestination } from "../../lib/verifiers/official-links/destination";
import { executeRedirectChain } from "../../lib/verifiers/official-links/redirect";
import { createRequestHeaders, type NodeRequestFactory } from "../../lib/verifiers/official-links/transport";
import { verifyUrl } from "../../lib/verifiers/official-links/verifier";
import { classifyTerminalOutcome } from "../../lib/verifiers/official-links/classification";
import type { OfficialLinkVerificationTransport } from "../../lib/verifiers/official-links/verification-transport";

const clock = () => new Date(1000);
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return `http://127.0.0.1:${address.port}`;
}

// Same dependency-injection boundary as the V2.5 transport tests: fake only
// external DNS and Node request/socket events, preserving all security logic.
function fixtureTransport(): OfficialLinkVerificationTransport {
  const dnsCalls = new Map<string, number>();
  const resolver = createSafeDestinationResolver({ dnsDeadlineMs: 2, lookup: async hostname => {
    dnsCalls.set(hostname, (dnsCalls.get(hostname) ?? 0) + 1);
    if (hostname === "dns-failure.fixture.org") throw new Error("ENOTFOUND");
    if (hostname === "dns-timeout.fixture.org") return new Promise(() => {});
    if (hostname === "mixed.fixture.org") return [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }];
    if (hostname === "rebind.fixture.org" && dnsCalls.get(hostname)! > 1) return [{ address: "127.0.0.1", family: 4 }];
    if (hostname === "mapped.fixture.org") return [{ address: "::ffff:8.8.8.8", family: 6 }];
    return [{ address: "8.8.8.8", family: 4 }];
  } });
  const factory: NodeRequestFactory = (options, callback) => {
    const hostname = String(options.hostname);
    const path = String(options.path);
    const method = String(options.method);
    const tls = options as typeof options & { servername?: string; rejectUnauthorized?: boolean; autoSelectFamily?: boolean };
    const headers = options.headers as Record<string, string>;
    expect(headers).toEqual({ Host: hostname.includes(":") ? `[${hostname}]` : hostname });
    expect(options.agent).toBe(false);
    expect(tls.autoSelectFamily).toBe(false);
    expect(options.port).toBe(options.protocol === "https:" ? 443 : 80);
    if (options.protocol === "https:") {
      expect(tls.rejectUnauthorized).toBe(true);
      if (hostname.endsWith("fixture.org")) expect(tls.servername).toBe(hostname);
    }
    let selected = hostname.includes(":") ? hostname : "8.8.8.8";
    options.lookup!(hostname, { all: false }, (error, address) => { expect(error).toBeNull(); selected = String(address); });
    options.lookup!(hostname, { all: true }, (error, addresses) => {
      expect(error).toBeNull();
      expect(addresses).toEqual([{ address: selected, family: options.family }]);
    });
    options.lookup!("wrong.fixture.org", {}, error => { expect(error).toBeInstanceOf(Error); });
    let destroyed = false;
    const request = Object.assign(new EventEmitter(), {
      destroy() { destroyed = true; return this; },
      end(...args: unknown[]) {
        expect(args).toEqual([]); // No target request body, including fallback GET.
        queueMicrotask(() => {
          const socket = Object.assign(new EventEmitter(), { remoteAddress: hostname === "peer.fixture.org" ? "1.1.1.1" : hostname === "mapped.fixture.org" ? "::ffff:8.8.8.8" : selected, destroy() { return this; } });
          request.emit("socket", socket);
          if (hostname === "tls.fixture.org") { request.emit("error", { code: "CERT_HAS_EXPIRED" }); return; }
          if (hostname === "network.fixture.org") { request.emit("error", { code: "ECONNRESET" }); return; }
          if (hostname === "timeout.fixture.org") return;
          socket.emit(options.protocol === "https:" ? "secureConnect" : "connect");
          if (destroyed) return;
          let status = 200;
          let locations: string[] = [];
          if (path.startsWith("/status/")) status = Number(path.split("/")[2]);
          if (path.startsWith("/redirect/")) { status = Number(path.split("/")[2]); locations = ["/ok"]; }
          if (path === "/missing") status = 302;
          if (path === "/duplicate") { status = 302; locations = ["/a", "/b"]; }
          if (path === "/malformed") { status = 302; locations = ["http://["]; }
          if (path === "/whitespace") { status = 302; locations = [" /bad"]; }
          if (path === "/downgrade") { status = 302; locations = ["http://target.fixture.org/ok"]; }
          if (path === "/unsafe") { status = 302; locations = ["https://127.0.0.1/"]; }
          if (path === "/rebind") { status = 302; locations = ["/ok"]; }
          if (path === "/loop") { status = 302; locations = ["/loop"]; }
          if (path.startsWith("/overflow/")) { status = 302; locations = [`/overflow/${Number(path.split("/")[2]) + 1}`]; }
          if (path.startsWith("/fallback/")) {
            status = method === "HEAD" ? Number(path.split("/")[2]) : 200;
          }
          if (path.startsWith("/shared/")) {
            const hop = Number(path.split("/")[2]);
            status = method === "HEAD" && hop === 2 ? 405 : 302;
            if (status === 302) locations = [`/shared/${hop + 1}`];
          }
          let responseDestroyed = false;
          const response = Object.assign(new EventEmitter(), { statusCode: status, rawHeaders: locations.flatMap(location => ["Location", location]), destroy() { responseDestroyed = true; return this; } });
          callback(response as unknown as IncomingMessage);
          expect(responseDestroyed).toBe(true);
          expect(response.listenerCount("data")).toBe(0); // Headers-only; GET response body never consumed.
          expect(destroyed).toBe(true);
        });
        return this;
      },
    });
    return request as unknown as ClientRequest;
  };
  const request = createRequestHeaders({ httpRequest: factory, httpsRequest: factory, now: clock });
  return { verify: (url, options) => verifyUrl(url, {
    executeChain: (target, method, chainOptions) => executeRedirectChain(target, method, {
      resolveDestination: resolver, request: (destination, verb, requestOptions) => request(destination, verb, { ...requestOptions, deadlineMs: 2 }), now: clock,
    }, chainOptions),
  }, options) };
}

describe("injected target vectors through local and authenticated HTTP transports", () => {
  it.each(VERIFIER_CONFORMANCE_VECTORS)("$name", async vector => {
    const local = await fixtureTransport().verify(vector.exactUrl);
    expect(local.code).toBe(vector.expectedCode);
    const secret = "b".repeat(64);
    const origin = await listen(createVerifierServer({ secret, transport: fixtureTransport(), nowMs: () => 1000 }));
    const remote = createRemoteVerifierTransport({ secret, nowMs: () => 1000, newRequestId: randomUUID, binding: {
      start: async () => {},
      fetch: request => fetch(origin + new URL(request.url).pathname, { method: request.method, headers: request.headers, body: request.body, signal: request.signal, duplex: "half" } as RequestInit),
    } });
    const result = await remote.verify(vector.exactUrl);
    expect(result).toEqual(local);
    expect(classifyTerminalOutcome(result)).toBe(classifyTerminalOutcome(local));
    if (vector.name.startsWith("fallback")) expect(result.attempts.map(attempt => [attempt.method, attempt.url])).toEqual([["HEAD", vector.exactUrl], ["GET", vector.exactUrl]]);
    if (vector.name === "shared redirect budget") {
      expect(result.attempts.map(attempt => attempt.method)).toEqual(["HEAD", "HEAD", "HEAD", "GET", "GET", "GET", "GET"]);
      expect(result.attempts[3].url).toBe(vector.exactUrl);
    }
  });
});

describe("real Node socket capability (local OS, not Container preview)", () => {
  it("preserves TLS SNI and validates certificate identity with custom lookup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "verifier-tls-"));
    try {
      const keyPath = join(directory, "key.pem");
      const certPath = join(directory, "cert.pem");
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=target.fixture.org", "-addext", "subjectAltName=DNS:target.fixture.org", "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
      const key = readFileSync(keyPath);
      const cert = readFileSync(certPath);
      let sni: string | undefined;
      let peer: string | undefined;
      let host: string | undefined;
      const origin = await listen(createHttpsServer({ key, cert, SNICallback: (name, callback) => { sni = name; callback(null, createSecureContext({ key, cert })); } }, (request, response) => {
        peer = (request.socket as TLSSocket).remoteAddress;
        host = request.headers.host;
        response.writeHead(200); response.end("body");
      }));
      const port = Number(new URL(origin).port);
      const destination = (hostname: string) => ({ exactUrl: `https://${hostname}/`, requestUrl: new URL(`https://${hostname}/`), protocol: "https:", hostname, port, selectedAddress: { address: "127.0.0.1", family: 4 } }) as ApprovedDestination;
      const trusted = createRequestHeaders({ httpRequest: nodeRequest, httpsRequest: (options, callback) => nodeHttpsRequest({ ...options, ca: cert }, callback) });
      expect((await trusted(destination("target.fixture.org"), "HEAD")).kind).toBe("response");
      expect(sni).toBe("target.fixture.org");
      expect(peer).toBe("127.0.0.1");
      expect(host).toBe("target.fixture.org");
      expect(await trusted(destination("wrong.fixture.org"), "HEAD")).toMatchObject({ kind: "failure", code: "tls_error" });
      const untrusted = createRequestHeaders({ httpRequest: nodeRequest, httpsRequest: nodeHttpsRequest });
      expect(await untrusted(destination("target.fixture.org"), "HEAD")).toMatchObject({ kind: "failure", code: "tls_error" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("uses a bound lookup and observes the real connected peer while preserving Host", async () => {
    let host: string | undefined;
    const origin = await listen(createServer((request, response) => { host = request.headers.host; response.writeHead(200); response.end("body"); }));
    const port = Number(new URL(origin).port);
    // Test-only approved destination reaches the local fixture. No production
    // resolver override exists, and production URL validation still rejects it.
    const destination = { exactUrl: "http://target.fixture.org/", requestUrl: new URL("http://target.fixture.org/"), protocol: "http:", hostname: "target.fixture.org", port, selectedAddress: { address: "127.0.0.1", family: 4 } } as ApprovedDestination;
    const transport = createRequestHeaders({ httpRequest: nodeRequest, httpsRequest: () => { throw new Error("Unexpected TLS"); } });
    const result = await transport(destination, "GET");
    expect(result.kind).toBe("response");
    expect(result.attempt.resolvedAddress).toBe("127.0.0.1");
    expect(host).toBe("target.fixture.org");
  });
});

describe("production Node composition", () => {
  it("blocks loopback without opening a target socket", async () => {
    const result = await createLocalNodeVerificationTransport().verify("http://127.0.0.1/");
    expect(result.code).toBe("unsafe_destination");
    expect(result.attempts).toEqual([]);
  });
});
