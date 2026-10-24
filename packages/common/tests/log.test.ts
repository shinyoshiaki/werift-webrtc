import { afterEach, describe, expect, test } from "vitest";
import { debug } from "../src/log";
import { createDebugOutput, setStderrIsTTYForTest } from "./logUtils";

let restoreTTY: (() => void) | undefined;

describe("debug logger", () => {
  afterEach(() => {
    debug.disable();
    restoreTTY?.();
    restoreTTY = undefined;
    process.env.DEBUG_COLORS = "";
    delete process.env.DEBUG_COLORS;
    delete process.env.NO_COLOR;
  });

  test("matches patterns and prioritizes exclusions", () => {
    // Arrange
    const output = createDebugOutput();
    const included = debug("werift:ice");
    const excluded = debug("werift:ice:secret");

    // Act
    debug.enable("werift*,other exact,-werift:ice:secret");
    included("included");
    excluded("excluded");

    // Assert
    expect(included.enabled).toBe(true);
    expect(excluded.enabled).toBe(false);
    expect(output.messages).toHaveLength(1);
    output.restore();
  });

  test("supports runtime toggles and formats arguments", () => {
    // Arrange
    const output = createDebugOutput();
    const logger = debug("werift:test");
    debug.enable("werift:test");

    // Act
    logger("value=%s count=%d json=%j percent=%%", "ok", 3, { a: 1 });
    const previous = debug.disable();
    logger("hidden");

    // Assert
    expect(previous).toBe("werift:test");
    expect(logger.enabled).toBe(false);
    expect(output.messages[0][0]).toContain(
      "value=%s count=%d json=%j percent=%%",
    );
    expect(output.messages[0].slice(1)).toEqual(["ok", 3, { a: 1 }]);
    expect(output.messages).toHaveLength(1);
    output.restore();
  });

  test("does not emit when disabled and uses TTY colors when requested", () => {
    // Arrange
    const output = createDebugOutput();
    const logger = debug("werift:tty");
    restoreTTY = setStderrIsTTYForTest(true);
    debug.enable("");

    // Act
    logger("hidden");
    process.env.DEBUG_COLORS = "1";
    debug.enable("werift:tty");
    logger("visible");

    // Assert
    expect(output.messages).toHaveLength(1);
    expect(output.messages[0][0]).toContain("\u001b[");
    expect(output.messages[0][0]).toContain("visible +");
    output.restore();
  });

  test("uses timestamps without TTY colors and honors DEBUG_COLORS=0", () => {
    // Arrange
    const output = createDebugOutput();
    restoreTTY = setStderrIsTTYForTest(false);
    process.env.DEBUG_COLORS = "0";
    debug.enable("werift:plain");

    // Act
    debug("werift:plain")("plain");

    // Assert
    expect(output.messages[0][0]).toMatch(
      /^\d{4}-\d\d-\d\dT.* werift:plain plain$/,
    );
    expect(output.messages[0][0]).not.toContain("\u001b[");
    output.restore();
  });
});
