// PolyForm Noncommercial License 1.0.0 — see LICENSE
// opencode adapter public API.

export { CtxPlugin } from "./plugin.js";
export { collectHandoff, importHandoff, loadImportedSeed, composeRecoveryEntries, localHandoffResourceReader, assertNewHandoffSession } from "./context-handoff.js";
export type { HandoffSnapshot, HandoffResourceReader, CollectHandoffOptions, ImportedSeed, ImportHandoffInput, ImportHandoffResult } from "./context-handoff.js";
export { encodeBundle, decodeBundle, PORTABLE_LIMITS } from "./portable-context.js";
export type { PortableBundle, PortablePayload, PortableRecord, PortableRoot, PortablePart, PortableBlob, PortableLimits } from "./portable-context.js";
export { readBundleFile, writeBundleFile, parseHandoffArguments } from "./portable-context-io.js";
export { createHandoffHostReader } from "./handoff-host.js";
export type { HandoffHostReader } from "./handoff-host.js";
export { REMOTE_CONTEXT_BRIDGE_KEY, normalizeRemoteContextDirectory, registerRemoteContextBridge } from "./remote-context-bridge.js";
export type {
  RemoteContextBridge,
  RemoteContextCapture,
  RemoteContextCaptureRequest,
  RemoteContextCaptureSelection,
  RemoteContextRange,
  RemoteContextSelectionRequest,
} from "./remote-context-bridge.js";
export { toNeutral, applyNeutral } from "./map.js";
export { buildCoreConfig, extractPluginOptions, isInternalModel, validateRuntimeConfig } from "./config.js";
export {
  buildCompressTool,
  buildCompressMessageTool,
  buildCompressionArchiveSearchTool,
  buildCompressionArchiveRetrieveTool,
  buildCompressionArchiveReleaseTool,
  buildSessionCompressPrompt,
} from "./tool.js";
export {
  archiveCompressionSource,
  archiveCompressionSummary,
  loadCompressionSource,
  loadCompressionSummary,
  searchCompressionSummaries,
  retrieveCompressionSummaries,
} from "./compression-archive.js";
export { buildServices, loadOrCreateState, FilePersistence, AnthropicTokenizer, AdapterLogger } from "./services.js";
export { FilesystemContentStore } from "./content-store.js";
export { startControlServer, RevisionConflictError } from "./control-server.js";
export type { ControlPlaneBackend, ControlServer, ControlSessionSnapshot, StartControlServerOptions } from "./control-server.js";
export type { CtxPluginOptions } from "./config.js";
export type {
  HostMessage,
  HostUserMessage,
  HostAssistantMessage,
  HostPart,
  HostToolPart,
  HostToolState,
  HostMessageEntry,
  HostToolContext,
  HostToolResult,
  MessagesTransformInput,
  MessagesTransformOutput,
  SystemTransformInput,
  SystemTransformOutput,
} from "./host-types.js";
