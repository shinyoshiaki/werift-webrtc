import { setTimeout as delay } from "timers/promises";
import type { Address, Transport } from "../../../common/src";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { TurnProtocol } from "../../src/turn/protocol";

/** Minimal Transport that never talks to the network. */
function createMockTransport(): Transport {
  return {
    type: "udp",
    closed: false,
    onData: () => {},
    address: { address: "127.0.0.1", port: 0, family: "IPv4" },
    send: async () => {},
    close: async () => {},
  };
}

function createTurnProtocol(
  options: { channelRefreshTime?: number } = {},
): TurnProtocol {
  const turn = new TurnProtocol(
    ["127.0.0.1", 3478],
    "user",
    "pass",
    600,
    createMockTransport(),
    options,
  );
  turn.relayedAddress = ["203.0.113.1", 50000];
  turn.mappedAddress = ["203.0.113.2", 40000];
  turn.realm = "test.local";
  turn.nonce = Buffer.from("nonce");
  turn.integrityKey = Buffer.alloc(16);
  return turn;
}

function successResponse(method: number): Message {
  return new Message(method, classes.RESPONSE);
}

/** Peer addresses used across isolation scenarios. */
const peerA: Address = ["192.0.2.10", 10000];
const peerB: Address = ["192.0.2.20", 20000];
const peerAOtherPort: Address = ["192.0.2.10", 10001];

