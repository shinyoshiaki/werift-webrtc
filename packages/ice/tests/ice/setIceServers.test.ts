import { Connection } from "../../src/ice";

describe("Connection.setIceServers", () => {
  test("TURN A → STUN only で turnServer / credential が残らない", async () => {
    // Arrange: TURN A で構築
    const connection = new Connection(true, {
      turnServer: ["turn-a.example.com", 3478],
      turnUsername: "user-a",
      turnPassword: "pass-a",
      turnTransport: "udp",
      stunServer: undefined,
    });

    try {
      expect(connection.turnServer).toEqual(["turn-a.example.com", 3478]);
      expect(connection.options.turnUsername).toBe("user-a");
      expect(connection.options.turnPassword).toBe("pass-a");

      // Act: STUN only に置換（parseIceServers が turn フィールドを返さない想定）
      connection.setIceServers({
        stunServer: ["stun.example.com", 19302],
        turnServer: undefined,
        turnUsername: undefined,
        turnPassword: undefined,
        turnTransport: undefined,
      });

      // Assert: TURN 関連が完全にクリアされ、STUN のみ残る
      expect(connection.stunServer).toEqual(["stun.example.com", 19302]);
      expect(connection.turnServer).toBeUndefined();
      expect(connection.options.turnServer).toBeUndefined();
      expect(connection.options.turnUsername).toBeUndefined();
      expect(connection.options.turnPassword).toBeUndefined();
      expect(connection.options.turnTransport).toBeUndefined();
    } finally {
      await connection.close();
    }
  });

  test("TURN A → TURN B で server / credential が置換される", async () => {
    // Arrange: TURN A
    const connection = new Connection(true, {
      turnServer: ["turn-a.example.com", 3478],
      turnUsername: "user-a",
      turnPassword: "pass-a",
      turnTransport: "udp",
      stunServer: undefined,
    });

    try {
      // Act: TURN B に置換
      connection.setIceServers({
        stunServer: undefined,
        turnServer: ["turn-b.example.com", 5349],
        turnUsername: "user-b",
        turnPassword: "pass-b",
        turnTransport: "tcp",
      });

      // Assert: A の残滓がなく B に置き換わっている
      expect(connection.turnServer).toEqual(["turn-b.example.com", 5349]);
      expect(connection.options.turnUsername).toBe("user-b");
      expect(connection.options.turnPassword).toBe("pass-b");
      expect(connection.options.turnTransport).toBe("tcp");
      expect(connection.options.turnUsername).not.toBe("user-a");
      expect(connection.options.turnPassword).not.toBe("pass-a");
    } finally {
      await connection.close();
    }
  });

  test("partial merge では消えない TURN credential が明示クリアされる", async () => {
    // Arrange: 旧実装は { ...old, ...new } で turn 欠落時に residual が残った
    const connection = new Connection(true, {
      turnServer: ["turn-a.example.com", 3478],
      turnUsername: "user-a",
      turnPassword: "pass-a",
      stunServer: ["stun.example.com", 19302],
    });

    try {
      // Act: parseIceServers が STUN only のとき返す形（turn キー無しに近い）
      connection.setIceServers({
        stunServer: ["stun.example.com", 19302],
      });

      // Assert: turn キー未指定でも server fields は置換され residual が消える
      expect(connection.options.turnServer).toBeUndefined();
      expect(connection.options.turnUsername).toBeUndefined();
      expect(connection.options.turnPassword).toBeUndefined();
      expect(connection.turnServer).toBeUndefined();
    } finally {
      await connection.close();
    }
  });

  test("stunServer 未指定は Google fallback、明示 undefined は STUN なし", async () => {
    // Arrange / Act: オプション省略と明示クリアを並べて構築する。
    const omitted = new Connection(true);
    const cleared = new Connection(true, { stunServer: undefined });
    try {
      // 検証: raw ICE API は従来どおり fallback を使い、明示 undefined は query しない。
      expect(omitted.stunServer).toEqual(["stun.l.google.com", 19302]);
      expect(cleared.stunServer).toBeUndefined();

      omitted.setIceServers({ stunServer: undefined });
      expect(omitted.stunServer).toBeUndefined();

      cleared.setIceServers({ stunServer: ["stun.example.com", 19302] });
      expect(cleared.stunServer).toEqual(["stun.example.com", 19302]);
    } finally {
      await omitted.close();
      await cleared.close();
    }
  });
});
