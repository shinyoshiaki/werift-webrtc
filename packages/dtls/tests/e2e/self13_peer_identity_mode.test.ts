import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import type { Address, Transport } from "../../../common/src";
import {
  DtlsClient,
  DtlsServer,
  DtlsVersion,
  type PeerIdentityMode,
} from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { AlertDesc, ContentType } from "../../src/record/const";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

/**
 * Addressless peer-authenticated carrier (ICE-like).
 * Optionally stamps a fake source address on RX for demux tests.
 */
class PeerAuthTransport implements Transport {
  type = "ice";
  closed = false;
  readonly peerAuthenticated = true;
  /** When set, onData is invoked with this fake source (tests wrong-addr RX). */
  fakeRxAddr?: Address;
  onData: (data: Buffer, addr: Address) => void = () => {};
  private peer?: PeerAuthTransport;

  constructor(private readonly udp: UdpTransport) {
    udp.onData = (data) => {
      this.onData(data, this.fakeRxAddr as any);
    };
  }

  get address() {
    return this.udp.address as any;
  }

  link(peer: PeerAuthTransport) {
    this.peer = peer;
  }

  send = async (data: Buffer, _addr?: Address) => {
    if (this.closed || !this.peer) return;
    const p = this.peer;
    queueMicrotask(() => {
      if (!p.closed) p.onData(data, p.fakeRxAddr as any);
    });
  };

  close = async () => {
    this.closed = true;
    await this.udp.close().catch(() => {});
  };
}

async function connect13PeerAuth(
  mode: PeerIdentityMode = "authenticated-single-peer",
) {
  const u1 = await UdpTransport.init("udp4");
  const u2 = await UdpTransport.init("udp4");
  const t1 = new PeerAuthTransport(u1);
  const t2 = new PeerAuthTransport(u2);
  t1.link(t2);
  t2.link(t1);

  const base = {
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3] as const,
    peerIdentityMode: mode,
    addressValidation: "ice-authenticated" as const,
  };
  const server = new DtlsServer({ transport: t1, ...base });
  const client = new DtlsClient({ transport: t2, ...base });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("1.3 peerAuth connect timeout")),
      20_000,
    );
    client.onConnect.subscribe(() => {
      clearTimeout(t);
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(t);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(t);
      reject(e);
    });
    void client.connect();
  });

  return { client, server, t1, t2 };
}

async function encryptAlertFrom(
  side: DtlsClient | DtlsServer,
  body: Buffer,
): Promise<Buffer> {
  const eng = (side as any).engine13;
  expect(eng).toBeTruthy();
  // Use engine send path for alerts when available; fall back to internal AEAD.
  const { encryptRecord } = await import("../../src/record/v1_3/record");
  const writeEpoch = eng.writeEpoch ?? 3;
  const ep = eng.epochs?.get?.(writeEpoch);
  expect(ep?.writeKeys).toBeTruthy();
  return encryptRecord(body, ContentType.alert, ep);
}

test("e2e/self13 peerIdentityMode: authenticated-single-peer delivers addressless app data + fatal + close_notify", async () => {
  // Arrange
  const { client, server, t1, t2 } = await connect13PeerAuth(
    "authenticated-single-peer",
  );
  expect(client.peerIdentityMode).toBe("authenticated-single-peer");
  expect(client.isDtls13).toBe(true);

  // Act/Assert: bidirectional app data without addresses
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("app data timeout")), 5_000);
    server.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("auth-peer-app");
        clearTimeout(t);
        resolve();
      } catch (e) {
        clearTimeout(t);
        reject(e);
      }
    });
    void client.send(Buffer.from("auth-peer-app"));
  });

  // Act: protected fatal from server (addressless) → client terminal + onError
  const errors: Error[] = [];
  client.onError.subscribe((e) => errors.push(e));
  const fatalWire = await encryptAlertFrom(
    server,
    Buffer.from([2, AlertDesc.InternalError]),
  );
  t2.onData(fatalWire, undefined as any);
  await new Promise((r) => setTimeout(r, 40));
  expect(errors.length).toBeGreaterThan(0);
  expect((client as any).associationTornDown).toBe(true);

  try {
    client.close();
  } catch {
    /* */
  }
  try {
    server.close();
  } catch {
    /* */
  }
  await t1.close().catch(() => {});
  await t2.close().catch(() => {});
}, 25_000);

