import { describe, expect, it } from "vitest";
import { checkAndConsume, pruneExpired } from "../src/security/rateLimit.mjs";

describe("checkAndConsume", () => {
  it("allows up to max attempts within the window", () => {
    const key = `test-${Math.random()}`;
    expect(checkAndConsume(key, { max: 3, windowMs: 60000 })).toBe(true);
    expect(checkAndConsume(key, { max: 3, windowMs: 60000 })).toBe(true);
    expect(checkAndConsume(key, { max: 3, windowMs: 60000 })).toBe(true);
  });

  it("blocks once max is exceeded within the window", () => {
    const key = `test-${Math.random()}`;
    checkAndConsume(key, { max: 2, windowMs: 60000 });
    checkAndConsume(key, { max: 2, windowMs: 60000 });
    expect(checkAndConsume(key, { max: 2, windowMs: 60000 })).toBe(false);
  });

  it("tracks distinct keys independently", () => {
    const keyA = `a-${Math.random()}`;
    const keyB = `b-${Math.random()}`;
    checkAndConsume(keyA, { max: 1, windowMs: 60000 });
    expect(checkAndConsume(keyA, { max: 1, windowMs: 60000 })).toBe(false);
    expect(checkAndConsume(keyB, { max: 1, windowMs: 60000 })).toBe(true);
  });

  it("allows again once the window has passed", () => {
    const key = `test-${Math.random()}`;
    expect(checkAndConsume(key, { max: 1, windowMs: 50 })).toBe(true);
    expect(checkAndConsume(key, { max: 1, windowMs: 50 })).toBe(false);

    return new Promise((resolve) => {
      setTimeout(() => {
        expect(checkAndConsume(key, { max: 1, windowMs: 50 })).toBe(true);
        resolve();
      }, 100);
    });
  });
});

describe("pruneExpired", () => {
  it("does not throw when called on an empty or populated store", () => {
    checkAndConsume(`prune-${Math.random()}`, { max: 5, windowMs: 60000 });
    expect(() => pruneExpired(60000)).not.toThrow();
  });
});
