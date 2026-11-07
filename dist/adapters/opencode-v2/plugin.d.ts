export declare const CTX_V2_PLUGIN_ID = "context-manager";
interface Logger {
    warn(message: string, error?: unknown): void;
    info(message: string): void;
    debug(message: string): void;
}
export interface CtxV2PluginDependencies {
    /** V1 hook factory; injectable for tests. */
    v1Factory?: (input: unknown, options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    logger?: Logger;
}
export interface CtxV2PluginDefinition {
    readonly id: string;
    readonly setup: (ctx: any) => Promise<() => Promise<void>>;
}
/**
 * Build the V2 plugin definition (`Plugin.define`-compatible: `{ id, setup }`).
 * `Plugin.define` from `@opencode/plugin` is the identity function, so the plain
 * object is used directly and the compiled entry has no runtime host import.
 */
export declare function createCtxV2Plugin(deps?: CtxV2PluginDependencies): CtxV2PluginDefinition;
/**
 * Copy V2 plugin options into V1 factory options. The V1 tuple options object
 * (`{ "ctx": { ... } }`) is accepted unchanged; V1 tool-class names whose V2
 * built-in was renamed (`bash` → `shell`, `apply_patch` → `patch`) are mirrored
 * when the V2 name is not configured explicitly.
 */
export declare function normalizeV2Options(options: Readonly<Record<string, unknown>>): Record<string, unknown>;
/** Default V2 plugin definition. */
export declare const CtxV2Plugin: CtxV2PluginDefinition;
export {};
//# sourceMappingURL=plugin.d.ts.map