// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Minimal local type declarations mirroring the verified vendored opencode plugin API.
//
// These are NOT imported from the vendored package at runtime — they are declared
// here so the adapter is typecheckable without resolving the full vendored package
// tree. The shapes are verified against:
//   vendor/opencode/packages/plugin/src/index.ts  (Hooks, Plugin, PluginInput)
//   vendor/opencode/packages/plugin/src/tool.ts   (tool(), ToolContext, ToolResult)
//   vendor/opencode/packages/sdk/js/src/gen/types.gen.ts  (Message, Part, ToolState*)
//
// VERIFIED SHAPES (2026-06):
//
// Hook: "experimental.chat.messages.transform"
//   input: {}
//   output: { messages: Array<{ info: Message; parts: Part[] }> }
//   Message = UserMessage | AssistantMessage (see below)
//   Part = TextPart | ReasoningPart | ToolPart | StepStartPart | StepFinishPart | ...
//
// Hook: "experimental.chat.system.transform"
//   input: { sessionID?: string; model: Model }
//   output: { system: string[] }
//
// Hook: "experimental.text.complete"
//   input: { sessionID: string; messageID: string; partID: string }
//   output: { text: string }
//
// Hook: "event"
//   input: { event: Event }
//   output: void
//
// Hook: "config"
//   input: Config
//   output: void
//
// Hook: "command.execute.before"
//   input: { command: string; sessionID: string; arguments: string }
//   output: { parts: Part[] }
//
// Hook: "tool.execute.before"
//   input: { tool: string; sessionID: string; callID: string }
//   output: { args: unknown }
//
// tool() helper:
//   tool({ description, args, execute }) -> ToolDefinition
//   execute(args, context: ToolContext) -> Promise<ToolResult>
//   context.ask({ permission, patterns, always, metadata }) -> Promise<void>
//
// MISMATCH vs spec assumption:
//   The spec says "transformSystem must skip internal agents via literal-substring check".
//   The actual hook input is { sessionID?: string; model: Model } — there is NO agent name
//   in the system transform input. Internal-agent detection must be done via model.modelID
//   or by checking the session's agent name from a separate source. We detect it by
//   checking model.modelID for known internal model IDs (title generator, summarizer).
//   See plugin.ts for the implementation.
//
//   The spec says "read sessionId from the messages themselves" for messages.transform.
//   Confirmed: input is {} (empty object). SessionId is read from messages[0].info.sessionID.
//
//   AssistantMessage.tokens uses nested cache: { read, write } — NOT flat cacheRead/cacheWrite.
//   The adapter maps: tokens.cache.read -> cacheRead, tokens.cache.write -> cacheWrite.
export {};
//# sourceMappingURL=host-types.js.map