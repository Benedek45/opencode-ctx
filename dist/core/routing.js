// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Pure pre-tool output-risk classifier. No I/O, no host types.
// Consumes neutral tool name + args; returns allow / advise / deny.
// ── Classifier ─────────────────────────────────────────────────────────────
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
export function classifyTool(tool, args) {
    const t = tool.trim().toLowerCase();
    // ── 1. External MCP tools ────────────────────────────────────────────────
    if (t.includes(".") || t.includes("/")) {
        return {
            outcome: "advise",
            risk: 0.6,
            reason: `external MCP tool "${tool}" — output volume is unknown`,
            suggestedAlternative: "use a bounded built-in tool when possible",
        };
    }
    // ── 2. WebFetch-like tools ──────────────────────────────────────────────
    const FETCH_LIKE = new Set(["webfetch", "web_fetch", "web-fetch", "web_search", "web-search", "fetch"]);
    if (FETCH_LIKE.has(t) || t.startsWith("webfetch") || t.startsWith("web_fetch")) {
        return {
            outcome: "deny",
            risk: 0.95,
            reason: `${tool} streams unbounded remote content to stdout — use curl -o <file> for silent download`,
            suggestedAlternative: "use bash with curl -o <file> or wget -O <file>",
        };
    }
    // ── 3. Known bounded tools ──────────────────────────────────────────────
    if (t === "glob" || t === "write" || t === "edit" || t === "applydiff") {
        return {
            outcome: "allow",
            risk: 0.05,
            reason: `${tool} produces structurally bounded output`,
        };
    }
    // ── 4. Read tool ────────────────────────────────────────────────────────
    if (t === "read" || t === "readfile") {
        return classifyRead(args);
    }
    // ── 5. Bash / shell ─────────────────────────────────────────────────────
    if (t === "bash" || t === "shell" || t === "execute_command" || t === "command") {
        return classifyShellCommand(args);
    }
    // ── 6. Grep / ripgrep ──────────────────────────────────────────────────
    if (t === "grep" || t === "ripgrep" || t === "rg") {
        return classifyGrep(args);
    }
    // ── 7. Unknown tool ────────────────────────────────────────────────────
    return {
        outcome: "advise",
        risk: 0.5,
        reason: `unrecognised tool "${tool}" — output volume is unknown; treat conservatively`,
    };
}
// ── Read classification ────────────────────────────────────────────────────
function classifyRead(args) {
    const a = asRecord(args);
    const limit = a.limit ?? a.maxResults ?? a.maxBytes ?? a.count;
    if (limit !== undefined) {
        const n = Number(limit);
        if (!isNaN(n) && n > 0 && n <= 100_000) {
            return {
                outcome: "allow",
                risk: 0.1,
                reason: `read with explicit byte/line limit (${n})`,
            };
        }
    }
    return {
        outcome: "advise",
        risk: 0.45,
        reason: "read without explicit limit may return large content — add limit=N parameter",
        suggestedAlternative: "add limit=<bytes> to cap output",
    };
}
// ── Shell command classification ───────────────────────────────────────────
/** Commands whose output is structurally small / bounded by nature. */
const BOUNDED_COMMANDS = new Set([
    "ls", "pwd", "echo", "date", "stat", "wc", "whoami", "id", "uname", "hostname",
    "type", "which", "command", "true", "false",
]);
/** Commands that are bounded when used without recursive flags. */
const CONDITIONALLY_BOUNDED = new Set([
    "du", "df", "ps", "env", "printenv", "alias", "history",
]);
function classifyShellCommand(args) {
    const a = asRecord(args);
    const commandRaw = (a.command ?? a.cmd ?? a.script);
    if (commandRaw === undefined || commandRaw === null || typeof commandRaw !== "string") {
        return {
            outcome: "advise",
            risk: 0.5,
            reason: "shell command with unrecognisable args — output volume unknown",
        };
    }
    const command = commandRaw.trim();
    if (!command) {
        return { outcome: "allow", risk: 0, reason: "empty command" };
    }
    // Extract the base command (first word, ignoring leading env vars)
    const cmd = extractBaseCommand(command);
    // ── Deny: curl/wget to stdout ──────────────────────────────────────────
    if (cmd === "curl") {
        return classifyCurl(command, commandRaw);
    }
    if (cmd === "wget") {
        return classifyWget(command, commandRaw);
    }
    // ── Deny: cat with no file ─────────────────────────────────────────────
    if (cmd === "cat") {
        return classifyCat(command, commandRaw);
    }
    // ── Deny: dd without count (unbounded read) ────────────────────────────
    if (cmd === "dd") {
        if (!/\bcount=\d+/i.test(command)) {
            return {
                outcome: "deny",
                risk: 0.85,
                reason: "dd without count= argument may read unbounded input",
                suggestedAlternative: "add count=<N> to limit the read",
            };
        }
        return { outcome: "allow", risk: 0.1, reason: "dd with explicit count=N" };
    }
    // ── Deny: yes (unbounded stdout flood) ─────────────────────────────────
    if (cmd === "yes") {
        return {
            outcome: "deny",
            risk: 0.95,
            reason: "yes floods stdout indefinitely",
            suggestedAlternative: "use echo or printf with explicit content",
        };
    }
    // ── Allow: structurally bounded commands ────────────────────────────────
    if (BOUNDED_COMMANDS.has(cmd)) {
        return { outcome: "allow", risk: 0.05, reason: `bounded command: ${cmd}` };
    }
    // ── Conditionally bounded ─────────────────────────────────────────────
    if (CONDITIONALLY_BOUNDED.has(cmd)) {
        // These are usually safe without -R or recursive flags
        return { outcome: "allow", risk: 0.15, reason: `bounded command: ${cmd}` };
    }
    // ── head / tail with explicit -n ────────────────────────────────────────
    if (cmd === "head" || cmd === "tail") {
        if (/\s-n\s+\d+\b/.test(command) || /\s-n\d+\b/.test(command)) {
            return { outcome: "allow", risk: 0.1, reason: `${cmd} with explicit -n N` };
        }
        return {
            outcome: "advise",
            risk: 0.4,
            reason: `${cmd} without -n may output unbounded lines`,
            suggestedAlternative: `add -n <count> to ${cmd} to cap lines`,
        };
    }
    // ── find / locate ─────────────────────────────────────────────────────
    if (cmd === "find" || cmd === "locate" || cmd === "mlocate") {
        return {
            outcome: "advise",
            risk: 0.5,
            reason: `${cmd} may traverse a large tree — structure is unbounded`,
            suggestedAlternative: "use glob with a restrictive pattern instead",
        };
    }
    // ── git safe commands ─────────────────────────────────────────────────
    if (cmd === "git") {
        return classifyGit(command, commandRaw);
    }
    // ── Empty command ────────────────────────────────────────────────────
    if (!cmd) {
        return { outcome: "allow", risk: 0, reason: "empty command" };
    }
    // ── awk / sed / perl / jq (stream processors) ─────────────────────────
    if (["awk", "sed", "perl", "jq", "python", "ruby", "node"].includes(cmd)) {
        return {
            outcome: "advise",
            risk: 0.4,
            reason: `${cmd} may process unbounded input — output volume depends on data`,
            suggestedAlternative: "add explicit input bounds (head -n, etc.)",
        };
    }
    // ── make / npm / pip / cargo (build commands) ─────────────────────────
    if (["make", "npm", "npx", "pip", "pip3", "cargo", "go", "deno", "bun"].includes(cmd)) {
        return {
            outcome: "advise",
            risk: 0.35,
            reason: `${cmd} may produce large build logs — output is unpredictable`,
            suggestedAlternative: "use --quiet or redirect to a file with > output.log",
        };
    }
    // ── curl piped or redirected ──────────────────────────────────────────
    // (Safe piped curl: curl URL | something)
    // We already classify bare curl as deny above, so this handles curl with pipes
    // that might have escaped the base-command extraction — handled by classifyCurl.
    // ── Unknown command — conservative advise ──────────────────────────────
    return {
        outcome: "advise",
        risk: 0.5,
        reason: `shell command "${cmd}" — output volume unknown; treat conservatively`,
    };
}
// ── curl ────────────────────────────────────────────────────────────────────
function classifyCurl(command, _raw) {
    // curl -o <file> or -O (remote filename) or --output → file download
    if (/-(?:o|O|output)\s/.test(command)) {
        return {
            outcome: "allow",
            risk: 0.1,
            reason: "curl with file-output flag (-o/-O) writes to file, not stdout",
        };
    }
    // Deny if it looks like a remote URL fetch to stdout
    if (/https?:\/\//i.test(command) || /ftp:\/\//i.test(command)) {
        return {
            outcome: "deny",
            risk: 0.9,
            reason: "curl fetches remote content to stdout — use -o <file> for silent download",
            suggestedAlternative: "add -o <filename> to write to file, or use wget -O <file>",
        };
    }
    // curl without -o/-O but may be doing something else
    return {
        outcome: "advise",
        risk: 0.5,
        reason: "curl — uncertain if output goes to stdout",
    };
}
// ── wget ────────────────────────────────────────────────────────────────────
function classifyWget(command, _raw) {
    // wget -O <file> → file download
    if (/-(?:O|output-document)\s/.test(command)) {
        return {
            outcome: "allow",
            risk: 0.1,
            reason: "wget with -O flag writes to file, not stdout",
        };
    }
    if (/https?:\/\//i.test(command) || /ftp:\/\//i.test(command)) {
        return {
            outcome: "deny",
            risk: 0.9,
            reason: "wget fetches remote content to stdout — use -O <file> for silent download",
            suggestedAlternative: "add -O <filename> to write to file",
        };
    }
    return {
        outcome: "advise",
        risk: 0.5,
        reason: "wget — uncertain if output goes to stdout",
    };
}
// ── cat ─────────────────────────────────────────────────────────────────────
function classifyCat(command, _raw) {
    // cat with no file arguments = stdin echo (will flood with piped input)
    const args = command.split(/\s+/).slice(1).filter(a => !a.startsWith("-"));
    if (args.length === 0) {
        return {
            outcome: "deny",
            risk: 0.85,
            reason: "cat without file arguments echoes stdin, which can flood",
            suggestedAlternative: "specify a file path, or use head/tail with -n",
        };
    }
    return {
        outcome: "allow",
        risk: 0.1,
        reason: "cat with explicit file argument(s)",
    };
}
// ── git ─────────────────────────────────────────────────────────────────────
const SAFE_GIT_SUBCOMMANDS = new Set([
    "status", "branch", "diff", "diffstat", "diff --stat", "log", "show",
    "rev-parse", "rev-list", "describe", "tag", "stash list", "reflog",
]);
function classifyGit(command, _raw) {
    // Extract subcommand (e.g. "git status" → "status")
    const tokens = command.split(/\s+/);
    const idx = tokens.findIndex(t => t === "git");
    if (idx < 0 || idx + 1 >= tokens.length) {
        return { outcome: "advise", risk: 0.4, reason: "git — subcommand unclear" };
    }
    const sub = tokens[idx + 1].toLowerCase();
    if (SAFE_GIT_SUBCOMMANDS.has(sub)) {
        return { outcome: "allow", risk: 0.1, reason: `git ${sub} — structurally bounded` };
    }
    // git log with -<N> is bounded
    if (sub === "log" && tokens.some(t => /^-\d+$/.test(t))) {
        return { outcome: "allow", risk: 0.1, reason: "git log with explicit count cap" };
    }
    if (sub === "diff" || sub === "show") {
        // Individual file diffs are usually bounded
        return { outcome: "allow", risk: 0.15, reason: `git ${sub}` };
    }
    if (["clone", "fetch", "pull", "push"].includes(sub)) {
        return {
            outcome: "advise",
            risk: 0.4,
            reason: `git ${sub} may produce large output or network overhead`,
        };
    }
    return {
        outcome: "advise",
        risk: 0.5,
        reason: `git ${sub} — output volume unknown`,
    };
}
// ── Grep / ripgrep ─────────────────────────────────────────────────────────
function classifyGrep(args) {
    const a = asRecord(args);
    const pattern = (a.pattern ?? a.regex ?? a.query);
    const path = (a.path ?? a.dir ?? a.files);
    const isRecursive = a.recursive === true || a.r === true || a.R === true;
    if (isRecursive) {
        return {
            outcome: "advise",
            risk: 0.5,
            reason: `recursive grep — unbounded tree scan may produce large output`,
            suggestedAlternative: "scope grep to a specific file with path=<file>",
        };
    }
    // Single-file grep is bounded
    if (path && typeof path === "string" && !path.includes("*")) {
        return { outcome: "allow", risk: 0.15, reason: "grep on a single file" };
    }
    if (path && typeof path === "string" && path.includes("*")) {
        return {
            outcome: "advise",
            risk: 0.4,
            reason: "grep with glob pattern may match many files",
            suggestedAlternative: "grep a single explicit file instead",
        };
    }
    return { outcome: "allow", risk: 0.15, reason: "grep on explicit path" };
}
// ── Helpers ─────────────────────────────────────────────────────────────────
function asRecord(v) {
    if (v && typeof v === "object" && !Array.isArray(v))
        return v;
    if (typeof v === "string")
        return { command: v };
    return {};
}
/** Extract the base command name from a shell command string. */
function extractBaseCommand(command) {
    // Strip leading env variables: FOO=bar cmd ...
    let s = command.trim();
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) {
        const eq = s.indexOf("=");
        const next = s.indexOf(" ", eq);
        if (next < 0)
            return "";
        s = s.slice(next + 1).trim();
    }
    // Strip leading sudo / timeout / nice / nohup
    const WRAPPERS = new Set(["sudo", "timeout", "nice", "nohup", "npx", "bunx"]);
    while (true) {
        const first = s.split(/\s+/)[0].toLowerCase();
        if (WRAPPERS.has(first)) {
            let rest = s.slice(first.length).trim();
            if (!rest)
                return "";
            // timeout <duration> <cmd>; nice -<prio> <cmd>
            if (first === "timeout" || first === "nice") {
                const maybeNum = rest.split(/\s+/)[0];
                if (/^-\d/.test(maybeNum) || /^\d+$/.test(maybeNum)) {
                    rest = rest.slice(maybeNum.length).trim();
                }
            }
            s = rest;
        }
        else
            break;
    }
    // Strip leading path if present
    const firstToken = s.split(/\s+/)[0];
    const cmd = firstToken.includes("/") ? firstToken.split("/").pop() : firstToken;
    return cmd.toLowerCase();
}
//# sourceMappingURL=routing.js.map