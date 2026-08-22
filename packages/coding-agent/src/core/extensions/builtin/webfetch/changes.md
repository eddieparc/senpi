# changes.md — webfetch (vendored)

Vendored from [`code-yeongyu/pi-webfetch`](https://github.com/code-yeongyu/pi-webfetch) (see `external-versions.json`).

## Senpi adaptations vs upstream

- Imports rewritten by `scripts/vendor-transform.mjs`: `@mariozechner/pi-{ai,tui}` -> `@earendil-works/pi-{ai,tui}`; `@mariozechner/pi-coding-agent` symbols -> `../../types.ts` (and `Theme` -> `modes/interactive/theme/theme.ts`); relative `.js` import suffixes -> `.ts`.
- `webfetch/fetcher.ts`: `buildHeaders` return type `HeadersInit` -> `Record<string, string>` (senpi's root tsconfig has no DOM lib, so the `HeadersInit` global is unavailable; the value is already a plain string record).
- Runtime deps `@mozilla/readability`, `jsdom`, and `turndown` (+ `@types/jsdom`, `@types/turndown`) added to `package.json`.
- HTML markdown/text responses now pass through Readability before conversion so reader-style article content is returned without nav/header/footer/aside/script page chrome. Registers the `webfetch` tool, gated by `PI_WEBFETCH` (default on).
- Tistory-style article containers are preferred over surrounding blog chrome, noisy related-post/sidebar blocks are stripped from the cloned article, and text conversion uses a DOM pass to preserve readable line breaks.
- Standalone Bun builds rewrite jsdom 29's eager worker lookup to select the compiled worker entry only in standalone executables while retaining jsdom's normal `require.resolve()` behavior under Node, then compile that worker as an explicit entrypoint. Without both steps, the executable captures the CI checkout path and fails during startup on machines where that path does not exist. This must be handled in the host build because an extension cannot change third-party module resolution inside an already-compiled executable.

## 2026-08-20 - HTML converters load on first conversion instead of at CLI startup

### What changed

- New `webfetch/content.lazy.ts` wraps `webfetch/content.ts` behind a single deferred import and exposes the
  same two functions as async, so jsdom, `@mozilla/readability` and turndown load on the first HTML conversion
  instead of at process start.
- `webfetch/tool.ts` imports the converters from that boundary and awaits `htmlToMarkdown` / `htmlToText`. Both
  call sites already sat inside the tool's async `execute`, so the conversion result, output shape and error
  behavior are unchanged.

### Why

- jsdom is the single heaviest package in the CLI's startup import graph, and nothing in it is needed until the
  webfetch tool actually converts an HTML response. Deferring it removes that parse/evaluate cost from every
  run, and costs a conversion nothing beyond the one-time load that run would have paid anyway.

### Why an extension could not handle it

- The import edge originates in this vendored builtin's own tool module, which the core loads during extension
  registration. An extension cannot remove an import edge from a module the core already loads.

### Expected merge conflict zones

- LOW in `webfetch/tool.ts` at the `content` import line and at the two conversion call sites inside `execute`;
  re-vendoring from `code-yeongyu/pi-webfetch` restores the direct import and the non-awaited calls, so this
  boundary must be re-applied together with the `HeadersInit` patch noted below.
- `webfetch/content.ts` itself is untouched, so a re-vendor of that file cannot conflict.

## Conflict zones

Re-vendoring overwrites these files; this is a MANUAL_PACKAGES entry in `scripts/sync-builtin-extensions.mjs` (metadata only, no auto file-sync). Re-apply the `HeadersInit` patch and Tistory article/noise selector behavior after re-running the transform, then re-check `npm run check`. A jsdom upgrade can also change the worker lookup patched by `scripts/prepare-bun-compile-assets.mjs`; keep its fixture and the explicit worker entrypoints in `scripts/build-binaries.sh` and `packages/coding-agent/package.json` aligned.
