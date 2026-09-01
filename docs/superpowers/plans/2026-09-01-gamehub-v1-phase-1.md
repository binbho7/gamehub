# GameHub V1 Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a responsive, dark, media-led GameHub frontend prototype with searchable mock game data, browse pages, and complete game details.

**Architecture:** A single Next.js 16 App Router application uses typed mock data as its source of truth. Server components compose pages and metadata; focused client components own search, filters, mobile navigation, and gallery interaction. Shared layout and shadcn-style UI primitives enforce consistent tokens and accessibility.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui conventions, Lucide icons, Vitest.

**Spec:** `docs/product-spec.md`

## Global Constraints

- Work directly in the current repository root with no nested app directory.
- Use `#080B12`-adjacent page backgrounds, `#121824`-adjacent cards, restrained blue accents, and a `1360px` maximum content width.
- Use stable placeholder imagery for the mock-data prototype.
- Do not add APIs, persistence, authentication, user content, downloads, news, or Cloudflare data services.
- Desktop and mobile must expose complete navigation and content.

---

### Task 1: Project foundation and product specification

**Files:** `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `app/globals.css`, `docs/product-spec.md`

**Interfaces:** Produces a buildable Next.js 16 App Router shell and shared design tokens.

- [ ] Initialize Git and npm metadata in the repository root.
- [ ] Install Next.js, React, TypeScript, Tailwind, ESLint, Vitest, and UI dependencies.
- [ ] Configure aliases, image hosts, lint, build, and test scripts.
- [ ] Add the explicit Phase 1 product principles without removing existing product context.

### Task 2: Typed mock data and query behavior

**Files:** `types/game.ts`, `lib/mock-data.ts`, `lib/game-query.ts`, `lib/game-query.test.ts`

**Interfaces:** Produces `Game`, `OfficialLink`, `SystemRequirements`, `games`, `getGameBySlug`, `filterGames`, and `getRelatedGames`.

- [ ] Write tests for case-insensitive multilingual search, genre/platform/year filters, sorting, slug lookup, and related-game exclusion.
- [ ] Run tests and confirm they fail because query helpers do not exist.
- [ ] Implement types, twelve complete game records, and minimal query helpers.
- [ ] Run tests and confirm all query behavior passes.

### Task 3: Shared UI and application shell

**Files:** `components/ui/*`, `components/layout/container.tsx`, `components/layout/header.tsx`, `components/layout/footer.tsx`, `components/search/search-dialog.tsx`, `app/layout.tsx`

**Interfaces:** Produces responsive global navigation, search overlay, semantic buttons/badges/inputs/skeletons, and page chrome.

- [ ] Implement compact desktop navigation and an accessible mobile sheet menu.
- [ ] Implement a live search dialog that links matching games.
- [ ] Add the global footer and metadata defaults.

### Task 4: Reusable game presentation

**Files:** `components/game/game-card.tsx`, `game-grid.tsx`, `game-hero.tsx`, `official-links.tsx`, `game-gallery.tsx`, `system-requirements.tsx`, `game-info.tsx`, `related-games.tsx`

**Interfaces:** Produces reusable card, hero, resource, gallery, requirements, information, and recommendation components.

- [ ] Build the responsive two-to-six-column cover grid and restrained hover motion.
- [ ] Build trusted official-resource rows with `✓ 官方` badges.
- [ ] Build responsive detail media and information sections.

### Task 5: Home, catalog, search, genre, and platform routes

**Files:** `app/page.tsx`, `components/home/*`, `app/games/page.tsx`, `components/filters/game-library.tsx`, `app/search/page.tsx`, `app/genres/[slug]/page.tsx`, `app/platforms/[slug]/page.tsx`

**Interfaces:** Produces the requested discovery routes with working client-side filters and query-string search.

- [ ] Compose the homepage hero, search, content rails, browse bands, and footer.
- [ ] Build the client-filtered `/games` catalog.
- [ ] Build search, genre, and platform results with empty states and metadata.

### Task 6: Game details and framework states

**Files:** `app/games/[slug]/page.tsx`, `app/loading.tsx`, `app/games/loading.tsx`, `app/not-found.tsx`

**Interfaces:** Produces static game detail routes, dynamic SEO, loading skeletons, and not-found handling.

- [ ] Compose the complete Black Myth: Wukong detail experience from reusable components.
- [ ] Generate static parameters and metadata for all mock games.
- [ ] Add loading and not-found states.

### Task 7: Visual and technical verification

**Files:** all implementation files; temporary screenshots removed before handoff.

**Interfaces:** Produces evidence that the prototype builds, lints, tests, and renders responsively.

- [ ] Run `npm test`, `npm run lint`, and `npm run build`; fix all failures.
- [ ] Start the production or development server and inspect desktop and mobile layouts.
- [ ] Exercise header search, catalog filters, result navigation, and detail-page links/gallery.
- [ ] Compare the rendered UI against the dark media-led concept and correct visible regressions.
