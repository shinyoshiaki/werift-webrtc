import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("browser logger runtime", () => {
  test("loads without process and reads localStorage.debug", async () => {
    // Arrange
    vi.stubGlobal("process", undefined);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "debug" ? "werift:browser" : null),
    });
    const consoleDebug = vi
      .spyOn(console, "debug")
      .mockImplementation(() => {});

    // Act: process がない環境で読み込み、logger を呼ぶ
    // hoist-imports-allow: load the logger after stubbing the browser globals
    const { debug } = await import("../src/log");
    const logger = debug("werift:browser");
    logger("message %s", "value");

    // Assert: localStorage.debug で有効になり、console.debug に namespace 付きで出力する
    expect(logger.enabled).toBe(true);
    expect(consoleDebug).toHaveBeenCalledWith(
      "werift:browser message %s",
      "value",
    );
  });

  test("does not throw when localStorage is unavailable", async () => {
    // Arrange
    vi.stubGlobal("process", undefined);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage blocked");
      },
    });

    // Act: localStorage が例外を投げる環境で読み込む
    // hoist-imports-allow: load the logger after stubbing the browser globals
    const { debug } = await import("../src/log");

    // Assert: 読み込みも logger の生成も失敗しない
    expect(debug("werift:browser")).toBeTypeOf("function");
  });
});
