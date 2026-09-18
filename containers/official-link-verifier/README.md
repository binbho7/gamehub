# Private official-link verifier

The only operation is authenticated `POST /internal/v1/official-links/verify` on
port 8080. Supply `VERIFIER_SERVICE_SECRET` (at least 32 random bytes) at runtime.
Use the private Container binding; do not publish a public service route. Runtime
needs no D1, R2, image-ingest token, Twitch credentials, or scheduler authority.

The production composition uses the existing V2.5 safe URL, DNS, pinned lookup,
peer checking, TLS validation, redirect and headers-only HEAD/GET implementation.
Test-only dependency injection is confined to the conformance test. One target
verification runs at a time; concurrent authenticated requests receive signed
503 responses. Disconnect and budget expiry abort target work.

From the repository root:

```sh
npx vitest run containers/official-link-verifier lib/verifiers/official-links
docker build -f containers/official-link-verifier/Dockerfile -t gamehub-verifier:v2.8-local .
docker run --rm --env VERIFIER_SERVICE_SECRET -p 127.0.0.1:8080:8080 gamehub-verifier:v2.8-local
```

The Dockerfile-specific ignore file restricts the repository build context; the
final non-root image contains only the compiled verifier and its bundled zod
dependency. The official Node 24.20.0 LTS image is pinned by registry OCI digest.

## Verification evidence (2026-09-18)

- Local Node v26.8.1: 1,016 verifier tests pass, including authenticated HTTP
  parity over the conformance vectors and real localhost HTTP/TLS socket tests.
  The TLS probe generates a temporary self-signed fixture with OpenSSL and checks
  custom lookup, real peer, Host/SNI, trusted identity, mismatched identity and
  untrusted-certificate rejection. These are local OS probes.
- Bundling with the Dockerfile's esbuild command passes. The compiled main was
  started on port 8080 with an environment containing only a generated verifier
  secret; auth rejection and independently verified signed unsafe-target output
  pass. Dependency metadata contains only verifier modules, zod, and Node DNS,
  net, HTTP and HTTPS imports.
- Typecheck, lint and diff whitespace checks pass.
- Docker execution is **BLOCKED**: `docker build` exits 127 because Docker is
  not installed on the implementation host. Neither the pinned Linux image nor
  Cloudflare Container preview has executed these probes yet.

Before deployment, run the image and repeat authenticated protocol conformance
plus actual peer/custom-lookup/Host/SNI/certificate probes inside the pinned
Container runtime. Keep scheduling disabled until those checks pass. A local or
injected test result is not evidence of deployed Container capability.
