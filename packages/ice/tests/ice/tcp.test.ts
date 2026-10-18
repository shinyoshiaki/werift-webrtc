import { setTimeout } from "timers/promises";

import { describe, expect, test, vi } from "vitest";

import type { Address } from "../../../common/src";
import { CandidatePairState } from "../../src";
import {
  TCP_CHECK_RESPONSE_TIMEOUT_MS,
  classes,
  methods,
} from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { TcpActiveProtocol } from "../../src/stun/tcpProtocol";
import {
  addTcpPair,
  connectTcpOnly,
  createIncomingCheck,
  createRecordingTcpServer,
  createTcpCheckHarness,
  getClosedTcpPort,
  getSelectedTcpSocket,
} from "../utils";

describe("ICE-TCP nomination", () => {
  test("controlling agent nominates a TCP pair with a separate USE-CANDIDATE check", async () => {
    const harness = createTcpCheckHarness();
    const pair = addTcpPair(harness);

    try {
      // Act: 通常の connectivity check を実行し、その後の nomination 完了を待つ。
      await harness.connection.checkStart(pair).awaitable;
      await vi.waitFor(() => expect(harness.connection.nominated).toBe(pair));

      // Assert: 通常 check には USE-CANDIDATE が付かず、成功後の nomination check にだけ付く。
      const [check, nomination] = harness.protocol.sentMessages;
      expect(harness.protocol.sentMessages).toHaveLength(2);
      expect(check.attributesKeys).not.toContain("USE-CANDIDATE");
      expect(nomination.attributesKeys).toContain("USE-CANDIDATE");
      expect(pair.state).toBe(CandidatePairState.SUCCEEDED);

      // Assert: TCP check は再送 0 回で、50 ms ではなく TCP 用の timeout 予算を使う。
      for (const options of harness.protocol.requestOptions) {
        expect(options.retransmissions).toBe(0);
        expect(options.responseTimeout).toBe(TCP_CHECK_RESPONSE_TIMEOUT_MS);
      }
    } finally {
      await harness.connection.close();
    }
  });

  test("controlling agent does not attach USE-CANDIDATE to TCP triggered checks", async () => {
    const harness = createTcpCheckHarness();
    const request = createIncomingCheck(harness.connection);

    try {
      // Act: controlled 側からの check を受け、peer-reflexive pair の triggered check を走らせる。
      harness.connection.checkIncoming(
        request,
        harness.remoteAddr,
        harness.protocol,
      );
      await vi.waitFor(() =>
        expect(harness.connection.nominated).toBeDefined(),
      );

      // Assert: triggered check には USE-CANDIDATE が付かず、nomination check にだけ付く。
      const [triggered, nomination] = harness.protocol.sentMessages;
      expect(harness.protocol.sentMessages).toHaveLength(2);
      expect(triggered.attributesKeys).not.toContain("USE-CANDIDATE");
      expect(nomination.attributesKeys).toContain("USE-CANDIDATE");
      // learned prflx pair が nominate されている。
      expect(harness.connection.nominated?.remoteCandidate.type).toBe("prflx");
    } finally {
      await harness.connection.close();
    }
  });

  test("waits for the higher-priority TCP pair before nominating", async () => {
    const harness = createTcpCheckHarness();
    const high = addTcpPair(harness);
    // checkList は優先度降順として扱われるので、先に追加した pair が高優先度。
    const low = addTcpPair(harness);
    high.updateState(CandidatePairState.IN_PROGRESS);

    try {
      // Act: 低優先度 pair だけ先に成功させる。
      await harness.connection.checkStart(low).awaitable;
      await setTimeout(10);

      // Assert: 高優先度 pair の結果が出るまで nomination は送らない。
      expect(harness.protocol.sentMessages).toHaveLength(1);
      expect(harness.connection.nominated).toBeUndefined();

      // Act: 高優先度 pair を成功させる。
      await harness.connection.checkStart(high).awaitable;
      await vi.waitFor(() =>
        expect(harness.connection.nominated).toBeDefined(),
      );

      // Assert: 優先度が最も高い valid pair が nominate される。
      expect(harness.connection.nominated).toBe(high);
      expect(low.nominated).toBe(false);
    } finally {
      await harness.connection.close();
    }
  });
});

