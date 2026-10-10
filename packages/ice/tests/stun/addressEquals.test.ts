import type { Address } from "../../../common/src";
import { addressEquals } from "../../src/stun/transaction";

describe("addressEquals", () => {
  test.each([
    ["0:0:0:0:0:0:0:1", "::1"],
    ["0::1", "::1"],
    ["::0001", "::1"],
    ["::FFFF:127.0.0.1", "::ffff:127.0.0.1"],
  ])("IPv6 の表記違い %s と %s は同じアドレスとして扱う", (a, b) => {
    // Arrange: 同じ IPv6 アドレスの別表記
    const left: Address = [a, 3478];
    const right: Address = [b, 3478];

    // Act: アドレスを比較する
    const result = addressEquals(left, right);

    // Assert: 一致する
    expect(result).toBe(true);
  });

  test.each([
    [
      ["::1", 3478],
      ["::2", 3478],
    ],
    [
      ["::1", 3478],
      ["::1", 3479],
    ],
    [
      ["127.0.0.1", 3478],
      ["::ffff:127.0.0.1", 3478],
    ],
    [
      ["example.com", 3478],
      ["example.org", 3478],
    ],
  ] as [Address, Address][])(
    "異なるアドレス %j と %j は一致しない",
    (left, right) => {
      // Act: アドレスを比較する
      const result = addressEquals(left, right);

      // Assert: IP またはポートが違えば不一致
      expect(result).toBe(false);
    },
  );
});