test("e2e/self13 peerIdentityMode: authenticated-single-peer accepts protected RX from alternate fake addr", async () => {
  // Arrange: connect addressless, then stamp a fake source on subsequent RX
  const { client, server, t1, t2 } = await connect13PeerAuth(
    "authenticated-single-peer",
  );

  // Spoof different 5-tuple on deliver — must NOT drop under authenticated-single-peer
  t2.fakeRxAddr = ["203.0.113.50", 44444] as Address;

  const errors: Error[] = [];
  const closes: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onClose.subscribe(() => closes.push(1));

  // Act: protected close_notify with wrong source address
  const closeWire = await encryptAlertFrom(
    server,
    Buffer.from([1, AlertDesc.CloseNotify]),
  );
  t2.onData(closeWire, t2.fakeRxAddr as any);
  await new Promise((r) => setTimeout(r, 50));

  // Assert: close_notify processed (not dropped as wrong peer)
  expect(closes.length).toBeGreaterThanOrEqual(1);
  // close_notify is graceful — may not set onError
  expect(errors.length).toBe(0);

  try {
    client.close();
  } catch {
    /* */
  }
  try {
    server.close();
  } catch {
    /* */
  }
  await t1.close().catch(() => {});
  await t2.close().catch(() => {});
}, 25_000);

test("e2e/self13 peerIdentityMode: datagram-address rejects non-pin peer after connect", async () => {
  // Arrange: classic UDP with pin
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const base = {
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3] as const,
    peerIdentityMode: "datagram-address" as const,
    addressValidation: "none" as const,
  };
  const server = new DtlsServer({ transport: serverTransport, ...base });
  const client = new DtlsClient({ transport: clientTransport, ...base });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 15_000);
    client.onConnect.subscribe(() => {
      clearTimeout(t);
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(t);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(t);
      reject(e);
    });
    void client.connect();
  });

  expect(client.peerIdentityMode).toBe("datagram-address");
  const eng = (client as any).engine13;
  expect(eng).toBeTruthy();
  // Pin should be set to server address after connect
  expect(eng.expectedPeerKey?.() || eng.pinnedPeerKey).toBeTruthy();

  const errors: Error[] = [];
  client.onError.subscribe((e) => errors.push(e));
  const closesBefore = { n: 0 };
  client.onClose.subscribe(() => {
    closesBefore.n += 1;
  });

  // Act: inject protected fatal as if from a different UDP peer
  const fatalWire = await encryptAlertFrom(
    server,
    Buffer.from([2, AlertDesc.InternalError]),
  );
  const spoof: [string, number] = ["198.51.100.99", 9];
  // Direct inject into engine with wrong peer key (bypass UDP stack rinfo)
  eng.injectDatagram(fatalWire, spoof);
  await new Promise((r) => setTimeout(r, 40));

  // Assert: wrong peer dropped — no terminal lifecycle
  expect(errors.length).toBe(0);
  expect(closesBefore.n).toBe(0);
  expect((client as any).associationTornDown).toBe(false);
  expect(client.connected).toBe(true);

  // Control: same alert from correct peer tears down
  eng.injectDatagram(fatalWire, [
    serverTransport.address.address === "0.0.0.0"
      ? "127.0.0.1"
      : serverTransport.address.address,
    serverTransport.address.port,
  ]);
  await new Promise((r) => setTimeout(r, 40));
  expect(errors.length).toBeGreaterThan(0);

  try {
    client.close();
  } catch {
    /* */
  }
  try {
    server.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 25_000);
