import { UdpTransport } from "../../../common/src";
import {
  DtlsClient,
  DtlsServer,
  DtlsVersion,
  ProtocolVersionError,
} from "../../src";
import { NamedCurveAlgorithm } from "../../src/cipher/const";
import { certPem, keyPem } from "../fixture";

const dtls13Options = {
  cert: certPem,
  key: keyPem,
  protocolVersions: [DtlsVersion.V1_3] as const,
  // Basic path tests use none; cookie path covered in dedicated tests
  addressValidation: "none" as const,
};

async function pair(extra?: {
  certificateRequest?: boolean;
  addressValidation?: "dtls-cookie" | "ice-authenticated" | "none";
}) {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const opts = {
    ...dtls13Options,
    ...extra,
  };
  const server = new DtlsServer({
    transport: serverTransport,
    ...opts,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    ...opts,
  });
  return { server, client, serverTransport, clientTransport };
}

test("e2e/self13 full handshake bidirectional data", async () => {
  // Arrange
  const { server, client } = await pair();
  const word = "dtls13";

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("self13 handshake timeout")),
      15_000,
    );

    // Act
    server.onData.subscribe((data) => {
      // Assert: サーバがアプリデータを受信
      expect(data.toString()).toBe(word);
      void server.send(Buffer.from(word + "_server"));
    });
    client.onData.subscribe((data) => {
      // Assert: クライアントが応答を受信
      expect(data.toString()).toBe(word + "_server");
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
    client.onConnect.subscribe(() => {
      void client.send(Buffer.from(word));
    });

    await client.connect();
  });
}, 20_000);

test("e2e/self13 KeyUpdate then bidirectional data", async () => {
  // Arrange
  const { server, client } = await pair();

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("keyupdate timeout")),
      15_000,
    );
    let phase: "pre" | "post" = "pre";

    server.onData.subscribe((data) => {
      if (phase === "pre") {
        // Assert: KeyUpdate 前
        expect(data.toString()).toBe("before");
        void server.send(Buffer.from("before_ack"));
      } else {
        // Assert: KeyUpdate 後も通信可能
        expect(data.toString()).toBe("after");
        void server.send(Buffer.from("after_ack"));
      }
    });

    client.onConnect.subscribe(async () => {
      try {
        await client.send(Buffer.from("before"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });

    let gotBefore = false;
    client.onData.subscribe(async (data) => {
      try {
        if (!gotBefore) {
          expect(data.toString()).toBe("before_ack");
          gotBefore = true;
          phase = "post";
          // Act: KeyUpdate
          await client.keyUpdate(false);
          // 相手の受信 epoch 更新のため少し待つ
          await new Promise((r) => setTimeout(r, 100));
          await client.send(Buffer.from("after"));
        } else {
          expect(data.toString()).toBe("after_ack");
          clearTimeout(timer);
          client.close();
          server.close();
          resolve();
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
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
}, 20_000);

test("e2e/self13 exporter EXTRACTOR-dtls_srtp matches both sides", async () => {
  // Arrange
  const { server, client } = await pair();

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("exporter timeout")),
      15_000,
    );

    const check = () => {
      if (!client.connected || !server.connected) return;
      // Act
      const c = client.exportKeyingMaterial("EXTRACTOR-dtls_srtp", 60);
      const s = server.exportKeyingMaterial("EXTRACTOR-dtls_srtp", 60);
      // Assert
      expect(c.equals(s)).toBe(true);
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    };

    client.onConnect.subscribe(check);
    server.onConnect.subscribe(check);
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
}, 20_000);

test("e2e/self13 1.3-only client vs 1.2-only server fails with ProtocolVersionError", async () => {
  // Arrange
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const { HashAlgorithm, SignatureAlgorithm } = await import(
    "../../src/cipher/const"
  );
  const sig = {
    hash: HashAlgorithm.sha256_4,
    signature: SignatureAlgorithm.rsa_1,
  };

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_2],
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3],
    addressValidation: "none",
  });

  // Act / Assert: HelloVerifyRequest → ProtocolVersionError（timeout ではない）
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("expected ProtocolVersionError, got timeout")),
      8_000,
    );

    const onErr = (e: Error) => {
      clearTimeout(timer);
      client.close();
      server.close();
      if (
        e instanceof ProtocolVersionError ||
        e.name === "ProtocolVersionError" ||
        /protocol version|HelloVerifyRequest|DTLS 1\.2-only/i.test(e.message)
      ) {
        resolve();
        return;
      }
      reject(
        new Error(`expected ProtocolVersionError, got ${e.name}: ${e.message}`),
      );
    };

    client.onError.subscribe(onErr);
    client.onConnect.subscribe(() => {
      clearTimeout(timer);
      reject(new Error("should not connect 1.3-only to 1.2-only"));
    });

    try {
      await client.connect();
    } catch (e) {
      onErr(e as Error);
    }
  });
}, 12_000);

