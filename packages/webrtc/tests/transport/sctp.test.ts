import { vi } from "vitest";
import { SCTPSendPermissionRevokedError } from "../../../sctp/src";

import { SCTP_STATE } from "../../../sctp/src";
import { Event, RTCDataChannel, RTCSctpTransport } from "../../src";
import { RTCDataChannelParameters } from "../../src/dataChannel";
import { dtlsTransportPair } from "../fixture";

describe("RTCSctpTransportTest", () => {
  test("reuses outbound MTU when replacing the DTLS transport", async () => {
    const [first] = await dtlsTransportPair();
    const [second] = await dtlsTransportPair();
    const transport = new RTCSctpTransport(5000, undefined, { mtu: 1052 });

    // Act: DTLS transport を差し替えて SCTP association を再生成する。
    transport.setDtlsTransport(first);
    transport.setDtlsTransport(second);

    // Assert: constructor で指定した MTU が再生成後にも保持される。
    expect(transport.sctp.mtu).toBe(1052);
  });

  test("stop discards unsent messages and releases bufferedAmount", async () => {
    // Arrange: association 確立前の transport に未送信メッセージを積む。
    const [first, second] = await dtlsTransportPair();
    const transport = new RTCSctpTransport();
    transport.setDtlsTransport(first);
    const channel = new RTCDataChannel(
      transport,
      new RTCDataChannelParameters({ label: "unsent", id: 1 }),
    );
    transport.datachannelSend(channel, Buffer.from("stale-1"));
    transport.datachannelSend(channel, "stale-2");
    expect(channel.bufferedAmount).toBe(14);

    // Act: 停止して別の DTLS transport で再接続する。
    await transport.stop();
    transport.setDtlsTransport(second);
    const sent: unknown[] = [];
    const send = transport.sctp.send.bind(transport.sctp);
    transport.sctp.send = ((...args: Parameters<typeof send>) => {
      sent.push(args[2]);
      return send(...args);
    }) as typeof send;
    transport["dataChannelFlush"]();

    // Assert: 古いメッセージは SCTP に渡されず、bufferedAmount は 0 に戻る。
    expect(sent).toHaveLength(0);
    // DATA_CHANNEL_OPEN だけが残る (チャネルが存続する場合に備える)。
    expect(transport["dataChannelQueue"].toArray().map((i) => i[1])).toEqual([
      50,
    ]);
    expect(channel.bufferedAmount).toBe(0);
  });

  test("reconnect does not announce a channel closed while stopped", async () => {
    // Arrange: 未確立の transport で OPEN を積み、停止後にチャネルが closed になる。
    const [first] = await dtlsTransportPair();
    const [clientDtls, serverDtls] = await dtlsTransportPair();
    const client = new RTCSctpTransport();
    client.setDtlsTransport(first);
    const closedChannel = new RTCDataChannel(
      client,
      new RTCDataChannelParameters({ label: "closed-before-reconnect", id: 1 }),
    );
    const aliveChannel = new RTCDataChannel(
      client,
      new RTCDataChannelParameters({ label: "alive", id: 3 }),
    );
    await client.stop();
    closedChannel.setReadyState("closed");
    const server = new RTCSctpTransport();
    server.setDtlsTransport(serverDtls);
    const labels: string[] = [];
    server.onDataChannel.subscribe((c) => labels.push(c.label));

    // Act: 同じ transport に DTLS を再設定して association を確立する。
    client.setDtlsTransport(clientDtls);
    await Promise.all([server.start(client.port), client.start(server.port)]);
    await waitForOutcome(client, server);
    await new Promise((r) => setTimeout(r, 300));

    // Assert: stop で closed になったチャネルの OPEN は再接続後に送られない。
    expect(aliveChannel.readyState).toBe("closed");
    expect(labels).toEqual([]);
    expect(client["dataChannelQueue"].length).toBe(0);
  });

  function trackChannels(transport: RTCSctpTransport) {
    const channels: RTCDataChannel[] = [];

    transport.onDataChannel.subscribe((channel) => {
      channels.push(channel);
    });

    return { channels, event: transport.onDataChannel };
  }

  async function waitForOutcome(
    client: RTCSctpTransport,
    server: RTCSctpTransport,
  ) {
    await Promise.all([
      client.sctp.stateChanged.connected.asPromise(),
      server.sctp.stateChanged.connected.asPromise(),
    ]);
  }

  test("test_connect_then_client_creates_data_channel", async () =>
    new Promise<void>(async (done) => {
      const [clientTransport, serverTransport] = await dtlsTransportPair();

      const client = new RTCSctpTransport();
      client.setDtlsTransport(clientTransport);
      const server = new RTCSctpTransport();
      server.setDtlsTransport(serverTransport);

      await Promise.all([server.start(client.port), client.start(server.port)]);

      // wait for sctp connected
      await waitForOutcome(client, server);

      const serverChannels = trackChannels(server);
      serverChannels.event.subscribe((channel) => {
        channel.send(Buffer.from("ping"));
        channel.onMessage.subscribe((data) => {
          expect(data.toString()).toBe("pong");
          done();
        });
      });

      const channel = new RTCDataChannel(
        client,
        new RTCDataChannelParameters({ label: "chat", id: 1 }),
      );
      channel.onMessage.subscribe((data) => {
        expect(data.toString()).toBe("ping");
        channel.send(Buffer.from("pong"));
      });
    }));

  test("INIT 送信許可の取消しを reject し、次の start で association を再構築する", async () => {
    // Arrange: DTLS bridge の最初の送信だけ送信許可の取消しで失敗させる
    // (単なる送信失敗は損失として T1 が再送する)。
    const sendData = vi
      .fn<(...args: [Buffer]) => Promise<void>>()
      .mockRejectedValueOnce(
        new SCTPSendPermissionRevokedError("INIT send failed"),
      )
      .mockResolvedValue(undefined);
    const dtls = {
      id: "fake-dtls",
      role: "server",
      onStateChange: new Event<[string]>(),
      dataReceiver: () => {},
      sendData,
    } as any;
    const transport = new RTCSctpTransport();
    transport.setDtlsTransport(dtls);

    // Act: 初回の INIT failure は接続待ちのまま残さず reject する。
    await expect(transport.start(5001)).rejects.toThrow("INIT send failed");
    const failedAssociation = transport.sctp;

    // Assert: 失敗 association は CLOSED で、次回 start は新 association を使う。
    expect(failedAssociation.associationState).toBe(SCTP_STATE.CLOSED);
    await transport.start(5001);
    expect(transport.sctp).not.toBe(failedAssociation);
    expect(transport.sctp.associationState).toBe(SCTP_STATE.COOKIE_WAIT);

    await transport.stop();
  });

  /** Arrange: DTLS server stand-in exposing the early-attempt lifecycle events. */
  function createEarlyDtlsStub() {
    return {
      id: "fake-dtls-early",
      role: "server",
      state: "connecting",
      onStateChange: new Event<[string]>(),
      onEarlyApplicationAttemptCancelled: new Event<[]>(),
      onEarlyApplicationSendRevoked: new Event<[]>(),
      dataReceiver: () => {},
      sendData: vi.fn(async () => {}),
    };
  }

  test.each([
    { authenticatedBeforeCancel: false, cancelled: true },
    { authenticatedBeforeCancel: true, cancelled: false },
  ])(
    "認証前に始めた early start は認証前だけ取り消され、認証後の SPED reset では維持される (authenticated=$authenticatedBeforeCancel)",
    async ({ authenticatedBeforeCancel, cancelled }) => {
      // Arrange: DTLS server が認証前 (connecting) に SCTP を開始し COOKIE_WAIT にいる
      const dtls = createEarlyDtlsStub();
      const transport = new RTCSctpTransport();
      transport.setDtlsTransport(dtls as any);
      await transport.start(5001);
      const association = transport.sctp;
      expect(association.associationState).toBe(SCTP_STATE.COOKIE_WAIT);

      try {
        if (authenticatedBeforeCancel) {
          // Act: COOKIE_WAIT のまま DTLS が認証済み (connected) になる
          dtls.state = "connected";
          dtls.onStateChange.execute("connected");
        }
        // Act: SPED reset / ICE restart による early attempt の取消し通知
        dtls.onEarlyApplicationAttemptCancelled.execute();

        // Assert: 認証前なら early attempt として取り消し、認証後は同じ
        // association のまま開始を続ける (T1 が INIT を再送する)
        if (cancelled) {
          expect(association.associationState).toBe(SCTP_STATE.CLOSED);
          expect(association.startCancellationError).toBeDefined();
        } else {
          expect(transport.sctp).toBe(association);
          expect(association.associationState).toBe(SCTP_STATE.COOKIE_WAIT);
          expect(association.startCancellationError).toBeUndefined();
        }
      } finally {
        await transport.stop();
      }
    },
  );
});
