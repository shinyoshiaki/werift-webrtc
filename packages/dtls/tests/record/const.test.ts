import { AlertDesc, alertDescName } from "../../src/record/const";

describe("packages/dtls/tests/record/const.test.ts", () => {
  test("alertDescName returns the member name for a known value", () => {
    // Arrange
    const value = AlertDesc.HandshakeFailure;

    // Act: 既知の値から名前を引く
    const name = alertDescName(value);

    // Assert: enum 時代の逆引きと同じメンバー名が返る
    expect(name).toBe("HandshakeFailure");
  });

  test("alertDescName returns undefined for an unknown value", () => {
    // Arrange
    const value = 255;

    // Act: 定義されていない値から名前を引く
    const name = alertDescName(value);

    // Assert: 未知の値は undefined になり、暗号化 alert の判定に使える
    expect(name).toBeUndefined();
  });

  test("AlertDesc keeps its wire values", () => {
    // Act / Assert: const オブジェクト化しても値は変わっていない
    expect(AlertDesc.CloseNotify).toBe(0);
    expect(AlertDesc.UnsupportedExtension).toBe(110);
    // Assert: 逆引き用の数値キーは含まれない
    expect(Object.keys(AlertDesc).every((k) => Number.isNaN(Number(k)))).toBe(
      true,
    );
  });
});
