import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../../common/src";
import { DtlsVersion } from "../../../src";
import { DirectHandshakeCarrier } from "../../../src/carrier/direct";
import { spedNotifySources } from "../../../src/engine/v1_3/flight-tx";
import { HandshakeType } from "../../../src/handshake/const";
import {
  createDtlsClientInternal,
  createDtlsServerInternal,
  refragmentPendingFlightIfNeeded,
} from "../../../src/internal";
import { ContentType } from "../../../src/record/const";
import { certPem, keyPem } from "../../fixture";

function serverHelloPlaintextEnd(packet: Buffer): number | undefined {
  if (packet.length < 13) {
    return undefined;
  }
  if (packet[0] !== ContentType.handshake) {
    return undefined;
  }
  if (packet.readUInt16BE(3) !== 0) {
    return undefined;
  }
  const recordLength = packet.readUInt16BE(11);
  const end = 13 + recordLength;
  if (end > packet.length) {
    return undefined;
  }
  if (packet[13] !== HandshakeType.server_hello_2) {
    return undefined;
  }
  return end;
}

function countEpoch0ServerHelloRecords(packet: Buffer): number {
  let pos = 0;
  let count = 0;
  while (pos + 13 <= packet.length) {
    if (packet[pos] !== ContentType.handshake) {
      break;
    }
    const epoch = packet.readUInt16BE(pos + 3);
    const recordLength = packet.readUInt16BE(pos + 11);
    const end = pos + 13 + recordLength;
    if (end > packet.length) {
      break;
    }
    if (epoch === 0 && packet[pos + 13] === HandshakeType.server_hello_2) {
      count++;
    }
    pos = end;
  }
  return count;
}

