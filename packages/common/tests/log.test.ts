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

    // Act: 包含・除外パターンを設定し、両方の logger を呼ぶ
    debug.enable("werift*,other exact,-werift:ice:secret");
    included("included");
    excluded("excluded");

    // Assert: 除外パターンが優先され、包含側だけが出力される
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

    // Act: 書式指定子付きで出力した後、disable() してから再度呼ぶ
    logger("value=%s count=%d json=%j percent=%%", "ok", 3, { a: 1 });
    const previous = debug.disable();
    logger("hidden");

    // Assert: 書式指定子は console 側に任せて引数のまま渡し、disable() 後は出力しない
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

    // Act: 無効のまま呼んだ後、DEBUG_COLORS=1 で有効化して呼ぶ
    logger("hidden");
    process.env.DEBUG_COLORS = "1";
    debug.enable("werift:tty");
    logger("visible");

    // Assert: 有効化後の 1 件だけが色付き namespace と +Nms 付きで出力される
    expect(output.messages).toHaveLength(1);
    expect(output.messages[0][0]).toContain("\u001b[");
    expect(output.messages[0][0]).toContain("visible +");
    output.restore();
  });

  test("forces colors on non-TTY with DEBUG_COLORS=1 but NO_COLOR wins", () => {
    // Arrange
    const output = createDebugOutput();
    restoreTTY = setStderrIsTTYForTest(false);
    process.env.DEBUG_COLORS = "1";
    debug.enable("werift:force");

    // Act: 非 TTY で DEBUG_COLORS=1 のまま出力し、その後 NO_COLOR を設定して出力する
    debug("werift:force")("forced");
    process.env.NO_COLOR = "1";
    debug("werift:force")("nocolor");

    // Assert: 1 件目は色付き、2 件目は NO_COLOR により色なしになる
    expect(output.messages[0][0]).toContain("\u001b[");
    expect(output.messages[1][0]).not.toContain("\u001b[");
    output.restore();
  });

  test("uses timestamps without TTY colors and honors DEBUG_COLORS=0", () => {
    // Arrange
    const output = createDebugOutput();
    restoreTTY = setStderrIsTTYForTest(false);
    process.env.DEBUG_COLORS = "0";
    debug.enable("werift:plain");

    // Act: TTY ではない stderr で出力する
    debug("werift:plain")("plain");

    // Assert: 色なしで ISO 時刻と namespace が先頭に付く
    expect(output.messages[0][0]).toMatch(
      /^\d{4}-\d\d-\d\dT.* werift:plain plain$/,
    );
    expect(output.messages[0][0]).not.toContain("\u001b[");
    output.restore();
  });
});
