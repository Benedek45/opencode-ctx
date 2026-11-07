#!/usr/bin/env node
export declare const HELP = "Offline DCP v3 migration (Node >=22.13; quit OpenCode first).\nnode dist/migration/cli.js [--apply | --dry-run] [--data-home DIR]\n  --storage DIR       target plugin storage (same defaults as the plugin)\n  --database FILE     source database (default DATA_HOME/opencode/opencode.db)\n  --allow-incomplete-sources  preserve summaries without recoverable originals\n  --allow-running-opencode   explicit unsafe override (isolated copies recommended)\nDry-run is default and writes NOTHING; JSON report goes to stdout.\nApply backs up target trees first; report also saved inside the backup directory.\nNo source sidecars, host database, or OpenCode configuration are written.";
/** Fail closed when process enumeration fails. Known non-writers are excluded. */
export declare function parseProcesses(text: string, selfPid?: number): string[];
export interface MigrationReport {
    dryRun: boolean;
    backup?: string;
    sessions: Array<{
        sessionId: string;
        status: "ready" | "imported" | "already-imported" | "skipped";
        reason?: string;
        schema?: string;
        blocks?: number;
        incompleteSourceBlocks?: number;
        archivedSources?: number;
        archivedSummaries?: number;
    }>;
}
export declare function migrate(argv: string[], dependencies?: {
    processes?: () => string;
}): Promise<MigrationReport>;
//# sourceMappingURL=cli.d.ts.map