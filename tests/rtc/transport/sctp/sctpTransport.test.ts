import { RTCSctpTransport } from "../../../../src";
import { dtlsTransportPair } from "../dtls/transport.test";
import {
  RTCDataChannel,
  RTCDataChannelParameters,
} from "../../../../src/rtc/dataChannel";
import { State } from "../../../../src/rtc/const";
import { range } from "lodash";
import { sleep } from "../../../../src/utils";
describe("RTCSctpTransportTest", () => {
  function trackChannels(transport: RTCSctpTransport) {
    const channels: RTCDataChannel[] = [];

    transport.datachannel.subscribe((channel) => {
      channels.push(channel);
    });

    return { channels, event: transport.datachannel };
  }

  async function waitForOutcome(
    client: RTCSctpTransport,
    server: RTCSctpTransport
  ) {
    const final = [State.ESTABLISHED, State.CLOSED];
    for (let i of range(100)) {
      if (
        final.includes(client.associationState) &&
        final.includes(server.associationState)
      )
        break;

      await sleep(100);
    }
  }

  test(
    "test_connect_then_client_creates_data_channel",
    async (done) => {
      const [clientTransport, serverTransport] = await dtlsTransportPair();

      const client = new RTCSctpTransport(clientTransport);
      const server = new RTCSctpTransport(serverTransport);

      // const clientChannels = trackChannels(client);
      const serverChannels = trackChannels(server);

      await Promise.all([server.start(client.port), client.start(server.port)]);

      await waitForOutcome(client, server);

      const channel = new RTCDataChannel(
        client,
        new RTCDataChannelParameters({ label: "chat", id: 1 })
      );
      channel.message.subscribe((data) => {
        expect(data.toString()).toBe("ping");
        done();
      });
      serverChannels.event.subscribe((channel) => {
        channel.send(Buffer.from("ping"));
      });
    },
    60 * 1000
  );
});
