/**
 * context-manager opencode plugin factory.
 *
 * Usage in opencode.json:
 *   "plugin": [["./clean-impl/adapters/opencode/plugin.ts", { "ctx": { ... } }]]
 *
 * Or as a named export (see index.ts):
 *   import { CtxPlugin } from "./adapters/opencode/index.js"
 */
export declare function CtxPlugin(_input: unknown, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
/**
 * opencode plugin module export.
 *
 * Hosts must NOT load this module directly: opencode v1 registers every exported
 * function as a separate plugin, and the named `CtxPlugin` export (needed by the
 * library API and tests) would then be registered alongside `default`, running
 * every hook twice per turn. Load the single-export entry instead, compiled:
 *   "plugin": ["file:///abs/path/clean-impl/dist/adapters/opencode/plugin-entry.js"]
 *
 * See `plugin-entry.ts` for the runtime constraints behind that.
 */
export default CtxPlugin;
//# sourceMappingURL=plugin.d.ts.map