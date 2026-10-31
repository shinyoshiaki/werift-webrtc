import { RTCDataChannel, RTCSctpTransport } from "../../src";
import { RTCDataChannelParameters } from "../../src/dataChannel";
import { dtlsTransportPair } from "../fixture";
import { DCEP_CHANNEL_TYPE_CASES } from "../utils";

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

  test.each(DCEP_CHANNEL_TYPE_CASES)(
    "DATA_CHANNEL_OPEN encodes $name",
    async ({ options, channelType, reliability }) => {
      // Arrange: SCTP association を確立し、client が送る DCEP を記録する。
      const [clientTransport, serverTransport] = await dtlsTransportPair();
      const client = new RTCSctpTransport();
      client.setDtlsTransport(clientTransport);
      const server = new RTCSctpTransport();
      server.setDtlsTransport(serverTransport);
      await Promise.all([server.start(client.port), client.start(server.port)]);
      await waitForOutcome(client, server);
      const dcep: Buffer[] = [];
      const send = client.sctp.send.bind(client.sctp);
      client.sctp.send = ((...args: Parameters<typeof send>) => {
        if (args[1] === 50) dcep.push(Buffer.from(args[2]));
        return send(...args);
      }) as typeof send;
      const remote = server.onDataChannel.asPromise();

      // Act: 指定の ordered / 部分信頼性でチャネルを作成し OPEN を送らせる。
      new RTCDataChannel(
        client,
        new RTCDataChannelParameters({ label: "dcep", id: 1, ...options }),
      );
      const [received] = await remote;

      // Assert: OPEN の Channel Type と reliability が RFC 8832 の値になる。
      expect(dcep).toHaveLength(1);
      expect(dcep[0].readUInt8(0)).toBe(3);
      expect(dcep[0].readUInt8(1)).toBe(channelType);
      expect(dcep[0].readUInt32BE(4)).toBe(reliability);
      // Assert: 受信側チャネルは送信側と同じ ordered / 部分信頼性を持つ。
      expect(received.ordered).toBe(options.ordered);
      expect(received.maxRetransmits).toBe(options.maxRetransmits ?? null);
      expect(received.maxPacketLifeTime).toBe(
        options.maxPacketLifeTime ?? null,
      );

      await Promise.all([client.stop(), server.stop()]);
    },
  );
});