test("e2e/self13 1.2-only client vs 1.3-only server fails with protocol version error", async () => {
  // Arrange
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const { HashAlgorithm, SignatureAlgorithm } = await import(
    "../../src/cipher/const"
  );
  const sig = {
    hash: HashAlgorithm.sha256_4,
    signature: SignatureAlgorithm.rsa_1,
  };

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3],
    addressValidation: "none",
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_2],
  });

  // Act / Assert: server が protocol_version alert / ProtocolVersionError
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("expected version error, got timeout")),
      8_000,
    );
    const done = (e: Error) => {
      clearTimeout(timer);
      client.close();
      server.close();
      if (
        e instanceof ProtocolVersionError ||
        e.name === "ProtocolVersionError" ||
        /protocol version|cipher suite|1\.3/i.test(e.message)
      ) {
        resolve();
        return;
      }
      // 1.2 client may fail with flight timeout after server rejects — still not silent success
      if (/timeout|retransmit|over retransmit/i.test(e.message)) {
        // Prefer explicit version path; still fail the soft timeout case
        reject(
          new Error(
            `got timeout-like error, want protocol version: ${e.message}`,
          ),
        );
        return;
      }
      reject(new Error(`unexpected error: ${e.message}`));
    };
    server.onError.subscribe(done);
    client.onError.subscribe(done);
    client.onConnect.subscribe(() => {
      clearTimeout(timer);
      reject(new Error("should not connect 1.2-only to 1.3-only"));
    });
    try {
      await client.connect();
    } catch (e) {
      done(e as Error);
    }
  });
}, 12_000);

test("e2e/self13 mutual auth with CertificateRequest", async () => {
  // Arrange
  const { server, client } = await pair({ certificateRequest: true });
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("mutual auth timeout")),
      15_000,
    );
    client.onConnect.subscribe(() => {
      void client.send(Buffer.from("mutual"));
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("mutual");
      // Assert: 相互証明書
      expect(server.remoteCertificate?.length).toBeGreaterThan(0);
      expect(client.remoteCertificate?.length).toBeGreaterThan(0);
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
    // Act
    await client.connect();
  });
}, 20_000);

test("e2e/self13 dtls-cookie address validation completes handshake", async () => {
  // Arrange: default cookie path
  const { server, client } = await pair({
    addressValidation: "dtls-cookie",
  });
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("cookie handshake timeout")),
      15_000,
    );
    client.onConnect.subscribe(() => {
      void client.send(Buffer.from("cookie-ok"));
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("cookie-ok");
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
    // Act
    await client.connect();
  });
}, 20_000);

