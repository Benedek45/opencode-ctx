import type { NeutralMessage } from "../../types/neutral.js";
/**
 * Build the compress prompt for a range of messages.
 * Returns the system prompt and the user message content.
 */
export declare function buildCompressPrompt(messages: NeutralMessage[], topic?: string): {
    system: string;
    userContent: string;
};
//# sourceMappingURL=prompt.d.ts.map