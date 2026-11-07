// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Self-contained control-plane UI. API-provided strings are only written with textContent.
//
// Interaction model: paged inventory with explicit exact-detail reads.
//   - Edits are staged locally and saved as one revision/cache-prefix rewrite.
//     The tray avoids claiming a precise cost from one inventory page.
//   - No template-literal interpolation is used in the embedded script: this
//     file IS a template literal, so the script uses string concatenation only.
export const CONTROL_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Context Manager Control</title>
<style>
:root{color-scheme:dark;--ink:#e8eadf;--dim:#98a08f;--paper:#0f1412;--panel:#171e1a;--line:#2f3a33;--acid:#b7ed65;--warn:#ffc66d;--red:#ff7b72;--blue:#79c0ff;font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);padding-bottom:6rem}
button,input,select,textarea{font:inherit;color:inherit;border:1px solid var(--line);background:#0b100e;border-radius:4px}
button{cursor:pointer;padding:.45rem .7rem}
button:hover:not(:disabled),button:focus-visible{border-color:var(--acid)}
button:disabled{opacity:.4;cursor:not-allowed}
button.primary{background:var(--acid);color:#10130d;border-color:var(--acid);font-weight:700}
button.danger{color:var(--red)}
button.on{background:#22301c;border-color:var(--acid);color:var(--acid)}
input,select,textarea{padding:.45rem}
textarea{width:100%;min-height:8rem;resize:vertical}
h1,h2{margin:0}
header{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;padding:.8rem 1rem;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(15,20,18,.97);z-index:5}
header h1{font-size:.9rem;letter-spacing:.14em;color:var(--acid)}
header select{max-width:22rem}
.usage{display:flex;flex-direction:column;gap:.2rem;min-width:12rem}
.bar{height:6px;background:#20281f;border-radius:3px;overflow:hidden}
.bar span{display:block;height:100%;background:var(--acid)}
.meta{color:var(--dim);font-size:.8rem}
.status{margin-left:auto;color:var(--dim);font-size:.85rem;text-align:right}
.status.error{color:var(--red)}
.status.saved{color:var(--acid)}
main{padding:1rem;display:grid;gap:1rem;max-width:78rem;margin:0 auto}
section{border:1px solid var(--line);background:var(--panel);border-radius:6px;padding:1rem;min-width:0}
.tabs{display:flex;gap:.5rem;flex-wrap:wrap}
.tabs button{letter-spacing:.1em;font-size:.78rem}
.hint{color:var(--dim);font-size:.85rem;margin:.7rem 0 0}
.toolbar{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.8rem 0}
.toolbar input[type=search]{flex:1;min-width:11rem}
.check{display:flex;gap:.35rem;align-items:center;color:var(--dim);font-size:.85rem}
.rows{display:grid;gap:.6rem}
.row{border:1px solid var(--line);border-left:3px solid var(--line);background:#111713;border-radius:4px;padding:.7rem}
.row.in{border-left-color:var(--acid)}
.row.out{border-left-color:#3d463c}
.row.edited{border-left-color:var(--warn)}
.row-head{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;font-size:.8rem;color:var(--dim)}
.tag{border:1px solid var(--line);border-radius:3px;padding:.05rem .35rem}
.tag.role{color:var(--blue)}
.tag.in{color:var(--acid)}
.tag.out{color:var(--dim)}
.tag.edit{color:var(--warn)}
.tag.staged{color:var(--warn);border-color:var(--warn)}
.grow{flex:1}
.part{margin:.5rem 0 0;border-left:2px solid var(--line);padding-left:.6rem}
.part b{color:var(--dim);font-weight:400;font-size:.78rem}
pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:.25rem 0 0;font:inherit}
.acts{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin-top:.6rem}
.acts .cost{color:var(--dim);font-size:.78rem;margin-left:auto}
.cards{display:grid;gap:.6rem;grid-template-columns:repeat(auto-fit,minmax(19rem,1fr))}
.card{border:1px solid var(--line);border-radius:4px;padding:.7rem;background:#111713}
.empty{color:var(--dim);padding:.8rem 0}
.fields{display:grid;gap:.7rem;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr))}
.fields label{display:grid;gap:.25rem;font-size:.85rem;color:var(--dim)}
.fields input,.fields select{width:100%}
details{margin-top:.8rem}
summary{cursor:pointer;color:var(--dim)}
.tray{position:fixed;left:0;right:0;bottom:0;display:flex;gap:.75rem;align-items:center;flex-wrap:wrap;padding:.75rem 1rem;background:rgba(23,30,26,.98);border-top:1px solid var(--acid);z-index:6}
.tray[hidden]{display:none}
.tray .sum{display:grid;gap:.15rem;font-size:.85rem}
.tray .sum b{color:var(--acid);font-weight:700}
.tray .acts2{margin-left:auto;display:flex;gap:.5rem}
dialog{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:6px;max-width:44rem;width:92vw}
dialog h2{font-size:.8rem;letter-spacing:.12em;color:var(--acid);margin-bottom:.6rem}
dialog .acts{justify-content:flex-end}
.skip{position:absolute;left:-9999px}
.skip:focus{left:.5rem;top:.5rem;background:var(--panel);padding:.5rem;z-index:9}
@media(max-width:760px){header{align-items:flex-start}header select,.usage{width:100%;max-width:none}.status{margin-left:0;text-align:left}.acts .cost{margin-left:0;width:100%}.tray .acts2{margin-left:0;width:100%}.tray button{flex:1}}
</style>
</head>
<body>
<a class="skip" href="#blocks-section">Skip to context</a>
<header>
  <h1>CTX // CONTEXT CONTROL</h1>
  <label class="skip" for="session">Chat</label>
  <select id="session" aria-label="Choose chat"><option>Loading chats...</option></select>
  <div class="usage">
    <div class="bar"><span id="usage-bar" style="width:0%"></span></div>
    <span id="usage-text" class="meta">Context usage</span>
  </div>
  <span id="status" class="status" role="status" aria-live="polite">Connecting</span>
</header>
<main>
<section id="blocks-section">
  <h2>HOT / WARM / COLD CONTENTS</h2>
  <p class="hint">Browse bounded previews. Expand a message or block to load its complete exact contents.</p>
  <div id="blocks" class="cards"></div>
  <div id="block-page" class="toolbar"></div>
</section>
<section>
  <h2>HOT MESSAGES</h2>
  <div id="messages" class="rows"></div>
  <div id="message-page" class="toolbar"></div>
</section>
<section>
  <h2>EXCLUDED OVERRIDES</h2>
  <div id="excluded" class="rows"></div>
  <div id="excluded-page" class="toolbar"></div>
</section>
<section>
  <h2>EDITABLE SETTINGS</h2>
  <p class="hint">These are your explicit overrides only. Leave a field on "inherit" to keep the resolved default.</p>
  <form id="settings-form">
    <div class="fields">
      <label>Automatic pruning<select id="s-autoprune"><option value="">inherit</option><option value="true">on</option><option value="false">off</option></select></label>
      <label>Model-called compression<select id="s-model-compression"><option value="">inherit</option><option value="true">on</option><option value="false">off</option></select></label>
      <label>Profile<select id="s-profile"><option value="">inherit</option><option value="documents">documents</option><option value="code">code</option><option value="balanced">balanced</option></select></label>
      <label>Recency guard turns<input id="s-recency" type="number" min="0" step="1" placeholder="inherit"></label>
      <label>Compression recency requests<input id="s-compression-recency" type="number" min="0" step="1" placeholder="inherit (3)"></label>
      <label>Hard cap<input id="s-hardcap" type="text" placeholder="inherit (e.g. 92% or 180000)"></label>
      <label>Clear at least<input id="s-clear" type="number" min="0" step="1" placeholder="inherit"></label>
      <label>Mask trigger<input id="s-mask" type="text" placeholder="inherit (tokens or %)"></label>
      <label>Cost-ROI gate<select id="s-costroi"><option value="">inherit</option><option value="true">on</option><option value="false">off</option></select></label>
      <label>Near-duplicate pruning<select id="s-neardupe"><option value="">inherit</option><option value="true">on</option><option value="false">off</option></select></label>
      <label>Context tiers<select id="s-context-tiers"><option value="">inherit</option><option value="true">on</option><option value="false">off</option></select></label>
      <label>Warm budget mode<select id="s-warm-budget-mode"><option value="">inherit</option><option value="advisory">advisory</option><option value="strict">strict</option></select></label>
      <label>Automatic age demotion<select id="s-age-demotion"><option value="">inherit</option><option value="true">on</option><option value="false">off</option></select></label>
      <label>Warm summary budget<input id="s-warm-budget" type="text" placeholder="inherit (tokens or %)"></label>
      <label>Warm max age turns<input id="s-warm-age" type="number" min="0" step="1" placeholder="inherit"></label>
      <label>Cold catalog budget<input id="s-cold-catalog" type="text" placeholder="inherit (tokens or %)"></label>
      <label>Retrieval response cap<input id="s-retrieval-budget" type="text" placeholder="inherit (tokens or %)"></label>
      <label>Legacy lease TTL turns<input id="s-retrieval-ttl" type="number" min="0" step="1" placeholder="inherit"></label>
    </div>
    <p class="hint">Automatic pruning off also disables the mechanical hard cap. Model compression off rejects compression tool calls and removes compression nudges.</p>
    <p class="hint">Cold summaries stay durably archived and searchable. Retrieving one promotes it persistently to WARM; the model or dashboard moves it back to COLD when its relevance ends.</p>
    <div class="acts"><button class="primary" type="submit">Save settings</button></div>
  </form>
  <details>
    <summary>Advanced overrides JSON</summary>
    <form id="settings-json-form">
      <label class="meta" for="settings-json">Replaces the whole override layer</label>
      <textarea id="settings-json" spellcheck="false"></textarea>
      <div class="acts"><button type="submit">Save JSON</button></div>
    </form>
  </details>
  <details>
    <summary>Resolved effective settings (read-only)</summary>
    <pre id="effective-settings"></pre>
  </details>
</section>
<section>
  <h2>ARCHIVED CONTENT SEARCH</h2>
  <p class="hint">Durable archives: exact compressed sources, offloaded tool output, and host messages are searchable here. The model can find COLD summaries with ctx_archive_search, retrieve and persistently promote them with ctx_archive_retrieve, then move blocks in either direction with ctx_tier_update.</p>
  <form id="search-form" class="toolbar">
    <input id="archive-query" type="search" required placeholder="Search archived content" aria-label="Archived content query">
    <button class="primary">Search</button>
  </form>
  <div id="search-results" class="rows"></div>
</section>
</main>
<div id="tray" class="tray" hidden aria-live="polite">
  <div class="sum">
    <span id="tray-count"><b>0</b> staged edits</span>
    <span id="tray-cost" class="meta"></span>
  </div>
  <div class="acts2">
    <button id="tray-discard" type="button">Discard</button>
    <button id="tray-save" class="primary" type="button">Save &amp; use at next request</button>
  </div>
</div>
<dialog id="replace-dialog">
  <form method="dialog">
    <h2>MESSAGE PROJECTION OVERRIDE</h2>
    <p id="replace-target" class="meta"></p>
    <label class="meta" for="replace-text">Replacement text sent instead of this message</label>
    <textarea id="replace-text"></textarea>
    <div class="acts"><button value="cancel">Cancel</button><button id="replace-confirm" class="primary" value="confirm">Stage replacement</button></div>
  </form>
</dialog>
<dialog id="confirm">
  <form method="dialog">
    <h2>Confirm context change</h2>
    <p id="confirm-text"></p>
    <div class="acts"><button value="cancel">Cancel</button><button class="primary" value="confirm">Confirm</button></div>
  </form>
</dialog>
<script>
(() => {
  "use strict";
  const el = id => document.getElementById(id);
  const state = { snapshot: null, staged: new Map(), details: new Map(), epoch: 0 };

  const node = (tag, value, className) => {
    const n = document.createElement(tag);
    if (value !== undefined && value !== null) n.textContent = String(value);
    if (className) n.className = className;
    return n;
  };
  const num = value => Number(value || 0).toLocaleString();
  const compact = value => {
    const n = Number(value || 0);
    return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n);
  };

  const api = async (path, options) => {
    const opts = options || {};
    const headers = Object.assign({}, opts.body ? { "Content-Type": "application/json" } : {}, opts.headers || {});
    const response = await fetch(path, Object.assign({ credentials: "same-origin" }, opts, { headers }));
    const body = await response.json().catch(() => ({ error: { message: "Invalid server response" } }));
    if (!response.ok) {
      const error = new Error((body.error && body.error.message) || ("Request failed: " + response.status));
      error.code = body.error && body.error.code;
      throw error;
    }
    return body.data;
  };

  function setStatus(text, kind) {
    const target = el("status");
    target.textContent = text;
    target.className = "status" + (kind ? " " + kind : "");
  }
  function showError(error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
  async function handleMutationError(error, snapshot, staged) {
    if (error.code === "REVISION_CONFLICT" && state.snapshot === snapshot) {
      await loadSession(snapshot.sessionId);
      if (staged && state.snapshot && state.snapshot.sessionId === snapshot.sessionId) {
        state.staged = staged;
        render();
      }
      setStatus("Session changed; inventory reloaded. Review and retry your edit.", "error");
    } else showError(error);
  }

  // ── Paged inventory / exact details ──────────────────────────
  const basePath = () => "/api/sessions/" + encodeURIComponent(state.snapshot.sessionId);
  const pageUrl = (messageOffset, blockOffset, overrideOffset, revision, generation) => basePath() + "?view=inventory&messageOffset=" +
    messageOffset + "&blockOffset=" + blockOffset + "&overrideOffset=" + overrideOffset + "&limit=50" +
    (revision === undefined ? "" : "&revision=" + revision + "&generation=" + encodeURIComponent(generation));
  function clearDetails() { state.details.clear(); state.epoch++; }
  async function loadPage(messageOffset, blockOffset, overrideOffset) {
    const sessionId = state.snapshot.sessionId;
    const epoch = ++state.epoch;
    try {
      const result = await api(pageUrl(messageOffset, blockOffset, overrideOffset, state.snapshot.revision, state.snapshot.generation));
      if (epoch !== state.epoch || state.snapshot.sessionId !== sessionId) return;
      state.details.clear();
      state.snapshot = result;
      render();
    } catch (error) {
      if (epoch !== state.epoch) return;
      if (error.code === "REVISION_CONFLICT") await loadSession(sessionId);
      else showError(error);
    }
  }
  async function loadDetail(kind, id, container, isCurrent) {
    const snapshot = state.snapshot;
    const epoch = state.epoch;
    const key = kind + ":" + id;
    const path = basePath() + (kind === "message" ? "/messages/" : "/blocks/") +
      encodeURIComponent(id) + (kind === "message" ? "" : "/detail") + "?revision=" + snapshot.revision +
      "&generation=" + encodeURIComponent(snapshot.generation);
    container.replaceChildren(node("span", "Loading exact contents...", "meta"));
    try {
      const data = await api(path);
      if (epoch !== state.epoch || !isCurrent() || !container.isConnected || !container.parentElement.open ||
        state.snapshot !== snapshot) return;
      state.details.set(key, data);
      container.replaceChildren();
      if (kind === "block") container.append(node("pre", data.block.summaryText || ""));
      else partsOf(data.message).forEach(part => {
        const wrap = node("div", null, "part");
        wrap.append(node("b", part.label), node("pre", part.body));
        container.append(wrap);
      });
    } catch (error) {
      if (epoch === state.epoch && isCurrent() && container.isConnected) showError(error);
    }
  }
  function exactToggle(kind, id, label) {
    const details = document.createElement("details");
    const body = node("div");
    let request = 0;
    details.append(node("summary", label), body);
    details.addEventListener("toggle", () => {
      const current = ++request;
      if (details.open) loadDetail(kind, id, body, () => current === request);
      else { state.details.delete(kind + ":" + id); body.replaceChildren(); }
    });
    return details;
  }
  function pageControls(targetId, offset, count, change) {
    const target = el(targetId);
    target.replaceChildren();
    const prev = node("button", "Previous");
    const next = node("button", "Next");
    prev.disabled = offset === 0;
    next.disabled = offset + state.snapshot.limit >= count;
    prev.addEventListener("click", () => change(Math.max(0, offset - state.snapshot.limit)));
    next.addEventListener("click", () => change(offset + state.snapshot.limit));
    target.append(prev, node("span", count ? (offset + 1) + "–" + Math.min(count, offset + state.snapshot.limit) + " / " + count : "0 / 0", "meta"), next);
  }

  // ── Rendering ─────────────────────────────────────────────────
  function partsOf(item) {
    const parts = Array.isArray(item.parts) ? item.parts : [];
    return parts.map(part => {
      if (part.type === "text" || part.type === "reasoning") return { label: part.type, body: part.text || "" };
      if (part.type === "tool") {
        const status = (part.state && part.state.status) || "";
        const output = part.state && part.state.output;
        return {
          label: "tool " + (part.tool || "") + (status ? " (" + status + ")" : ""),
          body: typeof output === "string" ? output : JSON.stringify(part.state || {}, null, 2),
        };
      }
      return { label: part.type || "part", body: JSON.stringify(part, null, 2) };
    });
  }
  function renderBlocks() {
    const target = el("blocks");
    target.replaceChildren();
    const hotCard = node("article", null, "card");
    const hotHead = node("div", null, "row-head");
    hotHead.append(node("strong", "HOT"));
    hotHead.append(node("span", state.snapshot.messageCount + " exact messages / " + num(state.snapshot.hotTokenCount) + " tokens", "grow"));
    hotCard.append(hotHead);
    target.append(hotCard);
    (state.snapshot.blocks || []).forEach(block => {
      const card = node("article", null, "card");
      const head = node("div", null, "row-head");
      head.append(node("strong", block.blockId));
      head.append(node("span", block.status, "tag " + (block.status === "active" ? "in" : "out")));
      const tier = block.status !== "active" ? "inactive / nested" : block.projectionTier === "cold" ? "cold" : "warm";
      head.append(node("span", tier, "tag " + (tier === "cold" ? "out" : "in")));
      head.append(node("span", num(block.sourceTokens) + " tok -> " + num(block.summaryTokens) + " tok", "grow"));
      card.append(head);
      if (block.topic) card.append(node("div", block.topic, "meta"));
      if (block.sourceCount) card.append(node("div", block.sourceCount + " source messages", "meta"));
      card.append(exactToggle("block", block.blockId, "Show full " + tier + " summary"));
      const acts = node("div", null, "acts");
      if (block.status === "active") {
        const tierAction = tier === "cold" ? "promote" : "demote";
        const tierLabel = tier === "cold" ? "Promote to WARM" : "Move to COLD";
        const tierButton = node("button", tierLabel);
        tierButton.type = "button";
        tierButton.addEventListener("click", () => blockAction(block.blockId, tierAction, tierLabel));
        acts.append(tierButton);
      }
      const action = block.status === "active" ? "deactivate" : "reactivate";
      const label = block.status === "active" ? "Restore originals" : "Re-apply summary";
      [[action, label], ["recompress", "Recompress"]].forEach(pair => {
        const button = node("button", pair[1]);
        button.type = "button";
        button.addEventListener("click", () => blockAction(block.blockId, pair[0], pair[1]));
        acts.append(button);
      });
      card.append(acts);
      target.append(card);
    });
    pageControls("block-page", state.snapshot.blockOffset, state.snapshot.blockCount,
      offset => loadPage(state.snapshot.messageOffset, offset, state.snapshot.overrideOffset));
  }

  function renderMessages() {
    const target = el("messages");
    target.replaceChildren();
    (state.snapshot.messages || []).forEach(item => {
      const card = node("article", null, "row in");
      const head = node("div", null, "row-head");
      head.append(node("span", item.role, "tag role"), node("strong", item.id, "grow"),
        node("span", num(item.tokenCount) + " tok", "tag"));
      card.append(head, node("pre", item.preview || ""), exactToggle("message", item.id, "Show exact HOT contents"));
      const saved = item.override;
      const current = state.staged.has(item.sourceId) ? state.staged.get(item.sourceId) : saved;
      if (current) card.append(node("span", (state.staged.has(item.sourceId) ? "staged: " : "saved: ") + current.mode, "tag edit"));
      const acts = node("div", null, "acts");
      const stage = (override, label) => {
        const button = node("button", label);
        button.type = "button";
        button.disabled = Boolean(item.blockId) && override && override.mode !== "exclude";
        button.addEventListener("click", () => { state.staged.set(item.sourceId, override); clearDetails(); render(); });
        return button;
      };
      acts.append(stage({ mode: "keep" }, "Force keep"), stage({ mode: "exclude" }, "Drop"));
      const replace = node("button", "Replace...");
      replace.disabled = Boolean(item.blockId);
      replace.addEventListener("click", () => openReplace(item));
      acts.append(replace);
      if (saved || state.staged.has(item.sourceId)) acts.append(stage(null, "Reset"));
      card.append(acts);
      target.append(card);
    });
    pageControls("message-page", state.snapshot.messageOffset, state.snapshot.messageCount,
      offset => loadPage(offset, state.snapshot.blockOffset, state.snapshot.overrideOffset));
    const excluded = el("excluded");
    excluded.replaceChildren();
    (state.snapshot.excludedOverrides || []).forEach(item => {
      const card = node("article", null, "row out");
      card.append(node("strong", item.sourceId), node("pre", item.preview));
      if (item.role !== "unavailable") card.append(exactToggle("message", item.id, "Show exact excluded source"));
      const reset = node("button", state.staged.has(item.sourceId) ? "Unstage reset" : "Reset exclusion");
      reset.type = "button";
      reset.addEventListener("click", () => {
        if (state.staged.has(item.sourceId)) state.staged.delete(item.sourceId);
        else state.staged.set(item.sourceId, null);
        clearDetails(); render();
      });
      card.append(reset);
      excluded.append(card);
    });
    pageControls("excluded-page", state.snapshot.overrideOffset, state.snapshot.excludedOverrideCount,
      offset => loadPage(state.snapshot.messageOffset, state.snapshot.blockOffset, offset));
  }

  function renderSettings() {
    const settings = state.snapshot.settings || {};
    const automation = settings.automation || {};
    el("s-autoprune").value = automation.automaticPruning === undefined ? "" : String(automation.automaticPruning);
    el("s-model-compression").value = automation.modelCompression === undefined ? "" : String(automation.modelCompression);
    el("s-profile").value = settings.profile || "";
    el("s-recency").value = settings.recencyGuardTurns === undefined ? "" : settings.recencyGuardTurns;
    el("s-compression-recency").value = settings.compressionRecencyRequests === undefined ? "" : settings.compressionRecencyRequests;
    el("s-hardcap").value = settings.hardCap === undefined ? "" : settings.hardCap;
    el("s-clear").value = settings.clearAtLeast === undefined ? "" : settings.clearAtLeast;
    const nudges = settings.nudges || {};
    el("s-mask").value = nudges.maskTriggerThreshold === undefined ? "" : nudges.maskTriggerThreshold;
    const costRoi = settings.costRoi || {};
    el("s-costroi").value = costRoi.enabled === undefined ? "" : String(costRoi.enabled);
    const nearDupe = settings.nearDupe || {};
    el("s-neardupe").value = nearDupe.enabled === undefined ? "" : String(nearDupe.enabled);
    const tiers = settings.contextTiers || {};
    el("s-context-tiers").value = tiers.enabled === undefined ? "" : String(tiers.enabled);
    el("s-warm-budget-mode").value = tiers.warmBudgetMode === undefined ? "" : String(tiers.warmBudgetMode);
    el("s-age-demotion").value = tiers.ageDemotionEnabled === undefined ? "" : String(tiers.ageDemotionEnabled);
    el("s-warm-budget").value = tiers.warmMaxTokens === undefined ? "" : tiers.warmMaxTokens;
    el("s-warm-age").value = tiers.warmMaxAgeTurns === undefined ? "" : tiers.warmMaxAgeTurns;
    el("s-cold-catalog").value = tiers.catalogMaxTokens === undefined ? "" : tiers.catalogMaxTokens;
    el("s-retrieval-budget").value = tiers.retrievalMaxTokens === undefined ? "" : tiers.retrievalMaxTokens;
    el("s-retrieval-ttl").value = tiers.retrievalTtlTurns === undefined ? "" : tiers.retrievalTtlTurns;
    el("settings-json").value = JSON.stringify(settings, null, 2);
    el("effective-settings").textContent = JSON.stringify(state.snapshot.effectiveSettings || {}, null, 2);
  }

  function renderUsage() {
    const stats = state.snapshot.stats || {};
    const used = Number(stats.projectedTokens || 0);
    const limit = Number(stats.modelContextLimit || 0);
    const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    el("usage-bar").style.width = percent.toFixed(1) + "%";
    el("usage-text").textContent = compact(used) + " / " + compact(limit) + " tokens (" + percent.toFixed(0) + "%) - saved " +
      compact(stats.totalTokensSaved) + " this chat";
  }

  function renderTray() {
    const tray = el("tray");
    tray.hidden = state.staged.size === 0;
    el("tray-count").replaceChildren(node("b", state.staged.size), document.createTextNode(" staged edit" + (state.staged.size === 1 ? "" : "s")));
    el("tray-cost").textContent = "Saves as one revision and one rewrite of cached tokens; precise cost depends on the full projection.";
  }

  function render() {
    if (!state.snapshot) return;
    renderUsage();
    renderBlocks();
    renderMessages();
    renderSettings();
    renderTray();
    if (state.staged.size === 0) {
      setStatus(
        state.snapshot.pendingProjectionEdit
          ? "Saved - applies at your next message (revision " + state.snapshot.revision + ")"
          : "In sync - revision " + state.snapshot.revision,
        state.snapshot.pendingProjectionEdit ? "saved" : ""
      );
    }
  }

  // ── Actions ───────────────────────────────────────────────────
  function confirmChange(message) {
    return new Promise(resolve => {
      const dialog = el("confirm");
      el("confirm-text").textContent = message;
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
      dialog.showModal();
    });
  }
  async function openReplace(item) {
    const dialog = el("replace-dialog");
    const snapshot = state.snapshot;
    const epoch = state.epoch;
    el("replace-target").textContent = item.sourceId + " (" + item.role + ")";
    el("replace-text").value = "";
    try {
      const detail = await api(basePath() + "/messages/" + encodeURIComponent(item.id) + "?revision=" + snapshot.revision +
        "&generation=" + encodeURIComponent(snapshot.generation));
      if (epoch !== state.epoch || snapshot !== state.snapshot) return;
      el("replace-text").value = detail.override && detail.override.mode === "replace"
        ? detail.override.text : partsOf(detail.message).map(part => part.body).join("\\n\\n");
    } catch (error) { showError(error); return; }
    dialog.addEventListener("close", () => {
      const text = el("replace-text").value;
      el("replace-text").value = "";
      if (dialog.returnValue !== "confirm") return;
      if (!text.trim()) { showError(new Error("Replacement text is required")); return; }
      state.staged.set(item.sourceId, { mode: "replace", text: text });
      clearDetails();
      render();
    }, { once: true });
    dialog.showModal();
  }

  async function loadSession(sessionId) {
    clearDetails();
    if (el("replace-dialog").open) el("replace-dialog").close("cancel");
    el("replace-text").value = "";
    el("search-results").replaceChildren();
    state.snapshot = null;
    const epoch = state.epoch;
    const snapshot = await api("/api/sessions/" + encodeURIComponent(sessionId) + "?view=inventory");
    if (epoch !== state.epoch || el("session").value !== sessionId) return;
    state.snapshot = snapshot;
    state.staged.clear();
    render();
  }
  async function loadSessions() {
    const sessions = await api("/api/sessions");
    const select = el("session");
    select.replaceChildren();
    sessions.forEach(session => {
      const option = document.createElement("option");
      option.value = session.sessionId;
      option.textContent = (session.title || session.sessionId) + " - " + compact(session.tokenCount) + " tok";
      select.append(option);
    });
    if (!sessions.length) { setStatus("No chats recorded yet"); return; }
    const requested = new URLSearchParams(location.search).get("chat");
    const match = requested && sessions.some(session => session.sessionId === requested) ? requested : sessions[0].sessionId;
    select.value = match;
    await loadSession(match);
  }

  async function saveStaged() {
    const snapshot = state.snapshot;
    const epoch = state.epoch;
    const ok = await confirmChange(
      "Apply " + state.staged.size + " edit(s) to the next request? The batch rewrites the cached prefix once."
    );
    if (!ok || epoch !== state.epoch || state.snapshot !== snapshot) return;
    const edits = [];
    state.staged.forEach((override, messageId) => edits.push({ messageId: messageId, override: override }));
    try {
      setStatus("Saving...");
      const result = await api(basePath() + "/projection?view=inventory&generation=" + encodeURIComponent(snapshot.generation), {
        method: "POST",
        body: JSON.stringify({ revision: state.snapshot.revision, edits: edits }),
      });
      if (epoch !== state.epoch || state.snapshot !== snapshot) return;
      clearDetails();
      state.snapshot = result;
      state.staged.clear();
      render();
      setStatus("Saved - the next request uses this context, with your new message appended", "saved");
    } catch (error) {
      await handleMutationError(error, snapshot, new Map(state.staged));
    }
  }

  async function saveSettings(settings) {
    const snapshot = state.snapshot;
    const epoch = state.epoch;
    const ok = await confirmChange("Save these settings? They change how future context is pruned.");
    if (!ok || epoch !== state.epoch || state.snapshot !== snapshot) return;
    try {
      const result = await api(basePath() + "/settings?view=inventory&generation=" + encodeURIComponent(snapshot.generation), {
        method: "PATCH",
        body: JSON.stringify({ revision: state.snapshot.revision, settings: settings }),
      });
      if (epoch !== state.epoch || state.snapshot !== snapshot) return;
      clearDetails();
      state.snapshot = result;
      render();
      setStatus("Settings saved", "saved");
    } catch (error) {
      await handleMutationError(error, snapshot);
    }
  }

  async function blockAction(blockId, action, label) {
    const snapshot = state.snapshot;
    const epoch = state.epoch;
    const ok = await confirmChange(label + " for " + blockId + "? This changes the exact model context.");
    if (!ok || epoch !== state.epoch || state.snapshot !== snapshot) return;
    try {
      const result = await api(basePath() + "/blocks/" + encodeURIComponent(blockId) + "/actions?view=inventory&generation=" + encodeURIComponent(snapshot.generation), {
        method: "POST",
        body: JSON.stringify({ revision: state.snapshot.revision, action: action }),
      });
      if (epoch !== state.epoch || state.snapshot !== snapshot) return;
      clearDetails();
      state.snapshot = result;
      render();
      setStatus(label + " applied", "saved");
    } catch (error) {
      await handleMutationError(error, snapshot);
    }
  }

  function numberOrUndefined(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  function thresholdOrUndefined(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) return undefined;
    if (/%$/.test(trimmed)) return trimmed;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function collectSettings() {
    const base = JSON.parse(JSON.stringify(state.snapshot.settings || {}));
    ["profile", "recencyGuardTurns", "compressionRecencyRequests", "hardCap", "clearAtLeast"].forEach(key => { delete base[key]; });
    const nudges = Object.assign({}, base.nudges || {});
    delete nudges.maskTriggerThreshold;
    const costRoi = Object.assign({}, base.costRoi || {});
    delete costRoi.enabled;
    const nearDupe = Object.assign({}, base.nearDupe || {});
    delete nearDupe.enabled;
    const automation = Object.assign({}, base.automation || {});
    delete automation.automaticPruning;
    delete automation.modelCompression;
    const contextTiers = Object.assign({}, base.contextTiers || {});
    delete base.contextTiers;
    ["enabled", "warmBudgetMode", "ageDemotionEnabled", "warmMaxTokens", "warmMaxAgeTurns",
      "catalogMaxTokens", "retrievalMaxTokens", "retrievalTtlTurns"].forEach(key => { delete contextTiers[key]; });

    const profile = el("s-profile").value;
    if (profile) base.profile = profile;
    const recency = numberOrUndefined(el("s-recency").value);
    if (recency !== undefined) base.recencyGuardTurns = recency;
    const compressionRecency = numberOrUndefined(el("s-compression-recency").value);
    if (compressionRecency !== undefined) base.compressionRecencyRequests = compressionRecency;
    const hardCap = thresholdOrUndefined(el("s-hardcap").value);
    if (hardCap !== undefined) base.hardCap = hardCap;
    const clear = numberOrUndefined(el("s-clear").value);
    if (clear !== undefined) base.clearAtLeast = clear;
    const mask = thresholdOrUndefined(el("s-mask").value);
    if (mask !== undefined) nudges.maskTriggerThreshold = mask;
    const costRoiValue = el("s-costroi").value;
    if (costRoiValue) costRoi.enabled = costRoiValue === "true";
    const nearDupeValue = el("s-neardupe").value;
    if (nearDupeValue) nearDupe.enabled = nearDupeValue === "true";
    const autoPruneValue = el("s-autoprune").value;
    if (autoPruneValue) automation.automaticPruning = autoPruneValue === "true";
    const modelCompressionValue = el("s-model-compression").value;
    if (modelCompressionValue) automation.modelCompression = modelCompressionValue === "true";
    const tiersEnabled = el("s-context-tiers").value;
    if (tiersEnabled) contextTiers.enabled = tiersEnabled === "true";
    const warmBudgetMode = el("s-warm-budget-mode").value;
    if (warmBudgetMode) contextTiers.warmBudgetMode = warmBudgetMode;
    const ageDemotionEnabled = el("s-age-demotion").value;
    if (ageDemotionEnabled) contextTiers.ageDemotionEnabled = ageDemotionEnabled === "true";
    const warmBudget = thresholdOrUndefined(el("s-warm-budget").value);
    if (warmBudget !== undefined) contextTiers.warmMaxTokens = warmBudget;
    const warmAge = numberOrUndefined(el("s-warm-age").value);
    if (warmAge !== undefined) contextTiers.warmMaxAgeTurns = warmAge;
    const coldCatalog = thresholdOrUndefined(el("s-cold-catalog").value);
    if (coldCatalog !== undefined) contextTiers.catalogMaxTokens = coldCatalog;
    const retrievalBudget = thresholdOrUndefined(el("s-retrieval-budget").value);
    if (retrievalBudget !== undefined) contextTiers.retrievalMaxTokens = retrievalBudget;
    const retrievalTtl = numberOrUndefined(el("s-retrieval-ttl").value);
    if (retrievalTtl !== undefined) contextTiers.retrievalTtlTurns = retrievalTtl;
    if (Object.keys(contextTiers).length) base.contextTiers = contextTiers;

    if (Object.keys(nudges).length) base.nudges = nudges; else delete base.nudges;
    if (Object.keys(costRoi).length) base.costRoi = costRoi; else delete base.costRoi;
    if (Object.keys(nearDupe).length) base.nearDupe = nearDupe; else delete base.nearDupe;
    if (Object.keys(automation).length) base.automation = automation; else delete base.automation;
    return base;
  }

  async function bootstrapFromFragment() {
    const match = /^#token=([A-Fa-f0-9]+)$/.exec(location.hash);
    if (!match) return;
    const response = await fetch("/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: match[1] }),
    });
    history.replaceState(null, "", location.pathname + location.search);
    if (!response.ok) throw new Error("Dashboard authentication failed");
  }

  el("session").addEventListener("change", event => loadSession(event.target.value).catch(showError));
  el("tray-save").addEventListener("click", () => saveStaged());
  el("tray-discard").addEventListener("click", () => { state.staged.clear(); clearDetails(); render(); });
  el("settings-form").addEventListener("submit", event => { event.preventDefault(); saveSettings(collectSettings()); });
  el("settings-json-form").addEventListener("submit", event => {
    event.preventDefault();
    try { saveSettings(JSON.parse(el("settings-json").value)); } catch (error) { showError(new Error("Overrides JSON is invalid")); }
  });
  el("search-form").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const data = await api("/api/sessions/" + encodeURIComponent(state.snapshot.sessionId) +
        "/archive/search?q=" + encodeURIComponent(el("archive-query").value));
      const target = el("search-results");
      target.replaceChildren();
      const items = data.items || [];
      if (!items.length) { target.append(node("div", "No archived content matched", "empty")); return; }
      items.forEach(item => {
        const card = node("article", null, "row out");
        const head = node("div", null, "row-head");
        head.append(node("strong", item.title || item.blockId));
        if (item.metadata && item.metadata.kind) head.append(node("span", item.metadata.kind, "tag"));
        card.append(head);
        card.append(node("pre", item.snippet || ""));
        target.append(card);
      });
    } catch (error) {
      showError(error);
    }
  });

  bootstrapFromFragment().then(loadSessions).catch(showError);
})();
</script>
</body>
</html>`;
//# sourceMappingURL=control-ui.js.map