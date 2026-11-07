// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Logger service interface + implementations.
/** No-op logger (silent). */
export class NoopLogger {
    debug(_message, ..._args) { }
    info(_message, ..._args) { }
    warn(_message, ..._args) { }
    error(_message, ..._args) { }
}
/** Console logger. */
export class ConsoleLogger {
    prefix;
    constructor(prefix = "[context-manager]") {
        this.prefix = prefix;
    }
    debug(message, ...args) {
        console.debug(`${this.prefix} DEBUG ${message}`, ...args);
    }
    info(message, ...args) {
        console.info(`${this.prefix} INFO ${message}`, ...args);
    }
    warn(message, ...args) {
        console.warn(`${this.prefix} WARN ${message}`, ...args);
    }
    error(message, ...args) {
        console.error(`${this.prefix} ERROR ${message}`, ...args);
    }
}
/** Capturing logger for tests. */
export class CapturingLogger {
    entries = [];
    debug(message, ...args) {
        this.entries.push({ level: "debug", message, args });
    }
    info(message, ...args) {
        this.entries.push({ level: "info", message, args });
    }
    warn(message, ...args) {
        this.entries.push({ level: "warn", message, args });
    }
    error(message, ...args) {
        this.entries.push({ level: "error", message, args });
    }
    clear() {
        this.entries.length = 0;
    }
}
/** Singleton no-op logger. */
export const noopLogger = new NoopLogger();
//# sourceMappingURL=logger.js.map