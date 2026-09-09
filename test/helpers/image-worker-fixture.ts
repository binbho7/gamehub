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
    let heads = 0;
    let puts = 0;
    let rowsBeforePut = -1;
    const bucket = new Proxy(env.IMAGES_BUCKET, {
      get(target, property) {
        if (property === "head") return (key: string) => { heads += 1; return target.head(key); };
        if (property === "put") return async (...args: Parameters<typeof target.put>) => {
          puts += 1;
          const row = await env.DB.prepare("SELECT count(*) AS n FROM game_images").first<{ n: number }>();
          rowsBeforePut = Number(row?.n ?? 0);
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
    return new Response(response.body, { status: response.status, headers });
  },
};

export default worker;
