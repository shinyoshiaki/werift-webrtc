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
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => {});

    // Act
    const { debug } = await import("../src/log");
    const logger = debug("werift:browser");
    logger("message %s", "value");

    // Assert
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

    // Act
    const { debug } = await import("../src/log");

    // Assert
    expect(debug("werift:browser")).toBeTypeOf("function");
  });
});
