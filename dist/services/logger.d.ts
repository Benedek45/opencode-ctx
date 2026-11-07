/** Log level. */
export type LogLevel = "debug" | "info" | "warn" | "error";
/** Logger service interface. */
export interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
/** No-op logger (silent). */
export declare class NoopLogger implements Logger {
    debug(_message: string, ..._args: unknown[]): void;
    info(_message: string, ..._args: unknown[]): void;
    warn(_message: string, ..._args: unknown[]): void;
    error(_message: string, ..._args: unknown[]): void;
}
/** Console logger. */
export declare class ConsoleLogger implements Logger {
    private readonly prefix;
    constructor(prefix?: string);
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
/** Capturing logger for tests. */
export declare class CapturingLogger implements Logger {
    readonly entries: Array<{
        level: LogLevel;
        message: string;
        args: unknown[];
    }>;
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    clear(): void;
}
/** Singleton no-op logger. */
export declare const noopLogger: Logger;
//# sourceMappingURL=logger.d.ts.map