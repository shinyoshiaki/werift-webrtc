import { Connection } from "../../src/ice";
import {
  describeIceServerModes,
  iceServerModeOfSeed,
  withIceServerMode,
} from "../utils";

describeIceServerModes("ICE server modes", (mode) => {
  test("STUN server を指定しない Connection は mode に従う", async () => {
    // Act: stunServer を指定せずに構築する
    const connection = new Connection(true);
    try {
      // Assert: no STUN では STUN なし、implicit STUN ではローカル fixture を使う
      if (mode === "no STUN") {
        expect(connection.stunServer).toBeUndefined();
      } else {
        expect(connection.stunServer).toBeDefined();
      }
    } finally {
      await connection.close();
    }
  });
});

describe("withIceServerMode", () => {
  test("implicit STUN は実行中だけ有効で、終了後は STUN なしに戻る", async () => {
    // Act: 奇数 seed の mode で Connection を作り、終了後にもう一度作る
    const during = await withIceServerMode(iceServerModeOfSeed(1), async () => {
      const connection = new Connection(true);
      await connection.close();
      return connection.stunServer;
    });
    const after = new Connection(true);

    try {
      // Assert: 実行中は fixture を使い、終了後は既定どおり STUN なし
      expect(iceServerModeOfSeed(1)).toBe("implicit STUN");
      expect(iceServerModeOfSeed(2)).toBe("no STUN");
      expect(during).toBeDefined();
      expect(after.stunServer).toBeUndefined();
    } finally {
      await after.close();
    }
  });
});
