import { describe, it, expect } from "vitest";
import { randomPort } from "../../common/src";
import { SCTP, WEBRTC_PPID } from "../src";
import { createUdpTransport } from "../src/transport";
import { createSocket } from "node:dgram";

describe("integrate", () => {
  it("ping-pong", async () => {
    const clientPort = await randomPort();
    const serverPort = await randomPort();

    const client = SCTP.client(
      createUdpTransport(createSocket("udp4").bind(clientPort), {
        port: serverPort,
        address: "127.0.0.1",
      }),
    );
    const server = SCTP.server(
      createUdpTransport(createSocket("udp4").bind(serverPort), {
        port: clientPort,
        address: "127.0.0.1",
      }),
    );

    client.stateChanged.connected.once(() => {
      setInterval(() => {
        client.send(0, WEBRTC_PPID.STRING, Buffer.from("ping"));
      }, 100);
    });

    server.onReceive.subscribe((_, __, buf) => {
      expect(buf.toString()).toBe("ping");
      server.send(0, WEBRTC_PPID.STRING, Buffer.from("pong"));
    });

    await client.start();
    await server.start();

    await client.onReceive.watch((_, __, buf) => {
      return buf.toString() === "pong";
    });
  });
});
