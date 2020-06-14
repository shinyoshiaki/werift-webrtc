import { RTCSctpTransport } from "../../../src";
import { dtlsTransportPair } from "./dtls.test";
import {
  RTCDataChannel,
  RTCDataChannelParameters,
} from "../../../src/rtc/dataChannel";
import { range } from "lodash";
import { sleep } from "../../../src/utils";
import { SCTP_STATE } from "../../../src/vendor/sctp/const";

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
    for (let _ of range(100)) {
      if (
        SCTP_STATE.ESTABLISHED === client.sctp.associationState &&
        SCTP_STATE.ESTABLISHED === server.sctp.associationState
      ) {
        break;
      }

      await sleep(100);
    }
  }

  test(
    "test_connect_then_client_creates_data_channel",
    async (done) => {
      const [clientTransport, serverTransport] = await dtlsTransportPair();

      const client = new RTCSctpTransport(clientTransport);
      const server = new RTCSctpTransport(serverTransport);

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
        new RTCDataChannelParameters({ label: "chat", id: 1 })
      );
      channel.message.subscribe((data) => {
        expect(data.toString()).toBe("ping");
        channel.send(Buffer.from("pong"));
      });
    },
    60 * 1000
  );
});
