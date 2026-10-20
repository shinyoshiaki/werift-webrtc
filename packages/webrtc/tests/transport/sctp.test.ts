import { RTCDataChannel, RTCSctpTransport } from "../../src";
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
});