describe("SPED notify sources / combined ServerHello re-fragment", () => {
  test("spedNotifySources は SH+first が MTU に入るときだけ結合する", () => {
    // Arrange
    const serverHello = Buffer.alloc(40, 1);
    const first = Buffer.alloc(30, 2);
    const rest = Buffer.alloc(10, 3);

    // Act
    const combined = spedNotifySources(serverHello, [first, rest], 80);
    const split = spedNotifySources(serverHello, [first, rest], 69);

    // Assert: 合計 70 は 80 に入り、69 では SH と first を分ける
    expect(combined).toHaveLength(2);
    expect(combined[0]!.equals(Buffer.concat([serverHello, first]))).toBe(true);
    expect(split).toHaveLength(3);
    expect(split[0]!.equals(serverHello)).toBe(true);
    expect(split[1]!.equals(first)).toBe(true);
  });

  test("spedNotifySources は複数 SH datagram を結合しない", () => {
    // Arrange
    const sh1 = Buffer.alloc(40, 1);
    const sh2 = Buffer.alloc(40, 2);
    const first = Buffer.alloc(20, 3);

    // Act
    const sources = spedNotifySources([sh1, sh2], [first], 200);

    // Assert
    expect(sources).toHaveLength(3);
    expect(sources[0]!.equals(sh1)).toBe(true);
    expect(sources[1]!.equals(sh2)).toBe(true);
    expect(sources[2]!.equals(first)).toBe(true);
  });

  test("実 server flight の SH 単体が新 MTU を超えると SH を複数 datagram に分割する", async () => {
    // Arrange: 大きい MTU で実 DTLS 1.3 server flight を作る
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;
    const largeMtu = 1500;
    const serverCarrier = new DirectHandshakeCarrier(serverTransport, {
      mtu: largeMtu,
    });
    const clientCarrier = new DirectHandshakeCarrier(clientTransport, {
      mtu: largeMtu,
    });
    const notifyFlights: Buffer[][] = [];
    let shrunkMtu: number | undefined;
    const server = createDtlsServerInternal({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      handshakeCarrier: serverCarrier,
    });
    const client = createDtlsClientInternal({
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      handshakeCarrier: clientCarrier,
    });
    let shrinkError: Error | undefined;
    serverCarrier.events.onFlightCreated = (_flightId, packets) => {
      notifyFlights.push(packets.map((packet) => Buffer.from(packet.bytes)));
      if (shrunkMtu != null) {
        return;
      }
      queueMicrotask(() => {
        if (shrunkMtu != null) {
          return;
        }
        const engine = (
          server as unknown as {
            engine13?: {
              pendingServerHello?: { bytes: Buffer };
              pendingFlight: { bytes: Buffer }[];
              pendingFlightSource?: unknown;
            };
          }
        ).engine13;
        const serverHello = engine?.pendingServerHello?.bytes;
        const first = engine?.pendingFlight[0]?.bytes;
        if (!engine?.pendingFlightSource || !serverHello || !first) {
          return;
        }
        const combined = serverHello.length + first.length;
        const newMtu = combined - 1;
        if (serverHello.length > newMtu || first.length > newMtu) {
          return;
        }
        const latest = notifyFlights.at(-1)?.[0];
        if (!latest || latest.length !== combined) {
          return;
        }
        try {
          // Act: 各半面は入るが結合 L1 だけが超えるサイズへ縮めて re-fragment
          // pendingFlightSource は onFlightCreated の直後に入るので microtask で触る
          shrunkMtu = newMtu;
          serverCarrier.setMtu(newMtu);
          expect(refragmentPendingFlightIfNeeded(server)).toBe(true);
        } catch (error) {
          shrinkError = error as Error;
        }
      });
    };

    try {
      await new Promise<void>(async (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("combined SH re-fragment handshake timeout")),
          15_000,
        );
        client.onError.subscribe((error) => {
          clearTimeout(timer);
          reject(error);
        });
        server.onError.subscribe((error) => {
          clearTimeout(timer);
          reject(error);
        });
        client.onConnect.subscribe(() => {
          clearTimeout(timer);
          resolve();
        });
        await client.connect();
      });
      if (shrinkError) {
        throw shrinkError;
      }

      // Assert: 縮退後の notify はすべて新 MTU 以下で、先頭は SH 単体
      expect(shrunkMtu).toBeDefined();
      const after = notifyFlights.at(-1);
      expect(after).toBeDefined();
      expect(after!.length).toBeGreaterThan(1);
      expect(after!.every((packet) => packet.length <= shrunkMtu!)).toBe(true);
      const shEnd = serverHelloPlaintextEnd(after![0]!);
      expect(shEnd).toBe(after![0]!.length);
    } finally {
      client.close();
      server.close();
      await clientTransport.close();
      await serverTransport.close();
    }
  }, 20_000);

  test("実 server flight の SH 単体が新 MTU を超えると SH を複数 datagram に分割する", async () => {
    // Arrange: 大きい MTU で実 DTLS 1.3 server flight を作る
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;
    const largeMtu = 1500;
    const serverCarrier = new DirectHandshakeCarrier(serverTransport, {
      mtu: largeMtu,
    });
    const clientCarrier = new DirectHandshakeCarrier(clientTransport, {
      mtu: largeMtu,
    });
    const notifyFlights: Buffer[][] = [];
    let shrunkMtu: number | undefined;
    let originalSh = 0;
    const server = createDtlsServerInternal({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      handshakeCarrier: serverCarrier,
    });
    const client = createDtlsClientInternal({
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      handshakeCarrier: clientCarrier,
    });
    let shrinkError: Error | undefined;
    serverCarrier.events.onFlightCreated = (_flightId, packets) => {
      notifyFlights.push(packets.map((packet) => Buffer.from(packet.bytes)));
      if (shrunkMtu != null) {
        return;
      }
      queueMicrotask(() => {
        if (shrunkMtu != null) {
          return;
        }
        const engine = (
          server as unknown as {
            engine13?: {
              pendingServerHello?: { bytes: Buffer };
              pendingServerHelloSource?: unknown;
              pendingFlightSource?: unknown;
            };
          }
        ).engine13;
        const serverHello = engine?.pendingServerHello?.bytes;
        if (
          !engine?.pendingFlightSource ||
          !engine.pendingServerHelloSource ||
          !serverHello
        ) {
          return;
        }
        const newMtu = serverHello.length - 1;
        if (newMtu < 40) {
          return;
        }
        try {
          // Act: SH 単体が新 MTU を超える（epoch0 断片化下限以上）まで縮小
          originalSh = serverHello.length;
          shrunkMtu = newMtu;
          serverCarrier.setMtu(newMtu);
          expect(refragmentPendingFlightIfNeeded(server)).toBe(true);
        } catch (error) {
          shrinkError = error as Error;
        }
      });
    };

    try {
      await new Promise<void>(async (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("SH-oversize re-fragment handshake timeout")),
          15_000,
        );
        client.onError.subscribe((error) => {
          clearTimeout(timer);
          reject(error);
        });
        server.onError.subscribe((error) => {
          clearTimeout(timer);
          reject(error);
        });
        client.onConnect.subscribe(() => {
          clearTimeout(timer);
          resolve();
        });
        await client.connect();
      });
      if (shrinkError) {
        throw shrinkError;
      }

      // Assert: notify はすべて新 MTU 以下で、SH が複数 record に割れている
      expect(shrunkMtu).toBeDefined();
      expect(originalSh).toBeGreaterThan(shrunkMtu!);
      const after = notifyFlights.at(-1);
      expect(after).toBeDefined();
      expect(after!.every((packet) => packet.length <= shrunkMtu!)).toBe(true);
      const shRecords = after!.reduce(
        (n, packet) => n + countEpoch0ServerHelloRecords(packet),
        0,
      );
      expect(shRecords).toBeGreaterThan(1);
    } finally {
      client.close();
      server.close();
      await clientTransport.close();
      await serverTransport.close();
    }
  }, 20_000);
});
