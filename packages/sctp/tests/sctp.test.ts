import { createSocket } from "dgram";
import { setTimeout } from "timers/promises";
import { SCTP, SCTP_STATE } from "../src";
import { StreamAddOutgoingParam } from "../src/param";
import { createUdpTransport } from "../src/transport";


describe("sctp", () => {
  test("test_connect_client_limits_streams", async () => {
    const port = 8799;

    const socket = createSocket("udp4");
    socket.bind(port);
    const server = SCTP.server(createUdpTransport(socket));

    const client = SCTP.client(
      createUdpTransport(createSocket("udp4"), {
        port,
        address: "127.0.0.1",
      })
    );

    client._inboundStreamsMax = 2048;
    client._outboundStreamsCount = 256;

    await Promise.all([client.start(5000), server.start(5000)]);
    await Promise.all([
      client.stateChanged.connected.asPromise(),
      server.stateChanged.connected.asPromise(),
    ]);

    expect(client.maxChannels).toBe(256);
    expect(client.associationState).toBe(SCTP_STATE.ESTABLISHED);
    expect(client._inboundStreamsCount).toBe(2048);
    expect(client._outboundStreamsCount).toBe(256);
    expect(client.remoteExtensions).toEqual([192, 130]);
    expect(server.associationState).toBe(SCTP_STATE.ESTABLISHED);
    expect(server._inboundStreamsCount).toBe(256);
    expect(server._outboundStreamsCount).toBe(2048);
    expect(server.remoteExtensions).toEqual([192, 130]);

    const param = new StreamAddOutgoingParam(client.reconfigRequestSeq, 16);
    await client.sendReconfigParam(param);
    await setTimeout(100);

    expect(server.maxChannels).toBe(272);
    expect(server._inboundStreamsCount).toBe(272);
    expect(server._outboundStreamsCount).toBe(2048);

    client.stop();

    await server.stateChanged.closed.asPromise();
    expect(client.associationState).toBe(SCTP_STATE.CLOSED);
    expect(server.associationState).toBe(SCTP_STATE.CLOSED);

    socket.close();
  });
});