describe("ICE-TCP selected connection", () => {
  test("both agents keep sending on the same TCP connection after pruning", async () => {
    const { a, b } = await connectTcpOnly();

    try {
      // Act: nomination と prune の直後に双方向で送信する。
      await a.send(Buffer.from("ping-1"));
      const [first] = await b.onData.asPromise();
      await b.send(Buffer.from("pong-1"));
      const [firstEcho] = await a.onData.asPromise();

      // Act: 未選択接続の close が相手へ伝わるのを待ってから、もう一度双方向で送信する。
      await setTimeout(100);
      await a.send(Buffer.from("ping-2"));
      const [second] = await b.onData.asPromise();
      await b.send(Buffer.from("pong-2"));
      const [secondEcho] = await a.onData.asPromise();

      // Assert: どちらの送信も欠損なく届き、両端とも connected のまま。
      expect(first.toString()).toBe("ping-1");
      expect(firstEcho.toString()).toBe("pong-1");
      expect(second.toString()).toBe("ping-2");
      expect(secondEcho.toString()).toBe("pong-2");
      expect(a.state).toBe("connected");
      expect(b.state).toBe("connected");

      // Assert: 両端の selected socket は同じ 5-tuple を指し、開いたまま。
      const socketA = getSelectedTcpSocket(a);
      const socketB = getSelectedTcpSocket(b);
      expect(socketA?.destroyed).toBe(false);
      expect(socketB?.destroyed).toBe(false);
      expect(socketA?.localPort).toBe(socketB?.remotePort);
      expect(socketA?.remotePort).toBe(socketB?.localPort);
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("fails the agent when the selected TCP connection is closed", async () => {
    const { a, b } = await connectTcpOnly();

    try {
      // Act: 相手側で selected TCP 接続を切断する。
      getSelectedTcpSocket(b)?.destroy();

      // Assert: consent 失効を待たずに failed へ遷移し、以後は application data を送らない。
      await vi.waitFor(() => expect(a.state).toBe("failed"));
      await expect(a.send(Buffer.from("after close"))).resolves.toBeUndefined();
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("TcpProtocol socket handling", () => {
  test("drops a closed cached socket and reconnects before sending", async () => {
    const server = await createRecordingTcpServer();
    const protocol = new TcpActiveProtocol();
    await protocol.connectionMade("127.0.0.1");
    const closed: Address[] = [];
    protocol.onConnectionClosed.subscribe((addr) => closed.push(addr));

    try {
      await protocol.sendData(Buffer.from("first"), server.address);
      const [entry] = (protocol as any).sockets.values();

      // Act: close イベントより前に cached socket を破棄し、すぐ次の送信を行う。
      entry.socket.destroy();
      await protocol.sendData(Buffer.from("second"), server.address);

      // Assert: 破棄済み socket を使わず、新しい接続で送信している。
      await vi.waitFor(() => expect(server.sockets).toHaveLength(2));
      expect(protocol.activeSocketCount).toBe(1);
      // 失われた接続は一度だけ上位へ通知される。
      expect(closed).toEqual([server.address]);
    } finally {
      await protocol.close();
      await server.close();
    }
  });

  test("forgets the socket and rejects when a write fails", async () => {
    const server = await createRecordingTcpServer();
    const protocol = new TcpActiveProtocol();
    await protocol.connectionMade("127.0.0.1");
    const closed: Address[] = [];
    protocol.onConnectionClosed.subscribe((addr) => closed.push(addr));

    try {
      await protocol.sendData(Buffer.from("first"), server.address);
      const [entry] = (protocol as any).sockets.values();
      entry.socket.write = (_data: Buffer, callback: (e?: Error) => void) => {
        callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        return false;
      };

      // Act: 相手に閉じられた接続への書き込み失敗を再現する。
      const sending = protocol.sendData(Buffer.from("second"), server.address);

      // Assert: 失敗は握りつぶさずに呼び出し元へ返し、entry を破棄して通知する。
      await expect(sending).rejects.toMatchObject({ code: "EPIPE" });
      expect(protocol.activeSocketCount).toBe(0);
      expect(closed).toEqual([server.address]);
    } finally {
      await protocol.close();
      await server.close();
    }
  });

  test("fails a check immediately when the TCP connect is refused", async () => {
    const closedAddress = await getClosedTcpPort();
    const protocol = new TcpActiveProtocol();
    await protocol.connectionMade("127.0.0.1");
    const request = new Message(methods.BINDING, classes.REQUEST);

    try {
      // Act: 誰も listen していないポートへ長い timeout 付きで check を送る。
      const startedAt = Date.now();
      const result = protocol.request(request, closedAddress, undefined, {
        retransmissions: 0,
        responseTimeout: 10_000,
      });

      // Assert: timeout を待たずに connect 失敗として reject される。
      await expect(result).rejects.toMatchObject({ code: "ECONNREFUSED" });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      await protocol.close();
    }
  });
});
