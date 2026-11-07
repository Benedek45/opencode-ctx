// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Logger service interface + implementations.

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
export class NoopLogger implements Logger {
  debug(_message: string, ..._args: unknown[]): void {}
  info(_message: string, ..._args: unknown[]): void {}
  warn(_message: string, ..._args: unknown[]): void {}
  error(_message: string, ..._args: unknown[]): void {}
}

/** Console logger. */
export class ConsoleLogger implements Logger {
  constructor(private readonly prefix = "[context-manager]") {}

  debug(message: string, ...args: unknown[]): void {
    console.debug(`${this.prefix} DEBUG ${message}`, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    console.info(`${this.prefix} INFO ${message}`, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(`${this.prefix} WARN ${message}`, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(`${this.prefix} ERROR ${message}`, ...args);
  }
}

/** Capturing logger for tests. */
export class CapturingLogger implements Logger {
  readonly entries: Array<{ level: LogLevel; message: string; args: unknown[] }> = [];

  debug(message: string, ...args: unknown[]): void {
    this.entries.push({ level: "debug", message, args });
  }

  info(message: string, ...args: unknown[]): void {
    this.entries.push({ level: "info", message, args });
  }

  warn(message: string, ...args: unknown[]): void {
    this.entries.push({ level: "warn", message, args });
  }

  error(message: string, ...args: unknown[]): void {
    this.entries.push({ level: "error", message, args });
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/** Singleton no-op logger. */
export const noopLogger: Logger = new NoopLogger();
