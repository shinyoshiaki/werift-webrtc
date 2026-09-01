import { describe, expect, it } from "vitest";

import {
  SPED_BINDING_RESPONSE_CACHE_MAX,
  SpedBindingResponseCache,
} from "../../src/internal/sped-binding-cache";

describe("SpedBindingResponseCache", () => {
  it("TTL 経過後は同一 transaction でも取れない", () => {
    // Arrange
    const cache = new SpedBindingResponseCache();
    const bytes = Buffer.from([1, 2, 3]);

    // Act
    cache.set("tx", bytes, 100, 1_000);

    // Assert
    expect(cache.get("tx", 1_050)?.equals(bytes)).toBe(true);
    expect(cache.get("tx", 1_100)).toBeUndefined();
    expect(cache.get("tx", 1_200)).toBeUndefined();
  });

  it("件数上限を超えると最も古いエントリを落とす", () => {
    // Arrange
    const cache = new SpedBindingResponseCache();
    const ttl = 60_000;
    const now = Date.now();

    // Act
    for (let i = 0; i < SPED_BINDING_RESPONSE_CACHE_MAX + 1; i++) {
      cache.set(`tx-${i}`, Buffer.from([i]), ttl, now);
    }

    // Assert
    expect(cache.size).toBe(SPED_BINDING_RESPONSE_CACHE_MAX);
    expect(cache.get("tx-0", now)).toBeUndefined();
    expect(cache.get("tx-1", now)).toBeDefined();
  });

  it("in-flight は transaction ごとに共有 Promise で完了する", async () => {
    // Arrange
    const cache = new SpedBindingResponseCache();
    const { promise, finish } = cache.begin("tx");
    const bytes = Buffer.from([9]);

    // Act
    const waiter = cache.getInFlight("tx");
    finish(bytes);
    const got = await waiter;

    // Assert
    expect(waiter).toBe(promise);
    expect(got?.equals(bytes)).toBe(true);
    expect(cache.getInFlight("tx")).toBeUndefined();
  });

  it("abortInFlight は待ち側を undefined で解放する", async () => {
    // Arrange
    const cache = new SpedBindingResponseCache();
    const { promise } = cache.begin("tx");

    // Act
    cache.abortInFlight();

    // Assert
    expect(await promise).toBeUndefined();
    expect(cache.getInFlight("tx")).toBeUndefined();
  });
});
