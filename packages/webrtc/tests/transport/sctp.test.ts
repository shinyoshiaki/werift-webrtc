import { vi } from "vitest";

import { SCTP_STATE } from "../../../sctp/src";
import { Event, RTCDataChannel, RTCSctpTransport } from "../../src";
import { RTCDataChannelParameters } from "../../src/dataChannel";
import { dtlsTransportPair } from "../fixture";

describe("RTCSctpTransportTest", () => {
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

  test("INIT 送信失敗を reject し、次の start で association を再構築する", async () => {
    // Arrange: DTLS bridge の最初の送信だけ失敗させる。
    const sendData = vi
      .fn<(...args: [Buffer]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("INIT send failed"))
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
});
