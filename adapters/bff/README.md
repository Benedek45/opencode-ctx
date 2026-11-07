# adapters/bff — STUB (v1)

This adapter is **not live-bound in v1**. It documents how a backend-for-frontend
(BFF) proxy that sits between a web UI and the opencode REST API could run the core
pipeline, and provides typed skeletons for a future implementation.

---

## Architecture context

A typical BFF mediates the opencode REST stream:

```
User browser
  → POST <bff chat-stream route>
    → POST /session/:id/prompt_async (opencode engine)
    → GET /event?directory= (SSE stream)
  → SSE frames to browser
```

The context-manager BFF adapter inserts into this flow at two points:

1. **Before `prompt_async`**: transform the message history (run the core pipeline)
   before relaying to the engine.
2. **In the SSE stream parser**: strip hallucinated tags from text frames; feed
   compress part events to `onEvent`.

---

## Hook mapping

| Core entrypoint | BFF binding |
|---|---|
| `transformMessages` | In the chat-stream route, before calling `prompt_async`: fetch message history via `GET /session/:id/message`, run the pipeline, apply mutations, pass the mutated history to the engine |
| `transformSystem` | In the chat-stream route, add context-manager system text to the per-turn `system` field, if the BFF sends one |
| `stripHallucinatedTags` | In the SSE stream parser, strip tags from `text` frame content before emitting to the browser |
| compress tool | A BFF compress endpoint, or inject the compress tool into the engine's tool list via the opencode plugin mechanism |
| `onEvent` | In the SSE stream parser, filter `message.part.updated` events where `part.tool === "compress"` and feed them to `onEvent` for timing capture |
| manual trigger | An optional BFF endpoint |
| `onConfig` | BFF startup / session create |

---

## Wiring into the chat-stream route

A sketch, assuming the BFF already reads `sessionId` and `text` from the request,
fires `prompt_async`, and relays `/event` frames:

```typescript
// In the chat-stream route, before promptAsync:

import { toNeutral, applyNeutral, loadConfig } from "./ctx/adapters/bff/map.js";
import { runPipeline } from "./ctx/core/pipeline.js";

// 1. Fetch current message history
const history = await getSessionMessages(sessionId, directory);

// 2. Translate to neutral model
const neutralMessages = toNeutral(history, sessionId);

// 3. Load or create session state
const state = await loadOrCreateState(sessionId, persistence);
const config = loadConfig(sessionId, modelContextLimit, providerID, modelID);

// 4. Run the pipeline
const result = runPipeline(
  { messages: neutralMessages, state, config, nowMs: Date.now() },
  { tokenizer, workspaceDir }
);

// 5. Apply mutations back to the history
const mutatedHistory = applyNeutral(history, result.messages);

// 6. Inject nudge text into the per-turn system
const systemWithNudge = result.nudgeText
  ? appendNudgeToSystem(existingSystem, result.nudgeText)
  : existingSystem;

// 7. Persist state
await persistence.save(sessionId, result.state);

// 8. Relay to engine with mutated history
// (The engine's prompt_async must accept a `messages` override — verify this is supported)
await promptAsync(sessionId, text, systemWithNudge);
```

**Note:** `prompt_async` makes the engine use its own message store. To inject
mutated messages, the BFF would need to either:
- Use the engine's `messages` override parameter (if supported), OR
- Run the pipeline on the BFF's own copy of the history and inject the result
  as the `system` context (less invasive but less precise).

The cleanest approach is to use the in-process opencode plugin (which hooks the
host's message transform directly) rather than the BFF adapter. The BFF adapter is
provided for deployments where the opencode engine is not accessible for plugin
installation.

---

## Persistence

context-manager state can be stored next to whatever per-session state the BFF already keeps,
for example as a separate `<sessionId>.ctx.json` file. The `FilePersistence` from
`adapters/opencode/services.ts` can be reused with a custom `storageDir`.

---

## /event stream parsing

To feed compress events to `onEvent`:

```typescript
// In the SSE stream parser:
if (event.type === "message.part.updated") {
  const part = event.properties.part;
  if (part.type === "tool" && part.tool === "compress") {
    await ctxAdapter.onEvent({ event });
  }
}
```

---

## v1 status

- `map.ts`: typed skeletons with TODO bodies — not callable
- `README.md`: wiring documentation
- No live BFF binding

To implement: wire `toNeutral`, `applyNeutral`, `loadConfig` in `map.ts`, then
integrate into the BFF's chat-stream route as described above. No core changes
required.