test(
  "e2e/self13 cookie + key_share group mismatch completes via combined HRR",
  async () => {
    // Arrange: server X25519 only, client P-256 only → single HRR with cookie+group
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "dtls-cookie",
      namedGroups: [NamedCurveAlgorithm.x25519_29],
    });
    const client = new DtlsClient({
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "dtls-cookie",
      namedGroups: [NamedCurveAlgorithm.secp256r1_23],
    });
    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("cookie+group HRR timeout")),
        20_000,
      );
      client.onConnect.subscribe(() => {
        void client.send(Buffer.from("hrr-combo"));
      });
      server.onData.subscribe((d) => {
        expect(d.toString()).toBe("hrr-combo");
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
  "e2e/self13 client without cert/key completes server-auth-only handshake",
  async () => {
    // Arrange: クライアント cert/key なし
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    const client = new DtlsClient({
      transport: clientTransport,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no-client-cert timeout")),
        15_000,
      );
      client.onConnect.subscribe(() => {
        void client.send(Buffer.from("anon-client"));
      });
      server.onData.subscribe((d) => {
        expect(d.toString()).toBe("anon-client");
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
  "e2e/self13 use_srtp bridges to DtlsSocket.srtp.srtpProfile both sides",
  async () => {
    // Arrange
    const { ProtectionProfileAeadAes128Gcm } = await import(
      "../../../rtp/src/srtp/const"
    );
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;
    const profiles = [ProtectionProfileAeadAes128Gcm];
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      srtpProfiles: profiles,
    });
    const client = new DtlsClient({
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      srtpProfiles: profiles,
    });
    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("srtp profile bridge timeout")),
        15_000,
      );
      const check = () => {
        if (!client.connected || !server.connected) return;
        expect(client.srtp.srtpProfile).toBe(ProtectionProfileAeadAes128Gcm);
        expect(server.srtp.srtpProfile).toBe(ProtectionProfileAeadAes128Gcm);
        clearTimeout(timer);
        client.close();
        server.close();
        resolve();
      };
      client.onConnect.subscribe(check);
      server.onConnect.subscribe(check);
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

test("e2e/self13 dual [1.3,1.2] server upgrades for 1.3-only client", async () => {
  // Arrange: server lists both versions; client is 1.3-only
  // addressValidation 未指定 → 既定 dtls-cookie 経路（reinject で peer 保持が必須）
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    // addressValidation intentionally omitted (default cookie path)
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3],
    // client also uses default; cookie only enforced server-side
  });

  // Act / Assert: dual server が 1.3 に昇格し、default cookie 経路で接続
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("dual server upgrade (default cookie) timeout")),
      15_000,
    );
    client.onConnect.subscribe(() => {
      expect(client.isDtls13).toBe(true);
      expect(server.isDtls13).toBe(true);
      void client.send(Buffer.from("dual-up"));
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("dual-up");
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
}, 20_000);

test("e2e/self13 dual [1.3,1.2] server × [1.3] client with addressValidation none still works", async () => {
  // Arrange: 明示 none（後方互換 / 高速経路）
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    addressValidation: "none",
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3],
    addressValidation: "none",
  });

  // Act / Assert
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("dual none upgrade timeout")),
      15_000,
    );
    client.onConnect.subscribe(() => {
      expect(server.isDtls13).toBe(true);
      void client.send(Buffer.from("dual-none"));
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("dual-none");
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
}, 20_000);

test("e2e/self13 [1.3,1.2] client falls back to 1.2-only server", async () => {
  // Arrange
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const { HashAlgorithm, SignatureAlgorithm } = await import(
    "../../src/cipher/const"
  );
  const sig = {
    hash: HashAlgorithm.sha256_4,
    signature: SignatureAlgorithm.rsa_1,
  };
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_2],
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });

  // Act / Assert: fallback 後に 1.2 で接続
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("fallback timeout")),
      15_000,
    );
    client.onConnect.subscribe(() => {
      expect(client.isDtls13).toBe(false);
      void client.send(Buffer.from("fallback"));
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("fallback");
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    });
    client.onError.subscribe((e) => {
      // 透過的 dual fallback: 公開 onError に ProtocolVersionError を流さない
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      // サーバ側の version reject は dual 交渉の想定内
      if (
        e instanceof ProtocolVersionError ||
        e.name === "ProtocolVersionError" ||
        /DTLS 1\.3 cipher|protocol version/i.test(e.message)
      ) {
        return;
      }
      clearTimeout(timer);
      reject(e);
    });
    await client.connect();
  });
}, 20_000);

test("e2e/self13 default options remain DTLS 1.2", async () => {
  // Arrange: protocolVersions 未指定 + 1.2 に必要な signatureHash
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const { HashAlgorithm, SignatureAlgorithm } = await import(
    "../../src/cipher/const"
  );
  const sig = {
    hash: HashAlgorithm.sha256_4,
    signature: SignatureAlgorithm.rsa_1,
  };

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });

  // Assert: 1.2 エンジン
  expect(server.isDtls13).toBe(false);
  expect(client.isDtls13).toBe(false);
  expect(server.protocolVersions).toEqual([DtlsVersion.V1_2]);

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("1.2 self timeout")),
      10_000,
    );
    client.onConnect.subscribe(() => {
      void client.send(Buffer.from("v12"));
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("v12");
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
}, 15_000);

// silence unused import if NamedCurveAlgorithm reserved for future P-256 test
void NamedCurveAlgorithm;
