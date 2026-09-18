# Official Node LTS: https://nodejs.org/en/blog/release/v24.20.0
# OCI index digest checked against registry-1.docker.io, 2026-09-18.
# Local Node socket/lookup/Host probes run separately in conformance.test.ts.
# Docker is unavailable on the implementation host. Image execution and actual
# Cloudflare preview peer/lookup/SNI/certificate probes remain release gates.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY containers/official-link-verifier ./containers/official-link-verifier
COPY lib/verifiers/official-links ./lib/verifiers/official-links
RUN ./node_modules/.bin/esbuild containers/official-link-verifier/main.ts --bundle --platform=node --target=node24 --format=cjs --outfile=/out/main.cjs

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
WORKDIR /app
COPY --from=build --chown=node:node /out/main.cjs ./main.cjs
USER node
EXPOSE 8080
CMD ["node", "main.cjs"]
