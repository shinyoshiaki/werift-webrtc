import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import type { Address, Transport } from "../../../common/src";
import {
  DtlsClient,
  DtlsServer,
  DtlsVersion,
  ProtocolVersionError,
} from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { AlertDesc, ContentType } from "../../src/record/const";
import { certPem, keyPem } from "../fixture";

import { createPlaintext } from "../../src/record/builder";

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
  /** When set, onData is invoked with this fake source (wrong-addr RX). */
  fakeRxAddr?: Address;
  onData: (data: Buffer, addr: Address) => void = () => {};
  private peer?: PeerAuthTransport;

  constructor(private readonly udp: UdpTransport) {
    udp.onData = (data) => {
      // Default: no source address — same as WebRTC IceTransport
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
    // Deliver to peer's UDP stack so rinfo is not required
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

/**
 * Peer-auth Options base: explicit peerIdentityMode (public API).
 * addressValidation "none" keeps DTLS 1.2 HelloVerify optional for addressless
 * ICE-like paths (same as ice-authenticated for 1.3 anti-amp; cookie still
 * works with peerKey "unknown" when dtls-cookie is default).
 */
const peerAuthOpts = {
  signatureHash: sig,
  peerIdentityMode: "authenticated-single-peer" as const,
  // ICE path: skip cookie / treat address as pre-validated (1.3 anti-amp).
  addressValidation: "ice-authenticated" as const,
};

async function peerAuthTransports() {
  const u1 = await UdpTransport.init("udp4");
  const u2 = await UdpTransport.init("udp4");
  const t1 = new PeerAuthTransport(u1);
  const t2 = new PeerAuthTransport(u2);
  t1.link(t2);
  t2.link(t1);
  return { t1, t2 };
}

async function connectPeerAuthPair() {
  const { t1, t2 } = await peerAuthTransports();

  const server = new DtlsServer({
    transport: t1,
    cert: certPem,
    key: keyPem,
    ...peerAuthOpts,
  });
  const client = new DtlsClient({
    transport: t2,
    cert: certPem,
    key: keyPem,
    ...peerAuthOpts,
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

test("e2e/self12: peerIdentityMode authenticated-single-peer is public and resolved", async () => {
  // Arrange: explicit Options.peerIdentityMode (not only transport flag inference)
  const { t1, t2 } = await peerAuthTransports();
  const server = new DtlsServer({
    transport: t1,
    cert: certPem,
    key: keyPem,
    ...peerAuthOpts,
  });
  const client = new DtlsClient({
    transport: t2,
    cert: certPem,
    key: keyPem,
    ...peerAuthOpts,
  });

  // Assert: public getter exposes fixed mode without connecting
  expect(client.peerIdentityMode).toBe("authenticated-single-peer");
  expect(server.peerIdentityMode).toBe("authenticated-single-peer");
  // datagram-address when omitted and no peerAuthenticated
  const plain = await UdpTransport.init("udp4");
  const plainClient = new DtlsClient({
    transport: plain,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    peerIdentityMode: "datagram-address",
  });
  expect(plainClient.peerIdentityMode).toBe("datagram-address");

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
  try {
    plainClient.close();
  } catch {
    /* */
  }
  await t1.close().catch(() => {});
  await t2.close().catch(() => {});
  await plain.close().catch(() => {});
});

/**
 * Ticket B required: version mismatch on addressless authenticated transport
 * must surface ProtocolVersionError (not hang on retransmit timeout).
 *
 * 1.2-only client × 1.3-only server: server rejects with protocol_version /
 * ProtocolVersionError under peerIdentityMode authenticated-single-peer.
 */
test("e2e/peerAuth: 1.2-only client vs 1.3-only server → ProtocolVersionError", async () => {
  // Arrange: same PeerAuthTransport fixture as lifecycle tests
  const { t1, t2 } = await peerAuthTransports();
  const server = new DtlsServer({
    transport: t1,
    cert: certPem,
    key: keyPem,
    ...peerAuthOpts,
    protocolVersions: [DtlsVersion.V1_3],
  });
  const client = new DtlsClient({
    transport: t2,
    cert: certPem,
    key: keyPem,
    ...peerAuthOpts,
    protocolVersions: [DtlsVersion.V1_2],
  });

  // Act / Assert: mismatch is actionable error (timeout would fail this test)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("expected ProtocolVersionError, got timeout")),
      12_000,
    );
    const onErr = (e: Error) => {
      clearTimeout(timer);
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
      if (
        e instanceof ProtocolVersionError ||
        e.name === "ProtocolVersionError" ||
        /protocol_version|protocol version|no overlapping/i.test(e.message)
      ) {
        expect(client.connected).toBe(false);
        resolve();
        return;
      }
      reject(
        new Error(`expected ProtocolVersionError, got ${e.name}: ${e.message}`),
      );
    };
    client.onError.subscribe(onErr);
    server.onError.subscribe(onErr);
    client.onConnect.subscribe(() => {
      clearTimeout(timer);
      reject(new Error("should not connect 1.2-only to 1.3-only on peerAuth"));
    });
    void client.connect().catch((e) => onErr(e as Error));
  });

  await t1.close().catch(() => {});
  await t2.close().catch(() => {});
}, 15_000);

/**
 * Reverse of the 1.2-only client × 1.3-only server case: ICE-like
 * authenticated-single-peer must make the *server* terminal too.
 * UDP pin is never set on this transport, so version-error paths that
 * still key off transport.pinnedPeer would leave the server listening.
 */
test("e2e/peerAuth: 1.3-only client vs 1.2-only server → both ProtocolVersionError", async () => {
  // Arrange: addressless peer-auth, 1.3-only client / 1.2-only server
  const { t1, t2 } = await peerAuthTransports();
  const server = new DtlsServer({
    transport: t1,
    cert: certPem,
    key: keyPem,
    ...peerAuthOpts,
    protocolVersions: [DtlsVersion.V1_2],
  });
  const client = new DtlsClient({
    transport: t2,
    cert: certPem,
    key: keyPem,
    ...peerAuthOpts,
    protocolVersions: [DtlsVersion.V1_3],
  });

  const isPv = (e: Error) =>
    e instanceof ProtocolVersionError ||
    e.name === "ProtocolVersionError" ||
    /protocol_version|protocol version|DTLS 1\.2-only|only DTLS 1\.3/i.test(
      e.message,
    );

  const clientErrors: Error[] = [];
  const serverErrors: Error[] = [];

  // Act: 双方が ProtocolVersionError で終わるまで待つ（片側だけでは不十分）
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `expected both ProtocolVersionError; client=${clientErrors.map((e) => e.message).join(" | ") || "(none)"} server=${serverErrors.map((e) => e.message).join(" | ") || "(none)"}`,
        ),
      );
    }, 12_000);
    const maybeDone = () => {
      if (clientErrors.length > 0 && serverErrors.length > 0) {
        clearTimeout(timer);
        resolve();
      }
    };
    client.onError.subscribe((e) => {
      clientErrors.push(e);
      maybeDone();
    });
    server.onError.subscribe((e) => {
      serverErrors.push(e);
      maybeDone();
    });
    client.onConnect.subscribe(() => {
      clearTimeout(timer);
      reject(new Error("should not connect 1.3-only to 1.2-only on peerAuth"));
    });
    server.onConnect.subscribe(() => {
      clearTimeout(timer);
      reject(new Error("1.2-only server must not connect to 1.3-only client"));
    });
    void client.connect().catch((e) => {
      clientErrors.push(e as Error);
      maybeDone();
    });
  });

  // Assert: 双方が version error、server は terminal、pending timer なし
  expect(isPv(clientErrors[0])).toBe(true);
  expect(isPv(serverErrors[0])).toBe(true);
  expect(server.connected).toBe(false);
  expect((server as any).associationTornDown).toBe(true);
  expect((server as any).dtls.flightTimers.size).toBe(0);
  expect((server as any).transport.pinnedPeer).toBeUndefined();

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
}, 15_000);

