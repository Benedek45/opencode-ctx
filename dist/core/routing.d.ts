export type ToolRiskOutcome = "allow" | "advise" | "deny";
export interface ToolRiskResult {
    outcome: ToolRiskOutcome;
    /** 0 (safe) — 1 (certain flood). */
    risk: number;
    /** Human-readable explanation. */
    reason: string;
    /** Optional suggested alternative tool or command. */
    suggestedAlternative?: string;
}
/**
 * Classify a tool call before execution.
 *
 * Rules (conservative — when in doubt, ADVISE rather than ALLOW but only DENY
 * for clear stdout-flood cases):
 *
 *  DENY   — WebFetch-like tools that stream URL content to stdout;
 *           curl / wget without a file-output flag;
 *           `cat` with no arguments (stdin echo mode).
 *
 *  ALLOW  — `ls`, `pwd`, `echo`, `date`, `stat`, `wc`, `whoami`, `id`,
 *           `uname`, `hostname`, `df`, `du -s`;
 *           `head`/`tail` with explicit `-n`;
 *           `cat <file>` with a known file argument;
 *           `curl -o <file>` / `wget -O <file>`;
 *           `git status`, `git diff --stat`, `git log --oneline -<N>`;
 *           `read` with explicit `limit` or `maxResults`;
 *           `glob` / `write` / `edit` tools.
 *
 *  ADVISE — `read` without limit;
 *           `grep` / `ripgrep` with recursive flag;
 *           `bash` / `shell` that runs an unbounded or unrecognised command;
 *           external MCP tools (name contains `.`);
 *           unknown / unrecognised tools.
 */
export declare function classifyTool(tool: string, args: unknown): ToolRiskResult;
//# sourceMappingURL=routing.d.ts.map