# opencode-ctx

Context management for long [OpenCode 2](https://opencode.ai) sessions. The plugin
keeps active context focused with reversible summaries and mechanical pruning of
stale tool outputs. Compression sources are archived for recovery on disk;
summaries can omit details. The model sees HOT content, WARM summaries and a COLD
catalog, and archive search searches summaries rather than original sources.

## Status / evaluation

The release suite has no known failing tests. The optional summary worker is
validated with mocked lifecycle tests, not a live quality benchmark. See
[CHANGELOG.md](CHANGELOG.md) for release notes.

### Conversation-recall benchmark

The plugin's claim is about communication, not task solving: in long, human-driven
sessions the model should keep what the user said (rules, decisions and their
reasons, rejected approaches, names, paths, preferences). Short automated coding
benchmarks rarely reach compaction and carry everything in the task statement, so
they do not test this.

Method: 8 long real sessions (71–475 user turns) from the author's own work across
different projects, frozen at their latest point. For each session three contexts
were built:

- **A — native compaction (simulated):** rolling OpenCode 2.2.6 compaction over the
  raw history using the installed host's own summary prompts and its ~15,000-token
  recent tail.
- **B — ctx projection:** the exact context the plugin last sent the model.
- **C — ctx at A's budget:** B reduced to A's token size (differs from B only where
  B was larger than A; 3 of 8 sessions).

144 questions (18 per session) were generated from the older 70% of each session,
with evidence restricted to user messages; every evidence quote was verified
verbatim by script and questions answerable from the shared recent tail were
dropped. One answerer (DeepSeek V4.1 Flash) answered every question under each
condition; a different model family (GLM) generated, reviewed and blind-judged.

| Condition | Correct / partial / wrong / "not in context" | Strict accuracy [95% CI] | Mean context tokens |
|---|---|---|---:|
| A — native compaction (simulated) | 26 / 5 / 17 / 96 | 18.1% [7.6, 29.9] | ~334k |
| B — ctx projection | 55 / 18 / 12 / 59 | 38.2% [22.9, 54.9] | ~194k |
| C — ctx at A's budget | 53 / 16 / 10 / 65 | 36.8% [20.1, 55.6] | ~146k |

Paired difference B−A: +20.1 points [1.4, 38.9]; C−A: +18.8 points [−0.7, 38.9]
(hierarchical bootstrap over sessions, then questions). ctx scored higher in 7 of 8
sessions. Most misses are abstentions: with native compaction the information was
usually no longer in context, rather than misremembered.

Limits: one author's sessions only; small sample (wide intervals); native
compaction is a faithful-as-possible simulation, not a replay (exact scheduling,
system prompts and tool schemas cannot be reconstructed); a single answerer; model
generated and judged questions (a second-model audit agreed on 15 of 20
judgments; no human review); the size control is weak because B was already
smaller than A in 5 sessions. The transcripts and per-question data stay private;
only these aggregates are published. Pin a release and run your own comparison
before relying on it.

## Features

- **HOT / WARM / COLD context tiers.** HOT is the exact live context. WARM blocks
  carry full summaries of compressed history inside a bounded token budget. COLD
  blocks are reduced to a compact catalog entry and can be searched and promoted
  back to WARM at any time.
- **Model-driven compression.** The model gets `compress` (summarize one or more
  `mNNNN`/`bN` ranges) and `compress_message` (summarize individual messages)
  tools. Compression is never auto-fired: the plugin shows the model an estimated
  context status every request and nudges it as the context grows.
- **Mechanical pruning.** A cache-aware cascade of exact dedup, stale-error purge,
  near-duplicate (SimHash) dedup, and observation masking/offloading of large old
  tool outputs, with a hard cap as the last backstop. Recent turns are protected.
- **Durable archives.** Every compression block writes immutable, digest-verified
  archives of its exact sources and its summary. `/ctx-decompress` restores the
  original messages even after OpenCode's native compaction.
- **Archive tools.** `ctx_archive_search`, `ctx_archive_retrieve`, and
  `ctx_tier_update` let the model find cold summaries and move blocks between tiers.
- **Compression eligibility.** `ctx_compression_status` reports eligible refs,
  message counts, token estimates, protection reasons and requests still to wait,
  without returning source text. Guarded rejected/failed calls count as attempts
  and return refreshed guidance, rather than being treated as ignored nudges.
- **Optional idle summary worker.** Explicitly opt in to a separate model that
  fulfills pending compression requests while a parent session is observed idle.
  Default OFF; see [Native idle summary worker](#native-idle-summary-worker).
- **Local dashboard.** `/ctx-ui` opens an authenticated loopback dashboard with the
  tier inventory, exact model-context view, per-message keep/drop/replace edits,
  and runtime settings.
- **Portable context.** `/ctx-export` and `/ctx-import` move a chat's context
  between machines as a single JSON file.

Slash commands: `/ctx-compress`, `/ctx-decompress [bN]`, `/ctx-recompress [bN]`,
`/ctx-stats`, `/ctx-ui`, `/ctx-export`, `/ctx-import`.

## Install (OpenCode 2)

Install from GitHub with the plugin CLI. This adds the package to your global
`opencode.json` and installs it:

```sh
opencode plugin add github:Benedek45/opencode-ctx
```

To pin a release, add the tag:

```sh
opencode plugin add github:Benedek45/opencode-ctx#v1.0.1
```

The compiled plugin is committed in `dist/`, so no build step runs during install.
The only optional dependency is `@anthropic-ai/tokenizer`, used for more accurate
Claude token estimates; without it the plugin falls back to calibrated character
estimates.

Restart the OpenCode service after installing so the server loads the plugin:

```sh
opencode service restart
```

Check that it loaded with `opencode plugin list` (plugin id `context-manager`).

### Configure

Options go in the object form of the `plugins` entry, under a mandatory `ctx` key
(keys outside `ctx` are ignored):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:Benedek45/opencode-ctx",
      "options": {
        "ctx": {
          "recencyGuardTurns": 5,
          "compressionRecencyRequests": 3,
          "contextTiers": {
            "warmBudgetMode": "advisory",
            "warmMaxTokens": "8%"
          },
          "providers": {
            "anthropic": {
              "modelContextLimit": 200000,
              "nudges": {
                "lowerThreshold": "40%",
                "upperThreshold": "70%",
                "safetyCap": "90%:20000"
              }
            }
          }
        }
      }
    }
  ]
}
```

- `recencyGuardTurns` protects tool outputs from the last N user turns from
  mechanical pruning.
- `compressionRecencyRequests` stops the model from compressing messages that have
  fewer than N real assistant requests after them.
- `contextTiers.warmBudgetMode: "advisory"` treats `warmMaxTokens` as guidance and
  lets the model decide which blocks stay WARM (the default, `"strict"`, enforces it).
- `providers.<id>` and `models.<id>` override any setting per provider or model.
  `modelContextLimit` overrides the window size reported by the host, and every
  `"X%"` threshold resolves against it.

The full option list is in [Configuration reference](#configuration-reference).
Changes to the `ctx` options take effect after `opencode service restart`; settings
saved from the dashboard apply immediately.

### Update

OpenCode checks unpinned plugins for updates at startup, but does not change the
installed package on its own:

```sh
opencode plugin check     # list outdated plugins
opencode plugin update    # update every outdated plugin
opencode plugin update github:Benedek45/opencode-ctx
opencode service restart  # load the new version
```

Full commit hashes are never updated. To move a tag-pinned install to a newer
release, run `plugin add` with the new tag.

### Uninstall

```sh
opencode plugin remove github:Benedek45/opencode-ctx
opencode service restart
```

The plugin keeps its state and archives under `$XDG_DATA_HOME/opencode/storage`
(default `~/.local/share/opencode/storage`); remove the `ctx/`, `content-blobs/`,
and `session-snapshots/` folders there to delete them.

### Local checkout

To run from a clone instead, point `plugins` at the checkout directory. OpenCode
loads the server part through the package's `.` export
(`dist/adapters/opencode-v2/server.js`):

```json
{ "plugins": [{ "package": "/abs/path/to/opencode-ctx", "options": { "ctx": {} } }] }
```

### OpenCode 1

The V1 plugin is still built into `dist/`. Load the compiled entry file, never
`plugin.js` (which would register every hook twice) or the TypeScript sources
(which only Bun can resolve):

```json
{ "plugin": [["file:///abs/path/to/opencode-ctx/dist/adapters/opencode/plugin-entry.js", { "ctx": {} }]] }
```

---

## How it works

```
┌──────────────────────────────────────────────────────────────┐
│  ADAPTERS  (one per host)                                     │
│  adapters/opencode-v2  ← OpenCode 2 plugin (wraps opencode)   │
│  adapters/opencode     ← OpenCode 1 plugin, fully wired       │
│  adapters/claude-code  ← typed stub                           │
│  adapters/bff          ← typed stub                           │
│   - translate host messages ⇄ NeutralMessage                  │
│   - map host config → CoreConfig                              │
│   - wire concrete services (Tokenizer, Clock, Persistence)    │
│   - bind core entrypoints to host hooks                       │
└───────────────────────────────────────────────────────────────┘
                    │ (calls core entrypoints)
                    ▼