/**
 * Ticket B required: dual [1.3,1.2] on peer-auth transport falls back to 1.2
 * and completes handshake + app data without UDP addresses.
 */
test("e2e/peerAuth: dual [1.3,1.2] client → 1.2-only server completes", async () => {
  // Arrange
  const { t1, t2 } = await peerAuthTransports();
  const server = new DtlsServer({
    transport: t1,
    cert: certPem,
    key: keyPem,
    ...peerAuthOpts,
    protocolVersions: [DtlsVersion.V1_2],
  });
  const client = new DtlsClient({
    transport: t2,
    cert: certPem,
    key: keyPem,
    ...peerAuthOpts,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });

  // Act: dual client falls back to 1.2 on addressless peer-auth path
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("dual fallback timeout")),
      20_000,
    );
    let clientOk = false;
    let serverOk = false;
    const maybeDone = () => {
      if (clientOk && serverOk) {
        clearTimeout(t);
        resolve();
      }
    };
    client.onConnect.subscribe(() => {
      clientOk = true;
      maybeDone();
    });
    server.onConnect.subscribe(() => {
      serverOk = true;
      maybeDone();
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

  // Assert: 1.2 association (not 1.3 engine)
  expect(client.connected).toBe(true);
  expect(server.connected).toBe(true);
  expect(client.isDtls13).toBe(false);
  expect(client.peerIdentityMode).toBe("authenticated-single-peer");

  // Protected app data still works addressless
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("app data timeout")), 5_000);
    server.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("peer-auth-dual-12");
        clearTimeout(t);
        resolve();
      } catch (e) {
        clearTimeout(t);
        reject(e);
      }
    });
    void client.send(Buffer.from("peer-auth-dual-12"));
  });

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

