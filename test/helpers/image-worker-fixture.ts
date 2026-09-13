// Test-only workerd entrypoint. Production Wrangler never bundles this module.
import { createDatabase } from "../../lib/db/client";
import { createImageIngestRepository } from "../../lib/db/repositories/image-ingest";
import { createR2ImageStore } from "../../lib/images/r2-store";
import { createImageIngestService } from "../../lib/images/service";
import type { WorkerEnv } from "../../lib/images/types";
import { handleImageIngest } from "../../workers/image-ingest/src/index";

const worker = {
  async fetch(request: Request, env: WorkerEnv & { TEST_SOURCE_ORIGIN: string }, ctx: ExecutionContext): Promise<Response> {
    const fixture = new URL(env.TEST_SOURCE_ORIGIN);
    if (fixture.protocol !== "http:" || fixture.hostname !== "127.0.0.1") throw new Error("Test fixture must be local");
    let requestGameId: number | null = null;
    try {
      const payload = await request.clone().json() as unknown;
      if (
        typeof payload === "object"
        && payload !== null
        && Number.isSafeInteger((payload as { gameId?: unknown }).gameId)
      ) {
        requestGameId = (payload as { gameId: number }).gameId;
      }
    } catch {
      // Preserve production request validation for malformed test requests.
    }
    let heads = 0;
    let puts = 0;
    let rowsBeforePut = -1;
    let bindingsBeforePut = -1;
    const bucket = new Proxy(env.IMAGES_BUCKET, {
      get(target, property) {
        if (property === "head") return (key: string) => { heads += 1; return target.head(key); };
        if (property === "put") return async (...args: Parameters<typeof target.put>) => {
          puts += 1;
          const row = requestGameId === null
            ? null
            : await env.DB.prepare(
              `SELECT
                count(*) AS n,
                sum(CASE WHEN storage_key IS NOT NULL THEN 1 ELSE 0 END) AS bindings
              FROM game_images WHERE game_id = ?`,
            ).bind(requestGameId).first<{ n: number; bindings: number }>();
          rowsBeforePut = Number(row?.n ?? 0);
          bindingsBeforePut = Number(row?.bindings ?? 0);
          return target.put(...args);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await handleImageIngest(request, env, ctx, {
      serviceFactory: () => createImageIngestService({
        repository: createImageIngestRepository(createDatabase(env.DB)),
        r2: createR2ImageStore(bucket, env.IMAGE_PUBLIC_BASE_URL),
        fetchImpl: (_url, init) => fetch(new URL("/fixture.jpg", fixture), init),
      }),
    });
    const headers = new Headers(response.headers);
    headers.set("x-test-runtime", "workerd");
    headers.set("x-test-r2-head", String(heads));
    headers.set("x-test-r2-put", String(puts));
    headers.set("x-test-rows-before-put", String(rowsBeforePut));
    headers.set("x-test-bindings-before-put", String(bindingsBeforePut));
    return new Response(response.body, { status: response.status, headers });
  },
};

export default worker;
