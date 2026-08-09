import { describe, expect, test } from "vitest";
import { KeyUpdate } from "../../../src/handshake/message/tls13/keyUpdate";

describe("KeyUpdate wire codec", () => {
  test("roundtrips update_not_requested / update_requested", () => {
    // Arrange: 前提を準備する
    expect(KeyUpdate.deSerialize(Buffer.from([0])).requestUpdate).toBe(false);
    expect(KeyUpdate.deSerialize(Buffer.from([1])).requestUpdate).toBe(true);
    expect(new KeyUpdate(false).serialize()).toEqual(Buffer.from([0]));
    expect(new KeyUpdate(true).serialize()).toEqual(Buffer.from([1]));
  });

  test("rejects invalid KeyUpdateRequest values (illegal_parameter)", () => {
    // Arrange: 前提を準備する
    expect(() => KeyUpdate.deSerialize(Buffer.from([2]))).toThrow(
      /illegal_parameter/,
    );
    expect(() => KeyUpdate.deSerialize(Buffer.from([0xff]))).toThrow(
      /illegal_parameter/,
    );
  });

  test("rejects truncated or overlong body", () => {
    // Arrange: 前提を準備する
    expect(() => KeyUpdate.deSerialize(Buffer.alloc(0))).toThrow(/truncated/);
    expect(() => KeyUpdate.deSerialize(Buffer.from([0, 0]))).toThrow(
      /decode_error|invalid KeyUpdate length/,
    );
  });
});
