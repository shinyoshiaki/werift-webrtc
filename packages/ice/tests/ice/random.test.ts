import { randomFill } from "crypto";
import { PooledRandomSource } from "../../src/helper";
import { Connection } from "../../src/ice";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import {
  createControlledPool,
  createFailingAfterRandomSource,
  createFailingRandomSource,
  createRecordingRandomSource,
  useRandomSource,
} from "../utils";

describe("ICE random source", () => {
  test("Connection draws credentials and tie-breaker once each", () => {
    // Arrange
    const { source, requests } = createRecordingRandomSource();
    useRandomSource(source);

    // Act: Connection を生成する。
    const connection = new Connection(true);

    // Assert: ufrag(4)・password(22)・tie-breaker(8) をそれぞれ 1 回だけ取得している。
    expect([...requests].sort((a, b) => a - b)).toEqual([4, 8, 22]);
    // Assert: 履歴は初回 generation の資格情報 1 件だけで、現行の ufrag と一致する。
    expect(Object.keys(connection.userHistory)).toEqual([
      connection.localUsername,
    ]);
    expect(connection.generation).toBe(0);
  });

  test("keeps the credential formats", () => {
    // Act: prefix なし / ありの Connection を生成する。
    const plain = new Connection(true);
    const prefixed = new Connection(true, { localPasswordPrefix: "werift" });

    // Assert: ufrag は hex 4 文字、password は hex 22 文字のまま。
    expect(plain.localUsername).toMatch(/^[0-9a-f]{4}$/);
    expect(plain.localPassword).toMatch(/^[0-9a-f]{22}$/);
    // Assert: prefix は先頭を置き換え、全体は 22 文字のまま。
    expect(prefixed.localPassword).toMatch(/^werift[0-9a-f]{16}$/);
  });

  test("Message transaction IDs are 96-bit and unique", () => {
    // Act: Message を連続生成する。
    const ids = Array.from(
      { length: 200 },
      () => new Message(methods.BINDING, classes.REQUEST).transactionId,
    );

    // Assert: すべて 12 バイトの Buffer で、重複がない。
    for (const id of ids) {
      expect(Buffer.isBuffer(id)).toBe(true);
      expect(id.length).toBe(12);
    }
    expect(new Set(ids.map((id) => id.toString("hex"))).size).toBe(ids.length);
  });

  test("a failing source propagates out of new Connection()", () => {
    // Arrange
    const error = new Error("entropy unavailable");
    useRandomSource(createFailingRandomSource(error));

    // Act / Assert: 乱数取得の失敗を握りつぶさず、生成時の例外として伝播する。
    expect(() => new Connection(true)).toThrow(error);
  });

  test.each([
    ["ufrag", 1],
    ["password", 2],
  ])(
    "a failure drawing the %s after the tie-breaker throws synchronously",
    async (_name, succeedFor) => {
      // Arrange: tie-breaker 取得後、指定の回数目で失敗させる。
      const error = new Error("entropy unavailable");
      useRandomSource(createFailingAfterRandomSource(succeedFor, error));
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);

      try {
        // Act: Connection を生成する。
        const create = () => new Connection(true);

        // Assert: 例外は同期的に呼び出し元へ伝わり、未処理の Promise 拒否を残さない。
        expect(create).toThrow(error);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    },
  );

  test("a failed restart() rejects and leaves the credentials untouched", async () => {
    // Arrange
    const connection = new Connection(true);
    const before = {
      username: connection.localUsername,
      password: connection.localPassword,
      generation: connection.generation,
      history: { ...connection.userHistory },
    };
    const error = new Error("entropy unavailable");
    useRandomSource(createFailingAfterRandomSource(1, error));

    // Act: 2 つ目の資格情報の取得で失敗する restart を実行する。
    const restart = connection.restart();

    // Assert: 失敗は拒否として伝わり、生成途中の値や generation は公開されない。
    await expect(restart).rejects.toThrow(error);
    expect(connection.localUsername).toBe(before.username);
    expect(connection.localPassword).toBe(before.password);
    expect(connection.generation).toBe(before.generation);
    expect(connection.userHistory).toEqual(before.history);
  });

  test("an empty pool falls back to a synchronous draw while the refill is delayed", () => {
    // Arrange
    const harness = createControlledPool();
    useRandomSource(harness.pool);

    // Act: 非同期補充が完了しないまま Connection を生成する。
    const connection = new Connection(true);

    // Assert: 同期フォールバックで正しい形式の資格情報が得られる。
    expect(connection.localUsername).toMatch(/^[0-9a-f]{4}$/);
    expect(connection.localPassword).toMatch(/^[0-9a-f]{22}$/);
    expect(harness.fillSyncCalls).toBe(3);
    // Assert: 補充は多重に予約されず 1 本だけ待っている。
    expect(harness.pendingRefills).toBe(1);
  });

  test("a failed refill falls back to synchronous draws and retries", () => {
    // Arrange
    const harness = createControlledPool();
    harness.pool.refill();

    // Act: 非同期補充を失敗させてから乱数を取得する。
    harness.settleRefill(new Error("refill failed"));
    const bytes = harness.pool.bytes(8);

    // Assert: プールは空のまま同期取得で長さ通りの値を返し、補充を再予約する。
    expect(bytes.length).toBe(8);
    expect(harness.pool.available).toBe(0);
    expect(harness.fillSyncCalls).toBe(1);
    expect(harness.pendingRefills).toBe(1);
  });

  test("pooled bytes are never served twice", () => {
    // Arrange
    const harness = createControlledPool(64, 16);
    harness.pool.refill();
    harness.settleRefill();

    // Act: プールから連続して切り出す。
    const first = harness.pool.bytes(20);
    first.fill(0xff);
    const second = harness.pool.bytes(20);
    const third = harness.pool.bytes(20);

    // Assert: 連続した区間を重複なく返し、返したバッファはプールと共有しない。
    expect([...second]).toEqual(Array.from({ length: 20 }, (_, i) => i + 21));
    expect([...third]).toEqual(Array.from({ length: 20 }, (_, i) => i + 41));
    expect(harness.fillSyncCalls).toBe(0);
    // Assert: 残量がしきい値を下回ったので補充が 1 本だけ予約される。
    expect(harness.pendingRefills).toBe(1);

    // Act: 残り 4 バイトより多く要求する。
    const fallback = harness.pool.bytes(8);

    // Assert: 残りを使い回さず同期取得し、補充は多重予約されない。
    expect(fallback.length).toBe(8);
    expect(harness.fillSyncCalls).toBe(1);
    expect(harness.pendingRefills).toBe(1);
  });

  test("a refilled pool serves new Connection() without synchronous entropy calls", async () => {
    // Arrange: 実際の非同期 randomFill で補充を完了させる。
    const harness = createControlledPool();
    const pool = useRandomSource(
      new PooledRandomSource(512, 128, randomFill, harness.fillSync),
    );
    pool.refill();
    await vi.waitFor(() => expect(pool.available).toBe(512));

    // Act: 補充済みのプールで Connection を生成する。
    const connection = new Connection(true);

    // Assert: 同期のエントロピー API を呼ばず、プールから 34 バイトだけ消費する。
    expect(harness.fillSyncCalls).toBe(0);
    expect(pool.available).toBe(512 - 34);
    expect(connection.localUsername).toMatch(/^[0-9a-f]{4}$/);
  });
});
