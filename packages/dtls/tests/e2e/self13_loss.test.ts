import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { DtlsAck } from "../../src/handshake/message/tls13/ack";
import { certPem, keyPem } from "../fixture";

/**
 * Loss / reorder / duplicate helpers wrap the peer transport to drop or
 * reorder the first N handshake datagrams.
 */
function wrapTransport(
  transport: Awaited<ReturnType<typeof UdpTransport.init>>,
  mode: "drop-first" | "duplicate" | "none",
) {
  const originalSend = transport.send.bind(transport);
  let sent = 0;
  transport.send = async (buf: Buffer, addr?: any) => {
    sent++;
    if (mode === "drop-first" && sent === 1) {
      // 最初の ClientHello を落とす → 再送で回復
      return;
    }
    if (mode === "duplicate") {
      await originalSend(buf, addr);
      await originalSend(buf, addr);
      return;
    }
    await originalSend(buf, addr);
  };
  return transport;
}

test(
  "e2e/self13 recovers from first ClientHello loss",
  async () => {
    // Arrange
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = wrapTransport(
      await UdpTransport.init("udp4"),
      "drop-first",
    );
    clientTransport.rinfo = serverTransport.address;

    const opts = {
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3] as const,
      addressValidation: "none" as const,
    };
    const server = new DtlsServer({ transport: serverTransport, ...opts });
    const client = new DtlsClient({ transport: clientTransport, ...opts });

    // Act / Assert
    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("loss timeout")), 20_000);
      client.onConnect.subscribe(() => {
        void client.send(Buffer.from("after-loss"));
      });
      server.onData.subscribe((d) => {
        expect(d.toString()).toBe("after-loss");
        clearTimeout(timer);
        client.close();
        server.close();
        resolve();
      });
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      await client.connect();
    });
  },
  25_000,
);

test(
  "e2e/self13 tolerates duplicate ClientHello datagrams",
  async () => {
    // Arrange
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = wrapTransport(
      await UdpTransport.init("udp4"),
      "duplicate",
    );
    clientTransport.rinfo = serverTransport.address;

    const opts = {
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3] as const,
      addressValidation: "none" as const,
    };
    const server = new DtlsServer({ transport: serverTransport, ...opts });
    const client = new DtlsClient({ transport: clientTransport, ...opts });

    // Act / Assert
    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("duplicate timeout")),
        15_000,
      );
      client.onConnect.subscribe(() => {
        clearTimeout(timer);
        client.close();
        server.close();
        resolve();
      });
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      await client.connect();
    });
  },
  20_000,
);

test(
  "ACK codec roundtrip for record numbers",
  () => {
    // Arrange
    const ack = new DtlsAck([
      { epoch: 2, sequenceNumber: 0 },
      { epoch: 2, sequenceNumber: 1 },
    ]);
    // Act
    const wire = ack.serialize();
    const parsed = DtlsAck.deSerialize(wire);
    // Assert
    expect(parsed.recordNumbers).toEqual([
      { epoch: 2, sequenceNumber: 0 },
      { epoch: 2, sequenceNumber: 1 },
    ]);
  },
);
