// PolyForm Noncommercial License 1.0.0 — see LICENSE
//
// Host plugin entrypoint. This module intentionally has EXACTLY ONE export: the
// default plugin factory.
//
// Two host constraints make this file necessary:
//
//  1. opencode v1 treats every exported function in a plugin module as its own
//     plugin factory. `plugin.ts` also exports `CtxPlugin` by name (tests and
//     the library API need it), so loading `plugin.ts` directly registers the
//     same plugin more than once and every hook runs multiple times per turn.
//     This file therefore exports only `default`.
//
//  2. The opencode DESKTOP app runs on Electron/Node, not Bun. Our sources use
//     `.js` specifiers that resolve to `.ts` files, which only Bun does, so raw
//     sources fail with ERR_MODULE_NOT_FOUND there. Point host config at the
//     COMPILED build of this file:
//       clean-impl/dist/adapters/opencode/plugin-entry.js
//
// The Bun-based CLI can load the TypeScript sources directly, but the compiled
// entry works on both runtimes and is the only supported configuration.
import { CtxPlugin } from "./plugin.js";
export default CtxPlugin;
//# sourceMappingURL=plugin-entry.js.map