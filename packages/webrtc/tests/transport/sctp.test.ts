import { RTCDataChannel, RTCSctpTransport } from "../../src";
import { RTCDataChannelParameters } from "../../src/dataChannel";
import { dtlsTransportPair } from "../fixture";

jest.setTimeout(10_000);

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
        channel.message.subscribe((data) => {
          expect(data.toString()).toBe("pong");
          done();
        });
      });

      const channel = new RTCDataChannel(
        client,
        new RTCDataChannelParameters({ label: "chat", id: 1 }),
      );
      channel.message.subscribe((data) => {
        expect(data.toString()).toBe("ping");
        channel.send(Buffer.from("pong"));
      });
    }));
});
