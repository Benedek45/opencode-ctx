// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Clock service interface + implementations.

/** Clock service interface. Core uses this instead of Date.now() directly. */
export interface Clock {
  /** Returns the current time as Unix milliseconds. */
  now(): number;
}

/** Real wall-clock implementation. */
export class WallClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** Fake clock for deterministic tests. */
export class FakeClock implements Clock {
  private _now: number;

  constructor(initialMs = 0) {
    this._now = initialMs;
  }

  now(): number {
    return this._now;
  }

  /** Advance the clock by the given number of milliseconds. */
  advance(ms: number): void {
    this._now += ms;
  }

  /** Set the clock to an absolute value. */
  set(ms: number): void {
    this._now = ms;
  }
}

/** Singleton real clock. */
export const wallClock: Clock = new WallClock();