/**
 * After dual → 1.2 the 1.3 candidate is gone. isAssociationPeer must still
 * treat authenticated-single-peer as transport identity (alternate 5-tuple
 * and addressless RX). Old code required dualAssociationPeerKey match.
 */
test("e2e/peerAuth: dual→1.2 accepts alternate-addr RX after 1.3 candidate gone", async () => {
  // Arrange
  const { t1, t2 } = await peerAuthTransports();
  const server = new DtlsServer({
    transport: t1,
    cert: certPem,
    key: keyPem,
    ...peerAuthOpts,
    protocolVersions: [DtlsVersion.V1_2],
  });
  const client = new DtlsClient({
    transport: t2,
    cert: certPem,
    key: keyPem,
    ...peerAuthOpts,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("dual fallback timeout")),
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

  expect(client.isDtls13).toBe(false);
  expect((client as any).engine13).toBeUndefined();
  expect((client as any).parkedEngine13).toBeUndefined();

  // Force a concrete pin key so the old fallback (`key === expected`) would drop
  (client as any).dualAssociationPeerKey = "192.0.2.1:1111";
  const spoof: Address = ["203.0.113.50", 44444];
  // Act: dispatcher peer gate after commit12
  expect((client as any).isAssociationPeer(undefined)).toBe(true);
  expect((client as any).isAssociationPeer(spoof)).toBe(true);

  // Act/Assert: wire-level app data from a different fake 5-tuple
  t2.fakeRxAddr = spoof;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("alt-addr app data timeout")),
      5_000,
    );
    client.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("peer-auth-alt-addr");
        clearTimeout(t);
        resolve();
      } catch (e) {
        clearTimeout(t);
        reject(e);
      }
    });
    void server.send(Buffer.from("peer-auth-alt-addr"));
  });

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

test("e2e/peerAuth: datagram-address isAssociationPeer rejects non-pin after 1.3 candidate gone", async () => {
  // Arrange: 1.2-only client (no engine13) with explicit datagram-address
  const { t1, t2 } = await peerAuthTransports();
  const client = new DtlsClient({
    transport: t2,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    peerIdentityMode: "datagram-address",
    addressValidation: "none",
    protocolVersions: [DtlsVersion.V1_2],
  });
  expect(client.peerIdentityMode).toBe("datagram-address");
  expect((client as any).engine13).toBeUndefined();

  // Act/Assert: fallback gate (no 1.3 candidate) is 5-tuple pin
  (client as any).dualAssociationPeerKey = "192.0.2.1:1111";
  expect((client as any).isAssociationPeer(undefined)).toBe(false);
  expect((client as any).isAssociationPeer(["203.0.113.50", 44444])).toBe(
    false,
  );
  expect((client as any).isAssociationPeer(["192.0.2.1", 1111])).toBe(true);

  try {
    client.close();
  } catch {
    /* */
  }
  await t1.close().catch(() => {});
  await t2.close().catch(() => {});
});

test("e2e/self12: peerAuthenticated transport app data + local close + epoch-0 ignore", async () => {
  // Arrange: ICE-like addressless path
  const { client, server, t1, t2 } = await connectPeerAuthPair();
  expect((client as any).hasAssociationPeerAuth()).toBe(true);
  expect(client.peerIdentityMode).toBe("authenticated-single-peer");

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
