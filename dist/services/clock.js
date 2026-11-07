// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Clock service interface + implementations.
/** Real wall-clock implementation. */
export class WallClock {
    now() {
        return Date.now();
    }
}
/** Fake clock for deterministic tests. */
export class FakeClock {
    _now;
    constructor(initialMs = 0) {
        this._now = initialMs;
    }
    now() {
        return this._now;
    }
    /** Advance the clock by the given number of milliseconds. */
    advance(ms) {
        this._now += ms;
    }
    /** Set the clock to an absolute value. */
    set(ms) {
        this._now = ms;
    }
}
/** Singleton real clock. */
export const wallClock = new WallClock();
//# sourceMappingURL=clock.js.map