┌──────────────────────────────┐
│  CORE  (pure)                │
│  - no I/O, no host types     │
│  - neutral model in/out      │
│  - cascade / mask / compress │
│  - state reconciliation      │
└──────────────────────────────┘
```

**Rule:** `core/**` has zero imports from `adapters/**` and from any host SDK.
Adapters may import core and their own host types. Nothing imports an adapter
except that host's entry shim.

On every model request the plugin:

- translates OpenCode messages into a neutral model and runs the core pipeline
- applies active compression blocks, tier placement, and mechanical pruning
- injects `<ctx-message-id>` ref tags so the model can address ranges for `compress`
- appends a compact estimated context status (projected tokens, change since the
  previous request, compression target, tokens still to remove) and, when needed, a
  nudge to the latest user message — never to the system prompt
- escalates after 3 consecutive ignored strong nudges: wording names the repeat
  count and an extra tightened masking pass runs before the hard cap
- persists state atomically as a JSON sidecar per session

### OpenCode 2 binding

`adapters/opencode-v2/` drives the same adapter through the V2 plugin API.
`session.hook("context")` runs the system accounting and the message pipeline; context-manager
tools are registered with `tool.transform` as direct (`codemode: false`) tools;
`/ctx-*` commands use `command.transform` (status output is posted as a
`session.synthetic` note with `resume: false`, so it is delivered with the next
turn; `/ctx-compress` and a successful `/ctx-import` prompt the model); session
status and provider usage come from `event.subscribe()`. V2 has no
`experimental.text.complete`: hallucinated `ctx-message-id` tags are still stripped
from model-facing context, but can stay visible in displayed assistant text. V1
tool-class names `bash`/`apply_patch` are mirrored onto the V2 built-ins
`shell`/`patch` unless configured explicitly.

Keep `automation.automaticPruning` enabled for very large existing sessions: it
supplies the policy hard cap and the provider-limit backstop. With it off, an
oversized request is sent as-is and the provider rejects it.

## Migrating from DCP

The offline CLI converts **@tarquinen/opencode-dcp v3 compression sidecars**, not
the context manager's old-name state files. Quit OpenCode **and its background
service** before applying. It does not start/stop OpenCode, edit configuration,
write the host database, or modify upstream sidecars. Remove the DCP plugin from
your configuration after migration and add opencode-ctx with options under `ctx`;
do not run both plugins on the same session.

Use **Node 22.13+** (23.x requires 23.4+), with built-in `node:sqlite`; no extra
dependency or experimental flag is needed. Bun is used for development/tests,
not to run this CLI. From this package directory:

```sh
node dist/migration/cli.js > migration-preview.json
node dist/migration/cli.js --apply > migration-report.json
```

From a public clone, the same commands work without installation or compilation:
`dist/` ships committed. For a development checkout first run `bun install` and
`bun run compile` while the host is safely stopped. Do not guess a git-plugin
cache path or use `npx` against an unpublished registry package; use a clone.

Defaults: sidecars under
`${XDG_DATA_HOME:-~/.local/share}/opencode/storage/plugin/dcp/`, database
`opencode/opencode.db` under that data home, target storage resolved by the
plugin (`CONTEXT_MANAGER_STORAGE_DIR`, `WORKSPACES_ROOT/.context-manager`, then
XDG storage). Specify a copy or custom layout explicitly:

```sh
node dist/migration/cli.js --data-home /absolute/data-copy --storage /absolute/target-storage
node dist/migration/cli.js --data-home /absolute/data-copy --storage /absolute/target-storage --apply --allow-running-opencode
```

`--database /absolute/copy.db` overrides the database file. Inputs and target
paths must be free of symlinks (use their canonical physical paths). The explicit
`--allow-running-opencode` override bypasses process detection and is unsafe on
live storage; it is intended for isolated copies. Detection fails closed on
process-enumeration failure and excludes crash reporters and the read-only stats app.

Dry-run is the default and writes **nothing**; redirect stdout to save its JSON
report. Each session is `ready`, `imported`, `already-imported`, or `skipped`, with
failure reasons and archive counts. Invalid graphs, unknown database schemas,
missing sessions/sources, corrupt state, and a different local compression graph
are never silently overwritten. Apply skips individual failures and continues;
inspect the report even when the command exits successfully. Fatal setup/backup
failures exit nonzero. Repeating the same verified import is idempotent.

Before any target write, apply creates an owner-only (0700 directories / 0600
files) timestamped `<storage>/../ctx-import-backup-<timestamp>-<pid>/`. It copies
the complete `ctx/`, `content-blobs/`, `content-index.json`, and
`session-snapshots/` trees, including absent-target entries in `manifest.json`.
This conservative backup may be large; reserve enough disk space. No hard links
are used. `report.json` is saved there too. A backup failure aborts the batch
before any target write. Each session publishes one atomic state save only after
digest-verifying its source and summary archives; failed imports roll back newly
created archives. The entire batch is **not** one transaction.

To roll back, keep OpenCode stopped, read the manifest, move each current listed
target aside to a quarantine directory, then copy back only targets marked
`existed: true` from the backup. Leave originally absent targets absent. Restore
all listed targets together (the index and blobs must agree). This restores the
whole pre-migration storage snapshot, so later work would be lost unless saved
separately; do not roll back after resuming work without another backup. No
database or upstream restoration is needed because neither was written.

Compression graph identities, activation, nested coverage, tokens, summaries and
recoverable originals are converted. Upstream **tool-prune decisions are not
imported**: their exact replacement payloads were not retained. Runtime options,
nudges, provider usage/calibration and upstream logs are not imported either.
Missing exact sources skip a session by default. Explicit
`--allow-incomplete-sources` preserves such blocks as full WARM summaries with a
summary archive but **no source archive**; decompression is unavailable and those
blocks cannot be demoted to COLD. It does not bypass graph validation or fabricate
missing content.

Supported SQLite layouts: legacy `session`/`message`/`part` JSON rows (parts ordered
by `message_id, id`, never creation time), and native V2 `session_v2` plus
`session_message` ordered by `seq, id`, optionally `session_part` ordered by
`message_id, ordinal` and prepended to inline content. Native rows use the same
persisted-history mapper as the plugin's history readers. Unknown layouts and
externalized non-inline text fail closed; the CLI does not pretend blob references
are exact text. Schema support is tested against synthetic databases that follow
the host's table definitions. Always run the dry-run against your own data first
and review the report before using `--apply`.

## Native idle summary worker

**OFF by default.** Add `summaryWorker` under the plugin's `options.ctx`, preserving
other options. Choose an available authenticated provider/model; worker calls may
consume quota or incur charges.

```json
{
  "summaryWorker": {
    "enabled": true,
    "model": "openai/gpt-6.1-sol",
    "timeoutMs": 60000,
    "cleanupTimeoutMs": 5000,
    "maxInputTokens": 32000,
    "maxOutputTokens": 4000,
    "minIntervalMs": 60000
  }
}
```

Only resident, owned, compression-enabled parents with a pending request and an
explicitly observed idle status qualify. No timer launches work. Duplicate idle
events coalesce; concurrency is one job per storage root, with bounded cooldown
and status caches. Disconnect invalidates idle authority.

Each job creates a **fresh titled root**, never forks parent history. The hidden
`ctx-summarizer` agent is registered only when enabled and never overwrites a user
agent. Native session permissions deny all actions. The worker context replaces
inherited project instructions, removes tools and host reminders, and contains
only the exact escaped-JSON source prompt. Auxiliary sessions bypass parent
pipeline/state, snapshots, nudges, title generation and automatic compaction.

The native transport awaits the prompt inbox receipt, waits idle, then reads
scoped context. Only one completed, error-free, tool-free, matching-model/agent
assistant ending with `stop` is accepted. Structured summary sections and all exact
`[DATA NEEDED: ...]` items are mandatory. Caps reject whole inputs/outputs, never
truncate; `maxOutputTokens` is an acceptance bound, not a provider generation limit.

Busy/retry, new context and unload cancel work. Interrupt (`resume:false`) and
remove have bounded cleanup; unknown create/cleanup outcomes discard the result
and preserve exact suppression IDs. Before commit, sources, refs, SHA-256 digest,
revision, config, models, ownership and parent idle/cancellation are rechecked,
including after archive I/O. Normal recency/savings and verified dual-archive
transaction guards remain; worker commits do not count model compliance attempts.
Failures preserve original messages. There is no cross-process atomic transaction
with host idle state; the final check is at the coordinated durable-save boundary.

Validated with mocked native lifecycle tests against development SDK 2.0.29 and
host 2.2.6 source contracts; not a live model-call benchmark. Enabled setup fails
closed if native lifecycle/agent APIs are missing. Do not set legacy `sdkVersion`
for V2. Default-off adds no agent, title/compaction hook or lifecycle calls.

## Configuration reference

A complete example with most options:

```json
{
  "ctx": {
    "profile": "documents",
    "automation": {
      "automaticPruning": true,
      "modelCompression": true
    },
    "contextTiers": {
      "enabled": true,
      "warmMaxTokens": "8%",
      "warmBudgetMode": "strict",
      "ageDemotionEnabled": true,
      "warmMaxAgeTurns": 40,
      "catalogMaxTokens": "1%",
      "retrievalMaxTokens": "8%",
      "retrievalTtlTurns": 2
    },
    "recencyGuardTurns": 5,
    "compressionRecencyRequests": 3,
    "minRepruneInterval": 3,
    "clearAtLeast": 2000,
    "cachePrune": {
      "afterCompress": true,
      "afterTtl": true,
      "ttlSeconds": 360
    },
    "nearDupe": { "enabled": true },
    "routing": { "mode": "advise" },
    "contentStore": { "enabled": true },
    "controlServer": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 3777
    },
    "summarization": {
      "preserveUserMessages": true,
      "protectedToolGlobs": ["task", "skill"],
      "protectedFilePathGlobs": ["**/.env*"],
      "minNetSavingsTokens": 100
    },
    "nudges": {
      "lowerThreshold": 150000,
      "midSoftNudge": 250000,
      "upperThreshold": 400000,
      "safetyCap": "95%:30000"
    }
  }
}
```

### Config options

| Key | Type | Default | Description |
|---|---|---|---|
| `profile` | `"documents"` \| `"code"` \| `"balanced"` | `"documents"` | Strategy aggressiveness profile |
| `automation.automaticPruning` | boolean | true | Master switch for dedup/stale/near-dupe/masking, persisted mechanical decisions, escalation masking, and hard caps |
| `automation.modelCompression` | boolean | true | Allow compression nudges/requests, `compress` tools, and `/ctx-compress` |
| `contextTiers.enabled` | boolean | true | Master switch for warm/cold tier demotion and cold catalogs |
| `contextTiers.warmMaxTokens` | number \| `"X%"` | `"8%"` | Bounded budget for warm block summaries carried in context |
| `contextTiers.warmBudgetMode` | `"strict"` \| `"advisory"` | `"strict"` | Enforce `warmMaxTokens`, or expose it only as model guidance |
| `contextTiers.ageDemotionEnabled` | boolean | true | Allow cache-aware automatic demotion after `warmMaxAgeTurns`; strict token-cap demotion still runs when false |
| `contextTiers.warmMaxAgeTurns` | number | 40 | Demote warm blocks older than this many user turns |
| `contextTiers.catalogMaxTokens` | number \| `"X%"` | `"1%"` | Bounded budget for the cold catalog replacing demoted summaries |
| `contextTiers.retrievalMaxTokens` | number \| `"X%"` | `"8%"` | Per-call safety limit for whole-summary retrieval output, including advisory mode |
| `contextTiers.retrievalTtlTurns` | number | 2 | Compatibility lifetime for temporary leases created by older versions |
| `recencyGuardTurns` | number | 5 | Tool calls within this many user turns are never touched |
| `compressionRecencyRequests` | integer | 3 | Model-driven compression only: protect messages with fewer than this many real assistant requests strictly after them; 0 disables. Synthetic messages do not count. Mechanical retention remains user-turn-based. |
| `minRepruneInterval` | number | 3 | Minimum turns between masking passes |
| `clearAtLeast` | number | 2000 | Minimum tokens a masking pass must recover |
| `cachePrune.afterCompress` | boolean | true | Run dedup/stale-error after model-driven compression rewrites the prefix |
| `cachePrune.afterTtl` | boolean | true | Run dedup/stale-error after the session has been idle past `ttlSeconds` |
| `cachePrune.ttlSeconds` | number | 360 | Idle TTL for dedup/stale-error pruning (6 minutes) |
| `nearDupe.enabled` | boolean | true | Run SimHash near-duplicate dedup (stateless tools only) alongside exact-match dedup |
| `hardCap` | number \| `"X%"` | `"92%"` | Mechanical cap; reports when protected/recent content makes the target impossible |
| `summarization.appendOnly` | boolean | true | Keep earlier summaries byte-stable unless consolidation is requested |
| `summarization.preserveUserMessages` | boolean | false | Preserve selected user messages verbatim in summaries |
| `summarization.preserveProtectTags` | boolean | true | Preserve `<protect>...</protect>` text verbatim |
| `summarization.protectedToolGlobs` | string[] | `[]` | Tool outputs mechanically copied into summaries |
| `summarization.protectedFilePathGlobs` | string[] | `[]` | File-affecting tool outputs mechanically copied into summaries |
| `summarization.minNetSavingsTokens` | number | 0 | Minimum net source-minus-summary token savings |
| `contentStore.enabled` | boolean | true | Persist immutable source/tool/history records and current snapshots |
| `routing.mode` | `"off"` \| `"advise"` \| `"enforce"` | `"off"` | Pre-tool policy; enforce denies only deterministic floods |
| `controlServer.enabled` | boolean | false | Start the authenticated loopback dashboard |
| `controlServer.host` | string | `"127.0.0.1"` | Loopback bind; non-loopback values are rejected |
| `controlServer.port` | number | 0 | Ephemeral dashboard port by default; set a fixed port explicitly if needed |
| `controlServer.openBrowser` | boolean | true | Open the authenticated URL locally when `/ctx-ui` runs |
| `sessionCache.maxBytes` | positive safe integer | 268435456 | Root-shared resident data target (256 MiB of conservative accounting, not a process RSS limit) |
| `sessionCache.maxSessions` | positive safe integer | 64 | Maximum idle resident sessions before coordinated eviction |
| `sessionCache.idleTtlMs` | positive safe integer | 900000 | Idle residence target (15 minutes); busy/queued work remains pinned |
| `tokenizer` | `"auto"` \| `"char"` \| `"anthropic"` | `"auto"` | Auto selects the Anthropic text tokenizer for Claude and calibrated char estimates otherwise; explicit modes force one base tokenizer |
| `nudges.lowerThreshold` | number \| `"X%"` | 150000 | Gentle entry nudge threshold |
| `nudges.midSoftNudge` | number \| `"X%"` | 250000 | Mid-soft nudge threshold |
| `nudges.upperThreshold` | number \| `"X%"` | 400000 | Strong nudge / quality-trigger threshold |
| `nudges.maskTriggerThreshold` | number \| `"X%"` | 150000 | Observation-masking trigger threshold |
| `nudges.safetyCap` | string | `"95%:30000"` | Safety cap (non-blocking; escalates aggressiveness). `"X%"` = X% of the window; `"X%:N"` = the earlier of X% and N tokens of headroom |
| `storagePath` | string | XDG_DATA_HOME/opencode/storage | Directory for sidecar state files |
| `providers.<providerID>` | object | — | Per-provider override layer (same keys as above, plus `modelContextLimit`) |
| `models.<modelID>` | object | — | Per-model override layer, applied after the provider layer |


### Runtime memory and dashboard behavior

Each process/storage root shares one authenticated dashboard listener and one
resident-session cache. Multiple workspaces register their own backends, keeping
session configuration and mutation routing workspace-specific. A conflicting
explicit dashboard port is rejected rather than starting another listener.

The cache saves exact state and history before evicting an idle session, and
reloads it for the next tool, slash command, transform, or dashboard request.
Queued/executing operations and busy model streams remain pinned. If host status
cannot be verified, storage is disabled, or a checkpoint fails, the session stays
resident; active or unrecoverable data can exceed the configured cache target.
Factories sharing a root use the most restrictive configured cache limits.

The dashboard requests paged inventory and bounded previews, then loads complete
HOT messages or WARM/COLD summaries when expanded. Closing details or switching
pages/chats releases those UI payloads. Page/detail requests use both edit revision
and projection-generation guards. API consumers can still explicitly request the
legacy full snapshot. Offload-directory scans are coalesced to at most one attempt
per directory every ten minutes rather than on every tool-loop re-feed.

Mechanical pruning and tier economics operate on the visible automatic projection,
not on originals already replaced by active summaries/catalogs. Zero-usage assistant
stubs no longer turn a warm cache signal cold. Exact originals stay recoverable.

The plugin does not rewrite OpenCode's stored transcript or implement incremental
archive storage, so very large host histories and repeated full snapshot writes
remain known costs. Restart OpenCode at a safe idle time after updating the plugin.

The two automation switches are independent. With `automaticPruning: false`,
the next projection restores content hidden by persisted mechanical decisions and
skips both the policy and provider-limit hard caps; the decisions remain stored so
turning pruning back on is deterministic. Existing active compression blocks remain
active and reversible. With `modelCompression: false`, compression nudges and
side-channel requests stop, both compression tools reject calls, and `/ctx-compress`
is disabled. Existing blocks can still be restored or re-applied without generating
a new summary.

For preserved-thinking models such as Kimi K3, a conservative starting override is:

```json
{
  "automation": {
    "automaticPruning": false,
    "modelCompression": false
  }
}
```

This also disables the context manager's context-limit backstop, so the provider may reject an
oversized request. It does not control OpenCode's native compaction. Start a fresh
model session and restore any already-active context-manager blocks if exact prior reasoning is
required. Do not use `costRoi.enabled: false` as an off switch: that disables only
the economic gate and makes eligible mechanical pruning more permissive.

Threshold fields accept an absolute token count **or** a `"X%"` string resolved
against the model context limit (so the same config scales across model windows).
`cachePrune` can also be overridden per provider/model via `ctx.providers[providerID]`
and `ctx.models[modelID]` using the same nested keys.

Token counts shown to the model are estimates, not provider billing guarantees.
In `auto` mode Claude uses `@anthropic-ai/tokenizer` when installed; every model
then calibrates independently against total provider-reported usage (uncached
input plus cache read/write). Calibration is
matched to the exact prior outbound request through assistant `parentID`, consumed
once, and reset together with the request-delta baseline whenever provider/model
changes. The compression target is the lower nudge threshold, clamped to 75% of
the earliest safety/policy ceiling for small windows. The changing status is
tail-only but necessarily changes the current request tail's prompt-cache bytes.

### Hot / warm / cold tiers and the durable archive

Compressed context is projected in three tiers (`config.contextTiers`):

- **HOT** — the exact live message projection the model sees. This is always the
  source of truth for what reaches a request.
- **WARM** — active compression blocks whose *full summaries* are carried in
  context. `warmMaxTokens` (default `"8%"`) is enforced only in `"strict"` mode;
  in `"advisory"` mode it is a model/dashboard target. Oldest-first demotion also
  retires blocks past `warmMaxAgeTurns` (default 40 user turns) when
  `ageDemotionEnabled` is true. Disabling age demotion leaves model choices stable,
  but the strict WARM token cap still applies.
- **COLD** — demoted blocks replaced by a stable newest-first catalog bounded by
  `catalogMaxTokens` (default `"1%"`). Only whole catalog entries are added; the
  catalog never truncates a line mid-entry.

Every block writes **two immutable, content-addressed archives** before its refs
are published: an exact `compression-source-v1` (the full host entries) and a
`compression-summary-v1` (the whole summary). Both are digest-verified on read, so
decompression and retrieval can never serve corrupted content. A block is only
eligible for demotion when **both** archives exist.

The model-side tools:

- `ctx_archive_search` — searches this session's summary archives and returns
  block refs, labels, scores, and match snippets (no storage identities, no full
  summaries, no other sessions).
- `ctx_archive_retrieve` — returns **whole** cold summaries and atomically promotes
  accepted blocks persistently to WARM. Retrieval never truncates a summary:
  `retrievalMaxTokens` is a calibrated per-call safety limit, so an oversized item
  is explicitly omitted rather than sliced. The immediate checksum-framed historical
  JSON is replaced by the canonical WARM summary on the next projection.
- `ctx_tier_update` — persistently promotes COLD roots or demotes WARM roots at any
  time, without requiring another compression call.
- `ctx_archive_release` — cleans up temporary leases created by older versions;
  never deletes archives.

Both `compress` and `compress_message` accept optional `promoteBlockIds` and
`demoteBlockIds`. The model can search/retrieve cold summaries, then atomically
choose which active roots remain fully WARM while it compresses new work. In strict
mode, promotions must fit and remain protected from immediate cap demotion. In
advisory mode, model choices win and only the overall context hard cap remains
mandatory. Invalid, consumed, overlapping, archive-mismatched, or incomplete targets
reject atomically. New blocks start WARM.

Tier semantics are coupled to the automation switches:

- `automaticPruning: false` or `contextTiers.enabled: false` restores **every**
  block's full summary (no cold catalog) in the next projection, while the demotion
  decisions stay stored for deterministic re-enable.
- `modelCompression: false` suppresses compression nudges and requests but leaves
  existing warm/cold blocks (and the retrieval tools) operational — retrieval and
  release do not generate new summaries.

Tier budgets are read from the plugin config at startup and from dashboard runtime
overrides live. Changing the `ctx` key in `opencode.json` (including `contextTiers`)
requires an OpenCode restart to take effect; dashboard-saved overrides apply without
a restart.

### Persistence

State is stored at `<storagePath>/ctx/<sessionId>.json`. Writes are atomic
(temp file + rename). Maps and Sets are serialized as arrays. Immutable archive
records live under `<storagePath>/content-blobs/`; current raw/projected session
snapshots live under `<storagePath>/session-snapshots/` and are replaced atomically.

### Compression and recovery

- `compress` accepts one or more non-overlapping ranges addressed by `mNNNN` or
  `bN` refs. The complete batch is validated before any state change.
- `compress_message` accepts individual message summaries in one transaction.
- Blocks retain direct/effective source IDs and parent/child graph edges. A nested
  block deactivates consumed children without deleting them.
- `/ctx-decompress [bN]` restores exact archived host messages even after native
  compaction. `/ctx-recompress [bN]` re-applies an existing summary without a
  second model call.

### Portable context between devices

With the plugin installed on both machines, use these commands in an idle chat:

```text
/ctx-export
/ctx-import
```

Both default to `.ctx/context.json` in the current project/worktree. Export creates
a self-contained UTF-8 JSON handoff. Import loads it into a **new, empty chat** on
the destination device. Both devices must load a build of this plugin supporting
the handoff format. No OpenCode database copying is required.

Example Git workflow:

1. On the source device, finish the current request and run `/ctx-export`.
2. Review the file, then stage and commit `.ctx/context.json` in the project and
   push normally. If the project ignores `.ctx`, explicitly allow this file.
3. Pull the project on the destination device, open a new chat, choose the
   destination model, and run `/ctx-import`.
4. Continue with the next task. The importer stores an independent durable copy;
   later edits or deletion of the Git file do not alter that chat.

Custom paths and explicit replacement are supported:

```text
/ctx-export ".ctx-context/experiment handoff.json"
/ctx-export --overwrite
/ctx-import ".ctx-context/experiment handoff.json"
```

The commands never stage, commit, push, or pull automatically. The file contains
conversation content and may include sensitive source/tool output; review it
before committing. Paths must be project-relative. Existing files require
`--overwrite`; symlink paths, traversal, and `.git` paths are rejected. Concurrent
filesystem writers are assumed trusted: Node pathname operations do not provide
directory-handle-relative confinement against an adversary swapping parent paths.

**What travels:** ordered HOT projected content (including the latest completed
assistant reply), complete WARM/COLD active-root summaries, their available
effective recovery sources, and referenced offloads/attachments. Shared records
and resource blobs are deduplicated. Foreign execution metadata is omitted, and
tools are represented as historical records rather than executable tool calls.
Referenced offloads must be backed by session metadata; arbitrary paths in prose
do not authorize copying other local output files. Missing required resources or
unsupported visible part types produce an explicit error.

**Recovery contract:** active roots are flattened. Decompression restores their
historical source records, not the former nested block-editing history or original
host IDs. Existing legacy roots without original-source archives remain explicitly
summary-only. Corrupt/missing declared archives are rejected. Manual summary
replacement/exclusion is retained. Unrelated discarded history, old undo history,
host settings, provider credentials, system prompts, and runtime calibration are
not exported. Absolute paths inside historical text/arguments remain historical
text; embedded resource references receive destination-local paths.

The checksum validates integrity, not authorship. Reimporting the same digest is
idempotent and does not reset subsequent work; a different bundle cannot overwrite
a populated chat. Import checks the destination model's context limit and strict
WARM budget, if configured, before publishing state. It does not silently prune
the handoff to make it fit. Choose a sufficient-context model or compress the
source before exporting if that check fails.

Version 1 bounds the file, decoded blobs, and expanded historical rendering to
64 MiB each; source SDK history reads also reject observed histories over 64 MiB
or 10,000 messages. Limits include 10,000 portable records, 1,000 roots,
100,000 reference edges, and depth 64. Resource bindings have additional count,
path-byte, search-work, and 65,536-node matcher limits. These limits cause explicit
errors, never partial exports. Large legacy archives may still need substantial
temporary memory when collecting their sources.

### Local control plane

The server is disabled by default. Enable `ctx.controlServer.enabled`, restart
OpenCode, then run `/ctx-ui`. The plugin opens an authenticated loopback URL
directly in the local browser, without exposing the token to
the model or logs. In headless environments, the command reports the path of a
mode-0600 bootstrap file instead. The server exchanges the authenticated URL visit for
an HttpOnly SameSite cookie, rejects non-loopback binds and Host headers, and
exposes no CORS access.

The URL opens the general dashboard:

```
http://ctx-<nonce>.localhost:<port>/#token=…
```

After authentication, choose any current chat from the dashboard selector. Labeled
origins remain supported internally, and the random `<nonce>` is always required.
The nonce is what keeps the host-only dashboard cookie away from unrelated loopback
services, since cookies are not port-scoped; the credential itself stays in the
fragment, which is never sent in an HTTP request, referrer, or log.

The dashboard deliberately separates:

- **HOT / WARM / COLD CONTENTS**: the current tier inventory, with exact HOT messages,
  full WARM summaries, archived COLD summaries, and persistent tier controls.

Every message is annotated with whether it reaches the model and why not
(`compressed into bN`, `not sent`, `saved/staged` override), and carries inline
`Force keep` / `Drop` / `Replace…` controls plus the cached-token cost of editing
at that position. Next-request estimates are simulated from the server-derived
automatic projection before manual overrides, so resetting an existing exclude or
replacement restores the correct baseline. They remain estimates: the new user
message and any additional pruning performed by that request are not known yet.

Edits are staged locally and committed as one batch (`POST
/api/sessions/:id/projection`). Saving:

- takes effect on the **next** request — the edited projection replaces the previous
  history and your new message is appended after it;
- costs **one** revision and therefore one prompt-cache invalidation, no matter how
  many messages the batch touches;
- is **cache-coalesced**: because that request already rewrites the cached prefix,
  core lets otherwise cache-deferred dedup / stale-error / near-dupe / masking run in
  the same turn (`core/projectionEdits.ts`) instead of paying a second invalidation
  later, records exactly one cache-bust event for the adaptive `E_turns` estimate,
  and then leaves the prefix byte-stable so the cache refills normally.

A saved-but-not-yet-delivered edit is reported as `pendingProjectionEdit` in the API
and as “Saved — applies at your next message” in the UI. The edit is acknowledged only
once the host actually holds the edited messages and the acknowledgement state is
durable, so an aborted or failed-persistence turn re-delivers it.

Two edits are refused rather than silently ignored: `keep`/`replace` on a message
covered by an active compression block (it would send the original beside its summary
— restore the block first), and any override targeting a generated `__manual_*` id.
A saved settings change does not arm the cache-coalescing signal, because it only
affects future pruning decisions, which account for their own invalidation.

Keep/exclude/replace edits affect only the model projection and persist across
host re-feeds. They never rewrite OpenCode's raw store. The settings editor stores
only explicit validated runtime overrides; resolved profile/provider/model settings
are displayed separately so saving one field does not freeze inherited defaults.

---

## Other adapters

- `adapters/claude-code/` (typed stub): Anthropic Messages API ↔ NeutralMessage
  mapping, cache breakpoint placement (two-position rule, `breakpointLimit = 4`),
  and the `tools → system → messages` ordering requirement.
- `adapters/bff/` (typed stub): how a backend-for-frontend proxy in front of the
  opencode REST API could run the pipeline.

The host-agnostic core is also exported as a library:

```ts
import { runPipeline, resolveConfig } from "opencode-ctx/lib";
import { createCtxV2Plugin } from "opencode-ctx/opencode-v2/lib";
```

## Development

Requires [Bun](https://bun.sh) for tests and Node 18.17+ for the build.

```bash
bun install                 # required before typecheck (pulls typescript + @types/node)
bun test                    # full suite
bun run typecheck           # zero errors (tsc --noEmit)
bun run compile             # emit ESM JavaScript + declarations to dist/
```

The full release suite, strict typecheck and compiled distribution checks pass.

### v1.0.1 behavior and recovery notes

Near-dupe now requires the same tool and known normalized resource. Fingerprints
preserve case/syntax; punctuation/operator sequences must match, and the existing
64-bit SimHash threshold remains at most 4 differing bits. Only the earlier output
is superseded. Similarity is not semantic equivalence; exact-input dedup is unchanged.
Legacy near-dupe decisions are discarded once because their resource/pair evidence
was not stored. This restores potentially hidden content and may invalidate cache.

New V2 source archives preserve original media/opaque part JSON outside text-token
accounting, allowing recovery with a fresh plan after native compaction. Embedded
payloads increase disk/memory use. Old marker-only archives cannot recover missing
payloads and now error instead of silently omitting them. Media URLs restore their
references, not remote bytes. Source archives have no new per-item size cap.

Portable/remote handoff v1 rejects arbitrary V2 media/opaque parts and native prompt
file descriptors rather than exporting incomplete text-only history. Supported V1
attachments remain supported. Existing 64 MiB portable/history and 32 MiB remote
transfer limits are unchanged; oversized captures must be narrowed, not truncated.

Offload directories are created/tightened to 0700 and files atomically published
as 0600. Workspace/system-temp ancestors are untouched; existing logs are tightened
to 0600 on append. Snapshots, dashboard bootstrap HTML, migration backups and
portable exports already use owner-only writes.

## Releasing

`dist/` is committed because Git installs do not run a build step. Do not add
`build`, `prepare`, `prepack`, `install`, `preinstall`, or `postinstall` scripts:
any of them makes npm "prepare" the Git dependency by running `npm install` in
the clone, which fails inside OpenCode's plugin installer (observed with
OpenCode 2.2.5). That is why the build script is named `compile`.

1. Bump `version` in `package.json`.
2. `bun install && bun test && bun run typecheck && bun run compile`.
3. Commit the source changes together with the rebuilt `dist/`.
4. Tag and push: `git tag vX.Y.Z && git push origin main vX.Y.Z`.

Users on unpinned installs pick up the release with `opencode plugin update`.

## License

PolyForm Noncommercial 1.0.0 — see [LICENSE](LICENSE). You may use, modify, and share it
for personal and other noncommercial purposes; commercial use requires permission from the author.
