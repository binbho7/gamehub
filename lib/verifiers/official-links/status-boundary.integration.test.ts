import { EventEmitter } from "node:events";
import type {
  ClientRequest,
  IncomingMessage,
} from "node:http";
import type { AnyD1Database } from "drizzle-orm/d1";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../db/client";
import { createLinkVerificationStore } from "../../db/repositories/link-verification";
import { createD1TestBinding } from "../../../test/d1-test-env";
import { createSafeDestinationResolver } from "./destination";
import { executeRedirectChain } from "./redirect";
import {
  createLinkVerificationService,
  type VerifyBoundUrl,
} from "./service";
import {
  createRequestHeaders,
  type NodeRequestFactory,
} from "./transport";
import { verifyUrl } from "./verifier";

const GAME_ID = 7;
const PUBLIC_ADDRESS = "8.8.8.8";
const PLAN_TIME = new Date("2026-09-07T12:00:00.000Z");

class PipelineSocket extends EventEmitter {
  readonly remoteAddress = PUBLIC_ADDRESS;

  destroy(): this {
    return this;
  }
}

class PipelineResponse {
  readonly rawHeaders: string[] = [];

  constructor(readonly statusCode: number) {}

  destroy(): this {
    return this;
  }
}

class PipelineRequest extends EventEmitter {
  constructor(private readonly dispatchResponse: () => void) {
    super();
  }

  end(): this {
    queueMicrotask(this.dispatchResponse);
    return this;
  }

  destroy(): this {
    return this;
  }
}

function responseFactory(statuses: number[]): NodeRequestFactory {
  let index = 0;

  return (_options, callback) => {
    const status = statuses[index];
    index += 1;
    if (status === undefined) throw new Error("Unexpected pipeline request");

    const request = new PipelineRequest(() => {
      const socket = new PipelineSocket();
      request.emit("socket", socket);
      socket.emit("connect");
      callback(new PipelineResponse(status) as unknown as IncomingMessage);
    });
    return request as unknown as ClientRequest;
  };
}

async function seedLinks(binding: AnyD1Database): Promise<void> {
  await binding.prepare(`
    INSERT INTO games (id, slug, title, created_at, updated_at)
    VALUES (?, 'status-boundary', 'Status Boundary', 1000, 1000)
  `).bind(GAME_ID).run();
  await binding.prepare(`
    INSERT INTO game_official_links (
      id, game_id, provider, link_type, url, created_at, updated_at
    ) VALUES
      (11, ?, 'publisher', 'official_website', 'http://first.example.com/', 1000, 1000),
      (12, ?, 'publisher', 'official_website', 'http://second.example.com/', 1000, 1000)
  `).bind(GAME_ID, GAME_ID).run();
}

describe("HTTP status contract across verification and persistence", () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => dispose?.());

  it("sanitizes HTTP 700 per link and still persists a valid sibling", async () => {
    const testEnv = await createD1TestBinding();
    dispose = testEnv.dispose;
    await seedLinks(testEnv.binding);
    const store = createLinkVerificationStore(createDatabase(testEnv.binding));
    const httpRequest = responseFactory([700, 204]);
    const request = createRequestHeaders({
      httpRequest,
      httpsRequest: () => {
        throw new Error("Unexpected HTTPS request");
      },
    });
    const resolveDestination = createSafeDestinationResolver({
      lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    });
    const executeChain = (
      exactUrl: Parameters<typeof executeRedirectChain>[0],
      method: Parameters<typeof executeRedirectChain>[1],
      options?: Parameters<typeof executeRedirectChain>[3],
    ) => executeRedirectChain(exactUrl, method, {
      resolveDestination,
      request,
      now: () => PLAN_TIME,
    }, options);
    const verifyBoundUrl: VerifyBoundUrl = (exactUrl, options) => (
      verifyUrl(exactUrl, { executeChain }, options)
    );
    const service = createLinkVerificationService({
      store,
      verifyUrl: verifyBoundUrl,
      now: () => PLAN_TIME,
    });

    const result = await service.verifyGame(GAME_ID, { dryRun: false });

    expect(result).toMatchObject({
      status: "applied",
      affectedRows: 2,
      conflicts: [],
      plan: {
        verificationResults: [
          {
            linkId: 11,
            code: "network_error",
            classification: "unknown",
            finalUrl: null,
            httpStatus: null,
            attempts: [{ httpStatus: null }],
          },
          {
            linkId: 12,
            code: "http_result",
            classification: "verified",
            finalUrl: "http://second.example.com/",
            httpStatus: 204,
            attempts: [{ httpStatus: 204 }],
          },
        ],
      },
    });
    const stored = await testEnv.binding.prepare(`
      SELECT id, verification_status, verification_method, http_status
      FROM game_official_links
      ORDER BY id
    `).all();
    expect(stored.results).toEqual([
      {
        id: 11,
        verification_status: "unknown",
        verification_method: "http",
        http_status: null,
      },
      {
        id: 12,
        verification_status: "verified",
        verification_method: "http",
        http_status: 204,
      },
    ]);
  });
});