describe("TurnProtocol isolation (issue #667)", () => {
  test("CreatePermission failure for peer A does not poison peer B", async () => {
    // Arrange: peer A は拒否、peer B は成功する scripted requestWithRetry
    const turn = createTurnProtocol();
    const createPermissionCalls: Address[] = [];
    turn.requestWithRetry = async (request) => {
      if (request.messageMethod !== methods.CREATE_PERMISSION) {
        throw new Error(`unexpected method ${request.messageMethod}`);
      }
      const peer = request.getAttributeValue("XOR-PEER-ADDRESS") as Address;
      createPermissionCalls.push(peer);
      if (peer[0] === peerA[0] && peer[1] === peerA[1]) {
        throw new Error("createPermission rejected for A");
      }
      return [successResponse(methods.CREATE_PERMISSION), turn.server];
    };

    // Act: A を拒否させたあと B を試す
    await expect(turn.getPermission(peerA)).rejects.toThrow(
      "createPermission rejected for A",
    );
    await turn.getPermission(peerB);

    // Assert: B まで到達し成功している
    expect(createPermissionCalls).toEqual([peerA, peerB]);
  });

  test("failed CreatePermission is not cached and same peer can retry", async () => {
    // Arrange: 1 回目 reject、2 回目 success
    const turn = createTurnProtocol();
    let attempts = 0;
    turn.requestWithRetry = async (request) => {
      if (request.messageMethod !== methods.CREATE_PERMISSION) {
        throw new Error("unexpected method");
      }
      attempts++;
      if (attempts === 1) {
        throw new Error("first attempt fails");
      }
      return [successResponse(methods.CREATE_PERMISSION), turn.server];
    };

    // Act: 1 回目失敗 → 2 回目成功
    await expect(turn.getPermission(peerA)).rejects.toThrow(
      "first attempt fails",
    );
    await turn.getPermission(peerA);

    // Assert: 2 回 transaction が走り、cache は成功後のみ
    expect(attempts).toBe(2);
  });

  test("concurrent same-peer CreatePermission shares one transaction", async () => {
    // Arrange: CreatePermission を遅延させて concurrent を再現
    const turn = createTurnProtocol();
    let attempts = 0;
    turn.requestWithRetry = async (request) => {
      if (request.messageMethod !== methods.CREATE_PERMISSION) {
        throw new Error("unexpected method");
      }
      attempts++;
      await delay(30);
      return [successResponse(methods.CREATE_PERMISSION), turn.server];
    };

    // Act: 同一 peer に同時に 3 回
    await Promise.all([
      turn.getPermission(peerA),
      turn.getPermission(peerA),
      turn.getPermission(peerA),
    ]);

    // Assert: transaction は 1 回だけ
    expect(attempts).toBe(1);
  });

  test("CreatePermission key is peer IP only (shared across ports)", async () => {
    // Arrange: 同じ IP・異なる port
    const turn = createTurnProtocol();
    let attempts = 0;
    turn.requestWithRetry = async (request) => {
      if (request.messageMethod !== methods.CREATE_PERMISSION) {
        throw new Error("unexpected method");
      }
      attempts++;
      return [successResponse(methods.CREATE_PERMISSION), turn.server];
    };

    // Act: 同一 IP の別 port に permission
    await turn.getPermission(peerA);
    await turn.getPermission(peerAOtherPort);

    // Assert: permission は IP 単位なので 1 transaction
    expect(attempts).toBe(1);
  });

  test("ChannelBind failure for peer A does not poison peer B", async () => {
    // Arrange: A 拒否、B 成功
    const turn = createTurnProtocol();
    const boundPeers: Address[] = [];
    turn.requestWithRetry = async (request) => {
      if (request.messageMethod !== methods.CHANNEL_BIND) {
        throw new Error("unexpected method");
      }
      const peer = request.getAttributeValue("XOR-PEER-ADDRESS") as Address;
      boundPeers.push(peer);
      if (peer[0] === peerA[0] && peer[1] === peerA[1]) {
        throw new Error("channelBind rejected for A");
      }
      return [successResponse(methods.CHANNEL_BIND), turn.server];
    };

    // Act
    await expect(turn.getChannel(peerA)).rejects.toThrow(
      "channelBind rejected for A",
    );
    const channelB = await turn.getChannel(peerB);

    // Assert
    expect(boundPeers).toEqual([peerA, peerB]);
    expect(channelB.address).toEqual(peerB);
  });

  test("failed initial ChannelBind rolls back provisional mapping", async () => {
    // Arrange
    const turn = createTurnProtocol();
    turn.requestWithRetry = async (request) => {
      if (request.messageMethod !== methods.CHANNEL_BIND) {
        throw new Error("unexpected method");
      }
      throw new Error("channelBind timeout");
    };

    // Act
    await expect(turn.getChannel(peerA)).rejects.toThrow("channelBind timeout");

    // Assert: 内部 mapping が残っていない（再試行時に「既に bind 済み」と誤認しない）
    const internal = turn as unknown as {
      channelByAddr: Record<string, unknown>;
      addrByChannel: Record<number, Address>;
    };
    expect(Object.keys(internal.channelByAddr)).toHaveLength(0);
    expect(Object.keys(internal.addrByChannel)).toHaveLength(0);
  });

  test("ChannelBind retry after failure uses a new channel number", async () => {
    // Arrange: 1 回目 fail、2 回目 success
    const turn = createTurnProtocol();
    const channelNumbers: number[] = [];
    let attempts = 0;
    turn.requestWithRetry = async (request) => {
      if (request.messageMethod !== methods.CHANNEL_BIND) {
        throw new Error("unexpected method");
      }
      const number = request.getAttributeValue("CHANNEL-NUMBER") as number;
      channelNumbers.push(number);
      attempts++;
      if (attempts === 1) {
        throw new Error("first channelBind fails");
      }
      return [successResponse(methods.CHANNEL_BIND), turn.server];
    };

    // Act
    await expect(turn.getChannel(peerA)).rejects.toThrow(
      "first channelBind fails",
    );
    const channel = await turn.getChannel(peerA);

    // Assert: number は巻き戻さず増加、成功 channel は 2 回目の number
    expect(channelNumbers).toHaveLength(2);
    expect(channelNumbers[1]).toBe(channelNumbers[0]! + 1);
    expect(channel.number).toBe(channelNumbers[1]);
  });

  test("concurrent same-peer ChannelBind shares one transaction", async () => {
    // Arrange
    const turn = createTurnProtocol();
    let attempts = 0;
    turn.requestWithRetry = async (request) => {
      if (request.messageMethod !== methods.CHANNEL_BIND) {
        throw new Error("unexpected method");
      }
      attempts++;
      await delay(30);
      return [successResponse(methods.CHANNEL_BIND), turn.server];
    };

    // Act
    const channels = await Promise.all([
      turn.getChannel(peerA),
      turn.getChannel(peerA),
      turn.getChannel(peerA),
    ]);

    // Assert
    expect(attempts).toBe(1);
    expect(channels[0]!.number).toBe(channels[1]!.number);
    expect(channels[1]!.number).toBe(channels[2]!.number);
  });

  test("ChannelBind refresh failure for one channel does not poison another", async () => {
    // Arrange: 初回 bind は両方成功、refresh 時のみ A が失敗
    const turn = createTurnProtocol({ channelRefreshTime: 1 });
    const bindCounts = new Map<string, number>();
    turn.requestWithRetry = async (request) => {
      if (request.messageMethod !== methods.CHANNEL_BIND) {
        throw new Error("unexpected method");
      }
      const peer = request.getAttributeValue("XOR-PEER-ADDRESS") as Address;
      const key = `${peer[0]}:${peer[1]}`;
      const count = (bindCounts.get(key) ?? 0) + 1;
      bindCounts.set(key, count);
      // peerA の 2 回目（refresh）だけ失敗
      if (peer[0] === peerA[0] && peer[1] === peerA[1] && count >= 2) {
        throw new Error("refresh A failed");
      }
      return [successResponse(methods.CHANNEL_BIND), turn.server];
    };

    const channelA = await turn.getChannel(peerA);
    const channelB = await turn.getChannel(peerB);
    // refresh 期限を強制的に過去へ
    channelA.refreshAt = 0;
    channelB.refreshAt = 0;

    // Act: A の refresh 失敗後も B の refresh は成功する
    await expect(turn.getChannel(peerA)).rejects.toThrow("refresh A failed");
    const refreshedB = await turn.getChannel(peerB);

    // Assert
    expect(refreshedB.number).toBe(channelB.number);
    expect(refreshedB.refreshAt).toBeGreaterThan(0);
  });

  test("channel refresh deadlines are independent per channel", async () => {
    // Arrange
    const turn = createTurnProtocol({ channelRefreshTime: 100 });
    turn.requestWithRetry = async (request) => {
      if (request.messageMethod !== methods.CHANNEL_BIND) {
        throw new Error("unexpected method");
      }
      return [successResponse(methods.CHANNEL_BIND), turn.server];
    };

    // Act: A を先に bind、少し待ってから B を bind
    const channelA = await turn.getChannel(peerA);
    const refreshAtA = channelA.refreshAt;
    // 実時間を進めずに B の refreshAt が A を上書きしないことを構造で確認
    await delay(20);
    const channelB = await turn.getChannel(peerB);

    // Assert: 各 channel が独自の refreshAt を持つ（allocation-global ではない）
    expect(channelA.refreshAt).toBe(refreshAtA);
    expect(channelB.refreshAt).toBeGreaterThanOrEqual(channelA.refreshAt);
    // B を bind しても A の refreshAt は変わらない
    expect(channelA.refreshAt).toBe(refreshAtA);
    expect(channelA).not.toBe(channelB);
  });

  test("after rejected peer, valid peer ChannelData path still works via sendData", async () => {
    // Arrange: A は ChannelBind 拒否、B は成功。send を記録
    const turn = createTurnProtocol();
    const sent: Buffer[] = [];
    (
      turn as unknown as {
        send: (data: Buffer, addr: Address) => Promise<void>;
      }
    ).send = async (data: Buffer) => {
      sent.push(data);
    };

    turn.requestWithRetry = async (request) => {
      if (request.messageMethod === methods.CHANNEL_BIND) {
        const peer = request.getAttributeValue("XOR-PEER-ADDRESS") as Address;
        if (peer[0] === peerA[0] && peer[1] === peerA[1]) {
          throw new Error("channelBind rejected for A");
        }
        return [successResponse(methods.CHANNEL_BIND), turn.server];
      }
      if (request.messageMethod === methods.CREATE_PERMISSION) {
        // A フォールバック用 permission は成功させてもよいが、ここでは B のみ使う
        return [successResponse(methods.CREATE_PERMISSION), turn.server];
      }
      throw new Error("unexpected method");
    };

    // Act: 拒否 peer の後に valid peer へ ChannelData
    await expect(turn.getChannel(peerA)).rejects.toThrow(
      "channelBind rejected for A",
    );
    await turn.sendData(Buffer.from("hello-b"), peerB);

    // Assert: B 向け ChannelData が送信されている
    expect(sent.length).toBeGreaterThanOrEqual(1);
    // ChannelData は channel number (0x4000+) で始まる
    expect(sent[0]!.readUInt16BE(0)).toBeGreaterThanOrEqual(0x4000);
  });
});
