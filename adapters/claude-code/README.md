# adapters/claude-code — STUB (v1)

This adapter is **not live-bound in v1**. It documents the mapping from the
Anthropic Messages API to the NeutralMessage model and provides typed skeletons
for future implementation.

---

## Hook mapping

| Core entrypoint | Claude Code binding |
|---|---|
| `transformMessages` | Pre-send transform on the Messages array before each `client.messages.create()` call |
| `transformSystem` | Inject context-manager system text into the system prompt block before send; read context limit from model metadata |
| `stripHallucinatedTags` | Post-response text cleanup on each assistant message |
| compress tool | A registered tool in the harness tool list (alongside `read`, `write`, etc.) |
| `onEvent` (timing) | Harness event/callback stream — feed compress part events to `onEvent` |
| manual trigger | A slash/command equivalent (optional) |
| `onConfig` | Harness config load |

---

## Message translation

### Anthropic → NeutralMessage

| Neutral field | Anthropic source |
|---|---|
| `id` | Synthetic: `"msg-{index}"` (Anthropic request messages have no stable IDs) |
| `role` | `message.role` (`"user"` or `"assistant"`) |
| `sessionId` | Harness session identifier |
| `createdAt` | Harness timestamp or `Clock.now()` |
| `isSummary` | Harness-specific marker (e.g. a synthetic message injected after compaction) |
| `parts[].type === "text"` | `content[].type === "text"` → `TextPart` |
| `parts[].type === "reasoning"` | `content[].type === "thinking"` → `ReasoningPart` |
| `parts[].type === "step-start"` | **Synthesized** at the beginning of each assistant message (Anthropic has no step-start concept) |
| `parts[].type === "tool"` | `content[].type === "tool_use"` paired with `content[].type === "tool_result"` in the following user message, matched by `tool_use_id` |
| `tokens` | `message.usage` on the last assistant message: `input_tokens → input`, `output_tokens → output`, `cache_read_input_tokens → cacheRead`, `cache_creation_input_tokens → cacheWrite` |

### NeutralMessage → Anthropic (apply mutations)

The core mutates:
- `parts[].output` (mask/offload replacement) → applied to `tool_result` blocks
- `parts[].input` fields (stale-error replacement) → applied to `tool_use` blocks
- The set of messages emitted (compress range → anchor) → synthetic user messages
- Nudge text appended to text parts → appended to the last user message's text block

---

## Cache breakpoints (Anthropic explicit-paid)

Anthropic uses `controlModel = "explicit-paid"`: the adapter **must** explicitly
place `cache_control: { type: "ephemeral" }` markers at stable positions.

### Two-position placement rule

Attach `cache_control: { type: "ephemeral" }` at exactly **two stable locations**
per request, in this order of priority:

1. **End of the system-prompt / tool-schema block.** This is the most stable
   content (changes rarely). Caching it saves re-indexing the full system prompt
   and tool definitions on every turn.

2. **End of the latest compressed summary block.** The summary block is the
   boundary between the stable (compressed) prefix and the volatile (active)
   suffix. Caching up to this point isolates the volatile tail and minimizes
   re-indexing on each new turn.

### Breakpoint limit

Anthropic supports a maximum of **4** cache breakpoints per request
(`breakpointLimit = 4` in `CACHE_MODEL_ANTHROPIC`). If more than two breakpoints
are needed (e.g. multiple summary blocks), place them at the two most-stable
positions and leave the rest unmarked.

### Required ordering

Anthropic requires content in this order: **tools → system → messages**.
Cache breakpoints must be placed within this ordering.

### Implementation notes

- Read `cacheModel.controlModel` from `CoreConfig` to decide whether to place
  breakpoints at all. The same adapter code should work for both Anthropic and
  non-Anthropic backends if the config is set correctly.
- For `automatic-free` providers (DeepSeek, OpenAI), do **not** place breakpoints.
  The provider caches automatically by prefix.
- The opencode v1 adapter targets DeepSeek (`automatic-free`) and does not place
  breakpoints. This logic is for the future Claude Code adapter only.

### Example

```typescript
// Place breakpoints at the two stable positions
function placeCacheBreakpoints(messages, systemBlocks, toolSchemaBlocks, latestSummaryBlockId, breakpointLimit) {
  let placed = 0;

  // 1. End of tool-schema block
  if (toolSchemaBlocks.length > 0 && placed < breakpointLimit) {
    toolSchemaBlocks[toolSchemaBlocks.length - 1].cache_control = { type: "ephemeral" };
    placed++;
  }

  // 2. End of system-prompt block
  if (systemBlocks.length > 0 && placed < breakpointLimit) {
    systemBlocks[systemBlocks.length - 1].cache_control = { type: "ephemeral" };
    placed++;
  }

  // 3. End of latest summary block (if present)
  if (latestSummaryBlockId && placed < breakpointLimit) {
    const summaryMsg = messages.find(m => m.id === latestSummaryBlockId);
    if (summaryMsg?.content?.length > 0) {
      summaryMsg.content[summaryMsg.content.length - 1].cache_control = { type: "ephemeral" };
      placed++;
    }
  }
}
```

---

## v1 status

- `map.ts`: typed skeletons with TODO bodies — not callable
- `README.md`: full mapping + cache breakpoint documentation
- No live harness binding

To implement: wire `toNeutral`, `applyNeutral`, `loadConfig`, and
`placeCacheBreakpoints` in `map.ts`, then register the hooks in a `plugin.ts`
that integrates with the Claude Code harness. No core changes required.
