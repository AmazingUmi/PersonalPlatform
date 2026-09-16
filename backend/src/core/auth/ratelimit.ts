/**
 * Per-process sliding-window limiter for the login endpoint (AUTH-1 §20):
 * small, in-memory, documented limitation — it bounds brute-force per
 * backend process, which is the deployment shape of this platform.
 */
const MAX_FAILURES = 10;
const WINDOW_MS = 5 * 60 * 1000;

interface Window {
  failures: number;
  resetAt: number;
}

export class LoginRateLimiter {
  private readonly windows = new Map<string, Window>();

  /** False when the key is currently blocked. */
  isBlocked(key: string, now: Date): boolean {
    const window = this.windows.get(key);
    if (!window) return false;
    if (now.getTime() >= window.resetAt) {
      this.windows.delete(key);
      return false;
    }
    return window.failures >= MAX_FAILURES;
  }

  recordFailure(key: string, now: Date): void {
    const time = now.getTime();
    const window = this.windows.get(key);
    if (!window || time >= window.resetAt) {
      this.windows.set(key, { failures: 1, resetAt: time + WINDOW_MS });
      return;
    }
    window.failures += 1;
  }

  /** A successful login clears the key's window. */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /** Drop expired windows (opportunistic — the map stays tiny either way). */
  prune(now: Date): void {
    const time = now.getTime();
    for (const [key, window] of this.windows) {
      if (time >= window.resetAt) this.windows.delete(key);
    }
  }
}
