import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import type { Address, Transport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { AlertDesc, ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

/**
 * Addressless but peer-authenticated transport (ICE-like): no rinfo, no addr
 * on onData — DTLS must still treat AEAD alerts as association-lifecycle.
 */
class PeerAuthTransport implements Transport {
  type = "ice";
  closed = false;
  readonly peerAuthenticated = true;
  onData: (data: Buffer, addr: Address) => void = () => {};
  private peer?: PeerAuthTransport;

  constructor(private readonly udp: UdpTransport) {
    udp.onData = (data) => {
      // No source address — same as WebRTC IceTransport
      this.onData(data, undefined as any);
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
    // Deliver to peer's UDP stack so rinfo is not required
    const p = this.peer;
    queueMicrotask(() => {
      if (!p.closed) p.onData(data, undefined as any);
    });
  };

  close = async () => {
    this.closed = true;
    await this.udp.close().catch(() => {});
  };
}

async function connectPeerAuthPair() {
  const u1 = await UdpTransport.init("udp4");
  const u2 = await UdpTransport.init("udp4");
  const t1 = new PeerAuthTransport(u1);
  const t2 = new PeerAuthTransport(u2);
  t1.link(t2);
  t2.link(t1);

  const server = new DtlsServer({
    transport: t1,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });
  const client = new DtlsClient({
    transport: t2,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 20_000);
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

test("e2e/self12: peerAuthenticated transport treats protected fatal as terminal", async () => {
  // Arrange: ICE-like transport, pure 1.2 connected
  const { client, server, t1, t2 } = await connectPeerAuthPair();
  expect(client.connected).toBe(true);
  expect(server.connected).toBe(true);
  // No UDP pin required when peerAuthenticated
  expect((server as any).hasAssociationPeerAuth()).toBe(true);

  const errors: Error[] = [];
  client.onError.subscribe((e) => errors.push(e));

  // Act: inject epoch-1 shaped fatal is hard without keys; use peer's real
  // encrypt path — send fatal from server after connect via cipher.
  // Simpler: server.reportLegacy12Fatal style via protected alert from server socket.
  // Build alert and encrypt with server write keys (epoch 1 after HS).
  const alertBody = Buffer.from([2, AlertDesc.InternalError]); // fatal
  // Use server internal encrypt if available
  const dtls = (server as any).dtls;
  const cipher = (server as any).cipher;
  const { createPlaintext } = await import("../../src/record/builder");
  const pkt = createPlaintext(dtls)(
    [{ type: ContentType.alert, fragment: alertBody }],
    ++dtls.recordSequenceNumber,
  )[0];
  const wire = cipher.encryptPacket(pkt).serialize();

  // Deliver to client without address (peerAuthenticated path)
  t2.onData(wire, undefined as any);

  await new Promise((r) => setTimeout(r, 50));

  // Assert: protected fatal surfaces (not pre-auth ignore)
  expect(errors.length).toBeGreaterThan(0);
  expect(errors[0].message).toMatch(/alert|fatal|InternalError/i);
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

test("e2e/self12: peerAuthenticated transport delivers protected close_notify", async () => {
  const { client, server, t1, t2 } = await connectPeerAuthPair();

  const closes: number[] = [];
  client.onClose.subscribe(() => closes.push(Date.now()));

  const dtls = (server as any).dtls;
  const cipher = (server as any).cipher;
  const { createPlaintext } = await import("../../src/record/builder");
  const alertBody = Buffer.from([1, AlertDesc.CloseNotify]); // warning close_notify
  const pkt = createPlaintext(dtls)(
    [{ type: ContentType.alert, fragment: alertBody }],
    ++dtls.recordSequenceNumber,
  )[0];
  const wire = cipher.encryptPacket(pkt).serialize();
  t2.onData(wire, undefined as any);

  await new Promise((r) => setTimeout(r, 50));

  expect(closes.length).toBeGreaterThanOrEqual(1);

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

test("e2e/self12: peerAuthenticated transport app data + local close + epoch-0 ignore", async () => {
  // Arrange: ICE-like addressless path
  const { client, server, t1, t2 } = await connectPeerAuthPair();
  expect((client as any).hasAssociationPeerAuth()).toBe(true);

  // Act/Assert: protected app data bidirectional without UDP addresses
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("app data timeout")), 5_000);
    server.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("peer-auth-app");
        clearTimeout(t);
        resolve();
      } catch (e) {
        clearTimeout(t);
        reject(e);
      }
    });
    void client.send(Buffer.from("peer-auth-app"));
  });

  // Act: epoch-0 unauthenticated fatal must NOT tear down
  const errorsBefore = { n: 0 };
  client.onError.subscribe(() => {
    errorsBefore.n += 1;
  });
  const epoch0Fatal = Buffer.from([
    ContentType.alert,
    0xfe,
    0xfd,
    0,
    0, // epoch 0
    0,
    0,
    0,
    0,
    0,
    1, // seq
    0,
    2, // length
    2, // fatal
    AlertDesc.InternalError,
  ]);
  t2.onData(epoch0Fatal, undefined as any);
  await new Promise((r) => setTimeout(r, 30));
  expect(errorsBefore.n).toBe(0);
  expect((client as any).associationTornDown).toBe(false);
  expect(client.connected).toBe(true);

  // Act: local close → terminal, Public API rejects, onClose once
  const closes: number[] = [];
  client.onClose.subscribe(() => closes.push(1));
  server.onClose.subscribe(() => closes.push(1));
  client.close();
  await new Promise((r) => setTimeout(r, 50));
  expect((client as any).associationTornDown).toBe(true);
  await expect(client.send(Buffer.from("after-close"))).rejects.toThrow(
    /closed/i,
  );
  // Re-entrant close is idempotent
  client.close();
  expect(closes.length).toBeGreaterThanOrEqual(1);

  try {
    server.close();
  } catch {
    /* */
  }
  await t1.close().catch(() => {});
  await t2.close().catch(() => {});
}, 25_000);
