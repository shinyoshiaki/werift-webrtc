import { describe, expect, test } from "vitest";
import { KeyUpdate } from "../../../src/handshake/message/tls13/keyUpdate";

describe("KeyUpdate wire codec", () => {
  test("roundtrips update_not_requested / update_requested", () => {
    // Arrange: KeyUpdate 0/1 の wire 形式
    // Act / Assert: 往復で requestUpdate フラグが保たれる
    expect(KeyUpdate.deSerialize(Buffer.from([0])).requestUpdate).toBe(false);
    expect(KeyUpdate.deSerialize(Buffer.from([1])).requestUpdate).toBe(true);
    expect(new KeyUpdate(false).serialize()).toEqual(Buffer.from([0]));
    expect(new KeyUpdate(true).serialize()).toEqual(Buffer.from([1]));
  });

  test("rejects invalid KeyUpdateRequest values (illegal_parameter)", () => {
    // Arrange: 0/1 以外の KeyUpdateRequest
    // Act / Assert: illegal_parameter で拒否する
    expect(() => KeyUpdate.deSerialize(Buffer.from([2]))).toThrow(
      /illegal_parameter/,
    );
    expect(() => KeyUpdate.deSerialize(Buffer.from([0xff]))).toThrow(
      /illegal_parameter/,
    );
  });

  test("rejects truncated or overlong body", () => {
    // Arrange: 長すぎる／空の body
    // Act / Assert: decode_error 相当で拒否する
    expect(() => KeyUpdate.deSerialize(Buffer.alloc(0))).toThrow(/truncated/);
    expect(() => KeyUpdate.deSerialize(Buffer.from([0, 0]))).toThrow(
      /decode_error|invalid KeyUpdate length/,
    );
  });
});
