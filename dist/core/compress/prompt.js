// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Compress prompt builder: structured 7-section prompt for model-driven summarization.
/** The 7-section structured compress prompt template. */
const COMPRESS_PROMPT_TEMPLATE = `You are summarizing a section of a conversation for context management.
Produce a dense, high-fidelity technical summary using the following 7-section structure.
Omit sections that have no content. Be exhaustive — this summary replaces the original.

## 1. Goal & Framework
What task is being worked on? What is the overall approach?

## 2. Decisions
Key decisions made, constraints discovered, approaches chosen or rejected.

## 3. Artifacts
Files created/modified, code written, commands run, outputs produced.
Include file paths, function signatures, key values.

## 4. Figures & Source Attributions
All numerical figures, metrics, measurements. Attribute each to its source document.

## 5. Open [DATA NEEDED] Items
Any [DATA NEEDED: ...] placeholders or missing information identified.

## 6. Open Questions
Unresolved questions, ambiguities, items requiring follow-up.

## 7. Next Steps
What should happen next? What is the current state of work?

---
IMPORTANT: Never fabricate data. If a figure is uncertain, mark it [UNCERTAIN].
Preserve all [DATA NEEDED: ...] placeholders exactly as written.
`;
/**
 * Build the compress prompt for a range of messages.
 * Returns the system prompt and the user message content.
 */
export function buildCompressPrompt(messages, topic) {
    const topicLine = topic ? `Topic: ${topic}\n\n` : "";
    const conversationText = messages
        .filter(m => !m.isIgnored)
        .map(m => {
        const roleLabel = m.role.toUpperCase();
        const text = m.parts
            .map(p => {
            if (p.type === "text")
                return p.text;
            if (p.type === "reasoning")
                return `[REASONING: ${p.text}]`;
            if (p.type === "tool") {
                const inputStr = typeof p.input === "string" ? p.input : JSON.stringify(p.input);
                return `[TOOL: ${p.tool}]\nInput: ${inputStr}\nOutput: ${p.output ?? "(none)"}`;
            }
            if (p.type === "summary-block")
                return `[SUMMARY BLOCK ${p.blockId}]\n${p.text}`;
            return "";
        })
            .filter(Boolean)
            .join("\n");
        return `${roleLabel}:\n${text}`;
    })
        .join("\n\n---\n\n");
    return {
        system: COMPRESS_PROMPT_TEMPLATE,
        userContent: `${topicLine}Please summarize the following conversation section:\n\n${conversationText}`,
    };
}
//# sourceMappingURL=prompt.js.map