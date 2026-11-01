import { Connection } from "../../src/ice";
import { CandidatePairState } from "../../src/iceBase";
import {
  addUdpPair,
  answerChecksOnly,
  createUdpCheckHarness,
  inviteAccept,
} from "../utils";

describe("Connection role switch nomination", () => {
  test("controlled の間に成功した pair は controlling に切り替わった後に nominate される", async () => {
    // Arrange: a は controlled で checks を走らせ、b (controlling) は受けた check に応答するだけにする
    const a = new Connection(false);
    const b = new Connection(true);
    try {
      await inviteAccept(a, b);
      answerChecksOnly(b);
      const connected = a.connect();
      await vi.waitFor(
        () => {
          expect(
            a.checkList.some(
              (pair) => pair.state === CandidatePairState.SUCCEEDED,
            ),
          ).toBe(true);
        },
        { timeout: 5_000 },
      );
      // controlled の check は USE-CANDIDATE を持たないので、まだ誰も nominate していない
      expect(a.nominated).toBeUndefined();

      // Act: role conflict の修復と同じく、b を controlled、a を controlling に切り替える
      (b as any).switchRole(false);
      (a as any).switchRole(true);

      // Assert: a が成功済みの pair を USE-CANDIDATE 付きで確認し直して nominate し、connect が完了する
      await connected;
      expect(a.nominated).toBeDefined();
      expect(a.state).toBe("connected");
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  }, 15_000);
});

describe("Connection role assignment nomination", () => {
  test("controlled の間に成功した pair は offer / answer で controlling になった後に nominate される", async () => {
    // Arrange: a は controlled で checks を走らせ、b (controlling) は受けた check に応答するだけにする
    const a = new Connection(false);
    const b = new Connection(true);
    try {
      await inviteAccept(a, b);
      answerChecksOnly(b);
      const connected = a.connect();
      await vi.waitFor(
        () => {
          expect(
            a.checkList.some(
              (pair) => pair.state === CandidatePairState.SUCCEEDED,
            ),
          ).toBe(true);
        },
        { timeout: 5_000 },
      );
      expect(a.nominated).toBeUndefined();

      // Act: glare の offer 適用のように、setter で a を controlling、b を controlled にする
      b.iceControlling = false;
      a.iceControlling = true;

      // Assert: a が成功済みの pair を USE-CANDIDATE 付きで確認し直して nominate し、connect が完了する
      await connected;
      expect(a.nominated).toBeDefined();
      expect(a.state).toBe("connected");
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  }, 15_000);
});

describe("Connection role assignment priority", () => {
  test("offer / answer で controlling になったら、新しい role の pair priority で成功済み pair を選んで nominate する", async () => {
    // Arrange: 2 つの UDP pair の local / remote priority を入れ替え、role で優先順が逆になるようにする。
    // controlled では low-local (remote が高い) が上、controlling では high-local が上になる (RFC 8445 §6.1.2.3)。
    const harness = createUdpCheckHarness();
    const connection = harness.connection as unknown as {
      checksBegun: boolean;
    };
    harness.connection.iceControlling = false;
    connection.checksBegun = true;
    const lowLocal = addUdpPair(harness, 5000, {
      localPriority: 100,
      remotePriority: 200,
    });
    const highLocal = addUdpPair(harness, 5001, {
      localPriority: 200,
      remotePriority: 100,
    });
    expect(lowLocal.priority).toBeGreaterThan(highLocal.priority);

    try {
      // controlled の check は USE-CANDIDATE を持たず、両 pair とも nomination なしで成功する
      await harness.connection.checkStart(lowLocal).awaitable;
      await harness.connection.checkStart(highLocal).awaitable;
      expect(harness.connection.nominated).toBeUndefined();
      const checks = harness.protocol.sentMessages.length;

      // Act: offer / answer の適用と同じく setter で controlling にする。
      harness.connection.iceControlling = true;

      // Assert: checklist は新しい role の priority 順になり、その先頭 (high-local) を nominate する。
      expect(highLocal.priority).toBeGreaterThan(lowLocal.priority);
      expect(harness.connection.checkList[0]).toBe(highLocal);
      await vi.waitFor(() =>
        expect(harness.connection.nominated).toBe(highLocal),
      );
      // Assert: USE-CANDIDATE 付きの request は high-local への 1 回だけ。
      const nominations = harness.protocol.sentMessages
        .slice(checks)
        .filter((message) => message.attributesKeys.includes("USE-CANDIDATE"));
      expect(nominations).toHaveLength(1);
    } finally {
      await harness.connection.close();
    }
  });
});

describe("Connection role switch nomination retries", () => {
  test("ロール切り替え後の nomination が失敗したら、次の成功済み pair を nominate する", async () => {
    // Arrange: controlled で checks を始め、2 つの UDP pair を nomination なしで成功させる。
    // 応答は check 2 回が成功、1 回目の nomination がタイムアウト、以降は成功。
    const harness = createUdpCheckHarness(["success", "success", "timeout"]);
    const connection = harness.connection as unknown as {
      switchRole: (iceControlling: boolean) => void;
      checksBegun: boolean;
    };
    connection.switchRole(false);
    connection.checksBegun = true;
    const first = addUdpPair(harness, 5000);
    const second = addUdpPair(harness, 5001);

    try {
      await harness.connection.checkStart(first).awaitable;
      await harness.connection.checkStart(second).awaitable;
      expect([first.state, second.state]).toEqual([
        CandidatePairState.SUCCEEDED,
        CandidatePairState.SUCCEEDED,
      ]);
      expect(harness.connection.nominated).toBeUndefined();

      // Act: controlling に切り替える (役割に応じて並べ直した checklist の先頭を USE-CANDIDATE 付きで確認し直す)。
      connection.switchRole(true);
      const tried = [first, second].find(
        (pair) => pair.state === CandidatePairState.IN_PROGRESS,
      )!;
      const next = tried === first ? second : first;
      expect(tried).toBeDefined();

      // Assert: 最初の nomination はタイムアウトで失敗し、残る成功済み pair が nominate される。
      await vi.waitFor(() => expect(harness.connection.nominated).toBe(next), {
        timeout: 5_000,
      });
      expect(tried.state).toBe(CandidatePairState.FAILED);
      // Assert: 2 回の check の後、両方の pair に USE-CANDIDATE 付きの request を送っている。
      const nominations = harness.protocol.sentMessages
        .slice(2)
        .filter((message) => message.attributesKeys.includes("USE-CANDIDATE"));
      expect(nominations).toHaveLength(2);
    } finally {
      await harness.connection.close();
    }
  }, 15_000);
});
