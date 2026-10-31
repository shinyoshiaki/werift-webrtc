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
      // stunServer: undefined は既定の公開 STUN で補われない
      expect(connection.stunServer).toBeUndefined();
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

  test.each([
    ["new Connection(true)", () => new Connection(true)],
    [
      "new Connection(true, { stunServer: undefined })",
      () => new Connection(true, { stunServer: undefined }),
    ],
  ])("%s は STUN なし (既定の公開 STUN を補わない)", async (_name, create) => {
    // Act: stunServer を省略 / undefined にして構築
    const connection = create();

    try {
      // Assert: STUN を使わない
      expect(connection.stunServer).toBeUndefined();
      expect(connection.options.stunServer).toBeUndefined();
    } finally {
      await connection.close();
    }
  });

  test("STUN あり → setIceServers({ stunServer: undefined }) で STUN なしになる", async () => {
    // Arrange: STUN を明示して構築
    const connection = new Connection(true, {
      stunServer: ["stun.example.com", 19302],
    });

    try {
      expect(connection.stunServer).toEqual(["stun.example.com", 19302]);

      // Act: STUN を外す
      connection.setIceServers({ stunServer: undefined });

      // Assert: 既定の公開 STUN に戻らず STUN なしになる
      expect(connection.stunServer).toBeUndefined();
      expect(connection.options.stunServer).toBeUndefined();
    } finally {
      await connection.close();
    }
  });
});
