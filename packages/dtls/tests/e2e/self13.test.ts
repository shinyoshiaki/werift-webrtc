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
  // Arrange: 前提を準備する
  const { server, client } = await pair();
  const word = "dtls13";

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("self13 handshake timeout")),
      15_000,
    );

    // Act: ハンドシェイクを検証する
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

test("e2e/self13 bad server Finished verify_data fails client promptly", async () => {
  // Arrange: server Finished の *検証* だけ壊す（生成側は正しい wire）
  // 呼び出し順: (1) server が Finished 生成 (2) client が server Finished 検証
  const { server, client } = await pair();
  const eng = (client as any).engine13;
  expect(eng).toBeTruthy();
  // 共有 defaultKeySchedule を使うため、検証 2 回目のみ壊す
  const ks = eng.keySchedule;
  const orig = ks.verifyData.bind(ks);
  let calls = 0;
  ks.verifyData = (base: Buffer, transcript: Buffer) => {
    calls++;
    const real = orig(base, transcript);
    // Act: client 側の server Finished 検証時のみ不一致
    if (calls === 2) return Buffer.alloc(real.length, 0xaa);
    return real;
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("bad Finished should fail promptly, timed out")),
      5_000,
    );
    const cleanup = () => {
      ks.verifyData = orig;
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
    };
    let clientErrored = false;
    let clientClosed = false;
    const maybeDone = () => {
      if (clientErrored && clientClosed) {
        clearTimeout(timer);
        cleanup();
        resolve();
      }
    };
    client.onError.subscribe((e: Error) => {
      // Assert: 認証済み失敗が即 onError（再送タイムアウト待ちではない）
      expect(e.message).toMatch(/verify_data|Finished/i);
      clientErrored = true;
      maybeDone();
    });
    client.onClose.subscribe(() => {
      clientClosed = true;
      maybeDone();
    });
    client.onConnect.subscribe(() => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("should not connect with bad Finished"));
    });
    void client.connect().catch(() => {
      /* fail path may reject */
    });
  });
}, 10_000);

test("e2e/self13 bad CertificateVerify fails server promptly (mutual auth)", async () => {
  // Arrange: mutual auth + server 側 CV 検証を失敗させる
  const { server, client } = await pair({ certificateRequest: true });
  const eng = (server as any).engine13;
  expect(eng).toBeTruthy();
  // Act: 認証済み CV 処理を失敗させる
  eng.onCertificateVerify = async () => {
    throw new Error("CertificateVerify signature verification failed");
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error("bad CertificateVerify should fail promptly, timed out"),
        ),
      5_000,
    );
    let serverErrored = false;
    let serverClosed = false;
    const done = () => {
      if (serverErrored && serverClosed) {
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
        resolve();
      }
    };
    server.onError.subscribe((e: Error) => {
      // Assert: 認証済み失敗が即 onError（再送タイムアウト待ちではない）
      expect(e.message).toMatch(/CertificateVerify|signature/i);
      serverErrored = true;
      done();
    });
    server.onClose.subscribe(() => {
      serverClosed = true;
      done();
    });
    client.onConnect.subscribe(() => {
      // client が先に connect しても server は CV 失敗で落ちる
    });
    void client.connect().catch(() => {
      /* expected path may error on client after fatal alert */
    });
  });
}, 10_000);

test("e2e/self13 KeyUpdate pending write epoch does not copy old read keys", async () => {
  // Arrange: 前提を準備する
  const { server, client } = await pair();
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("keyupdate epoch isolation timeout")),
      15_000,
    );
    client.onConnect.subscribe(async () => {
      try {
        const eng = (client as any).engine13;
        const beforeWrite = eng.writeEpoch as number;
        const beforeRead = eng.readEpoch as number;
        // Act: KeyUpdate を検証する
        // the pending epoch entry is installed immediately with writeKeys.
        await client.keyUpdate(false);
        const pending = eng.pendingKeyUpdateWrite;
        // Assert: pending write epoch は writeKeys のみ（旧 read をコピーしない）
        expect(pending).toBeTruthy();
        const nextEp = eng.epochs.get(pending.nextWriteEpoch);
        expect(nextEp?.writeKeys).toBeTruthy();
        // 旧 readEpoch の readKeys が pending write epoch に混入していない
        if (pending.nextWriteEpoch !== beforeRead) {
          expect(nextEp?.readKeys).toBeUndefined();
        }
        // 旧 write epoch はそのまま
        expect(eng.writeEpoch).toBe(beforeWrite);
        clearTimeout(timer);
        client.close();
        server.close();
        resolve();
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    await client.connect();
  });
}, 20_000);

test("e2e/self13 KeyUpdate then bidirectional data", async () => {
  // Arrange: 前提を準備する
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
          // Act: KeyUpdate（ACK 前は旧鍵のまま送信してよい RFC 9147 §8）
          await client.keyUpdate(false);
          // 即時 app data（新 epoch 待ちの sleep なし）— 旧 write 鍵で送出
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

test("e2e/self13 KeyUpdate ACKed without RTO retransmit (no loss)", async () => {
  // Arrange: ロスなしで KeyUpdate が 1 回送信・即 ACK・writeEpoch 進むことを検証
  // （再送依存の ACK 漏れを loss test では見逃しやすい）
  const { server, client, clientTransport } = await pair();
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("keyupdate no-retransmit timeout")),
      15_000,
    );
    client.onConnect.subscribe(async () => {
      try {
        const eng = (client as any).engine13;
        // Settle final-flight ACK so HS retransmits do not pollute KU send counts
        const settle = Date.now() + 2000;
        while (eng.getPendingFlightSize() > 0 && Date.now() < settle) {
          await new Promise((r) => setTimeout(r, 20));
        }
        expect(eng.getPendingFlightSize()).toBe(0);

        const writeBefore = eng.writeEpoch as number;
        let clientSends = 0;
        const origSend = clientTransport.send.bind(clientTransport);
        clientTransport.send = async (buf: Buffer) => {
          clientSends++;
          return origSend(buf);
        };

        // Act: KeyUpdate を検証する
        await client.keyUpdate(false);

        // Assert: write epoch が ACK で進む（再送 RTO の ~1s より十分短い）
        const deadline = Date.now() + 800;
        while (
          (eng.writeEpoch === writeBefore || eng.pendingKeyUpdateWrite) &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 20));
        }
        expect(eng.pendingKeyUpdateWrite).toBeUndefined();
        expect(eng.writeEpoch).toBeGreaterThan(writeBefore);
        expect(eng.getPendingFlightSize()).toBe(0);
        // 再送なし（RTO 前に ACK 済み）
        expect(eng.retransmitCount).toBe(0);
        expect(clientSends).toBe(1);

        // RTO を超えて待っても再送が増えない
        await new Promise((r) => setTimeout(r, 1500));
        expect(clientSends).toBe(1);
        expect(eng.retransmitCount).toBe(0);

        // 新 epoch で app data
        await client.send(Buffer.from("ku-no-rto"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("ku-no-rto");
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

test("e2e/self13 KeyUpdate(request_update) gets explicit ACK then response KeyUpdate", async () => {
  // Arrange: response KeyUpdate は peer KeyUpdate の implicit ACK ではない (RFC 9147 §8)
  const { server, client, clientTransport, serverTransport } = await pair();
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("keyupdate request_update timeout")),
      15_000,
    );
    client.onConnect.subscribe(async () => {
      try {
        const cEng = (client as any).engine13;
        const sEng = (server as any).engine13;
        const settle = Date.now() + 2000;
        while (
          (cEng.getPendingFlightSize() > 0 ||
            sEng.getPendingFlightSize() > 0) &&
          Date.now() < settle
        ) {
          await new Promise((r) => setTimeout(r, 20));
        }

        const cWriteBefore = cEng.writeEpoch as number;
        const sWriteBefore = sEng.writeEpoch as number;

        let clientSends = 0;
        let serverSends = 0;
        const cOrig = clientTransport.send.bind(clientTransport);
        const sOrig = serverTransport.send.bind(serverTransport);
        clientTransport.send = async (buf: Buffer) => {
          clientSends++;
          return cOrig(buf);
        };
        serverTransport.send = async (buf: Buffer) => {
          serverSends++;
          return sOrig(buf);
        };

        // Act: KeyUpdate を検証する
        await client.keyUpdate(true);

        // Wait until both sides advanced write epochs (client KU ACK'd + server KU ACK'd)
        const deadline = Date.now() + 2000;
        while (
          (cEng.writeEpoch === cWriteBefore ||
            sEng.writeEpoch === sWriteBefore ||
            cEng.pendingKeyUpdateWrite ||
            sEng.pendingKeyUpdateWrite) &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 20));
        }
        expect(cEng.pendingKeyUpdateWrite).toBeUndefined();
        expect(sEng.pendingKeyUpdateWrite).toBeUndefined();
        expect(cEng.writeEpoch).toBeGreaterThan(cWriteBefore);
        expect(sEng.writeEpoch).toBeGreaterThan(sWriteBefore);
        // Neither side needed RTO retransmit for their KeyUpdate flight
        expect(cEng.retransmitCount).toBe(0);
        expect(sEng.retransmitCount).toBe(0);

        const cAfter = clientSends;
        const sAfter = serverSends;
        await new Promise((r) => setTimeout(r, 1200));
        expect(clientSends).toBe(cAfter);
        expect(serverSends).toBe(sAfter);
        // client: KeyUpdate + ACK of server response KeyUpdate
        expect(clientSends).toBeGreaterThanOrEqual(1);
        expect(clientSends).toBeLessThanOrEqual(2);
        // server: ACK(client KU) + response KeyUpdate
        expect(serverSends).toBeGreaterThanOrEqual(2);
        expect(serverSends).toBeLessThanOrEqual(3);

        await client.send(Buffer.from("ku-req"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("ku-req");
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
}, 25_000);

test("e2e/self13 crossed KeyUpdate(request_update=true) advances two generations", async () => {
  // Arrange: 前提を準備する
  // each must ACK peer KU, finish own KU, then send deferred response KU(false).
  const { server, client } = await pair();
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("crossed keyupdate timeout")),
      20_000,
    );
    client.onConnect.subscribe(async () => {
      try {
        const cEng = (client as any).engine13;
        const sEng = (server as any).engine13;
        const settle = Date.now() + 2000;
        while (
          (cEng.getPendingFlightSize() > 0 ||
            sEng.getPendingFlightSize() > 0) &&
          Date.now() < settle
        ) {
          await new Promise((r) => setTimeout(r, 20));
        }
        const cWrite0 = cEng.writeEpoch as number;
        const sWrite0 = sEng.writeEpoch as number;

        // Act: KeyUpdate を検証する
        await Promise.all([client.keyUpdate(true), server.keyUpdate(true)]);

        // Assert: KeyUpdate を検証する
        // → write generation advances by 2 on each side
        const deadline = Date.now() + 5000;
        while (
          (cEng.writeEpoch < cWrite0 + 2 ||
            sEng.writeEpoch < sWrite0 + 2 ||
            cEng.pendingKeyUpdateWrite ||
            sEng.pendingKeyUpdateWrite ||
            cEng.deferredKeyUpdateResponse ||
            sEng.deferredKeyUpdateResponse) &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 30));
        }
        expect(cEng.pendingKeyUpdateWrite).toBeUndefined();
        expect(sEng.pendingKeyUpdateWrite).toBeUndefined();
        expect(cEng.deferredKeyUpdateResponse).toBe(false);
        expect(sEng.deferredKeyUpdateResponse).toBe(false);
        expect(cEng.writeEpoch).toBe(cWrite0 + 2);
        expect(sEng.writeEpoch).toBe(sWrite0 + 2);
        expect(client.connected).toBe(true);
        expect(server.connected).toBe(true);

        // Bidirectional app data on final keys
        await client.send(Buffer.from("cross-ku-c2s"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    let gotC2s = false;
    server.onData.subscribe(async (d) => {
      try {
        if (!gotC2s) {
          expect(d.toString()).toBe("cross-ku-c2s");
          gotC2s = true;
          await server.send(Buffer.from("cross-ku-s2c"));
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    client.onData.subscribe((d) => {
      expect(d.toString()).toBe("cross-ku-s2c");
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
}, 25_000);

test("e2e/self13 server-initiated KeyUpdate then bidirectional data", async () => {
  // Arrange: サーバ主導 KeyUpdate
  const { server, client } = await pair();
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server keyupdate timeout")),
      15_000,
    );
    client.onConnect.subscribe(async () => {
      try {
        await client.send(Buffer.from("s-pre"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    let gotPre = false;
    server.onData.subscribe(async (data) => {
      try {
        if (!gotPre) {
          expect(data.toString()).toBe("s-pre");
          gotPre = true;
          // Act: KeyUpdate を検証する
          await server.keyUpdate(false);
          await server.send(Buffer.from("s-post"));
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    client.onData.subscribe((data) => {
      expect(data.toString()).toBe("s-post");
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

test("e2e/self13 repeated mutual KeyUpdate (client then server)", async () => {
  // Arrange: 両側 connected 後に順次 KeyUpdate（ACK 完了を待つ）
  const { server, client } = await pair();
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("mutual keyupdate timeout")),
      20_000,
    );
    const waitBoth = async () => {
      while (!client.connected || !server.connected) {
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    client.onConnect.subscribe(async () => {
      try {
        await waitBoth();
        await client.keyUpdate(false);
        // ACK で write epoch が進むまで待つ
        await new Promise((r) => setTimeout(r, 400));
        await server.keyUpdate(false);
        await new Promise((r) => setTimeout(r, 400));
        await client.send(Buffer.from("multi-ku"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("multi-ku");
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
}, 25_000);

test("e2e/self13 exporter EXTRACTOR-dtls_srtp matches both sides", async () => {
  // Arrange: 前提を準備する
  const { server, client } = await pair();

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("exporter timeout")),
      15_000,
    );

    const check = () => {
      if (!client.connected || !server.connected) return;
      // Act: use_srtp/MKI を検証する
      const c = client.exportKeyingMaterial("EXTRACTOR-dtls_srtp", 60);
      const s = server.exportKeyingMaterial("EXTRACTOR-dtls_srtp", 60);
      // Assert: use_srtp/MKI を検証する
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
  // Arrange: 前提を準備する
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
  // Arrange: 既定 addressValidation (dtls-cookie) のまま — pre-cookie でも
  // protocol_version(70) が送信元へ届き、再送 timeout にならないこと。
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

  // addressValidation 未指定 → 既定 dtls-cookie
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3],
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_2],
  });

  // Act / Assert: protocol_version(70) / ProtocolVersionError のみ成功扱い
  // （handshake_failure・再送 timeout は失敗）
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "expected ProtocolVersionError / protocol_version alert, got timeout",
          ),
        ),
      8_000,
    );
    const done = (e: Error) => {
      clearTimeout(timer);
      client.close();
      server.close();
      if (
        e instanceof ProtocolVersionError ||
        e.name === "ProtocolVersionError" ||
        e.message.includes("protocol_version") ||
        /protocol version|no overlapping DTLS/i.test(e.message)
      ) {
        resolve();
        return;
      }
      if (/timeout|retransmit|over retransmit/i.test(e.message)) {
        reject(
          new Error(
            `got timeout-like error, want protocol_version(70): ${e.message}`,
          ),
        );
        return;
      }
      if (/handshake_failure|0x1301|TLS_AES|cipher suite/i.test(e.message)) {
        reject(
          new Error(
            `got cipher/handshake_failure, want protocol_version(70): ${e.message}`,
          ),
        );
        return;
      }
      reject(new Error(`unexpected error: ${e.name}: ${e.message}`));
    };
    // pre-cookie server は association を fail しないので client 側の alert 受信を主に見る
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
  // Arrange: 前提を準備する
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
    // Act: 証明書・署名を検証する
    await client.connect();
  });
}, 20_000);

test("e2e/self13 dtls-cookie address validation completes handshake", async () => {
  // Arrange: 前提を準備する
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
    // Act: cookie 経路を検証する
    await client.connect();
  });
}, 20_000);

test("e2e/self13 empty group intersection fails (no silent force-group)", async () => {
  // Arrange: 前提を準備する
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3],
    addressValidation: "none",
    namedGroups: [NamedCurveAlgorithm.x25519_29],
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3],
    addressValidation: "none",
    namedGroups: [NamedCurveAlgorithm.secp256r1_23],
  });
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("expected group negotiation failure")),
      8_000,
    );
    const onErr = (e: Error) => {
      clearTimeout(timer);
      client.close();
      server.close();
      if (/overlapping named groups|group/i.test(e.message)) {
        resolve();
        return;
      }
      reject(e);
    };
    client.onError.subscribe(onErr);
    server.onError.subscribe(onErr);
    client.onConnect.subscribe(() => {
      clearTimeout(timer);
      reject(new Error("must not connect with empty group intersection"));
    });
    await client.connect();
  });
}, 15_000);

test("e2e/self13 cookie + key_share group mismatch completes via combined HRR", async () => {
  // Arrange: 前提を準備する
  // server is X25519-only → intersection={X25519}, combined HRR (cookie+group).
  // (Client P-256-only ∩ server X25519-only must fail — that is correct RFC 8446.)
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
    // Preference order: first group is key_share offer; X25519 still advertised
    namedGroups: [
      NamedCurveAlgorithm.secp256r1_23,
      NamedCurveAlgorithm.x25519_29,
    ],
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
}, 25_000);

test("e2e/self13 client without cert/key completes server-auth-only handshake", async () => {
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
}, 20_000);

test("e2e/self13 use_srtp bridges to DtlsSocket.srtp.srtpProfile both sides", async () => {
  // Arrange: 前提を準備する
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
}, 20_000);

test("e2e/self13 dual [1.3,1.2] server upgrades for 1.3-only client", async () => {
  // Arrange: 前提を準備する
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

  // Act / Assert: version 交渉を検証する
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
  // Arrange: 前提を準備する
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

test("e2e/self13 [V1_2,V1_3] is accepted (preference order preserved)", () => {
  // Arrange: 1.2 優先 dual を public API で受理
  const transport = {
    send: async () => {},
    onData: () => {},
    close: async () => {},
  } as any;
  const server = new DtlsServer({
    transport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_2, DtlsVersion.V1_3],
  });
  const client = new DtlsClient({
    transport,
    protocolVersions: [DtlsVersion.V1_2, DtlsVersion.V1_3],
  });
  // Assert: 順序が preference として保持される
  expect(server.protocolVersions).toEqual([
    DtlsVersion.V1_2,
    DtlsVersion.V1_3,
  ]);
  expect(client.protocolVersions).toEqual([
    DtlsVersion.V1_2,
    DtlsVersion.V1_3,
  ]);
  expect(client.isDtls13).toBe(false); // 1.2-first dual は association path 開始
  expect(server.isDtls13).toBe(false);
});

test("e2e/self13 server [1.2,1.3] prefers 1.2 when dual client offers both", async () => {
  // Arrange: server 優先 1.2、client dual [1.3,1.2]
  // association selectVersion → 1.2。DOWNGRD により dual client は abort（RFC）。
  // ここでは server が 1.3 engine に昇格しないこと（preference 遵守）を検証。
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
    protocolVersions: [DtlsVersion.V1_2, DtlsVersion.V1_3],
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("1.2-pref server path timeout")),
      15_000,
    );
    // Act: dual client が接続試行
    client.onConnect.subscribe(() => {
      // dual×dual で server が 1.2 を選ぶと DOWNGRD で client は通常失敗する。
      // もし接続しても server は 1.3 へ昇格してはならない。
      if (server.isDtls13) {
        clearTimeout(timer);
        reject(new Error("server must not upgrade to 1.3 when preferring 1.2"));
        return;
      }
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    });
    client.onError.subscribe((e) => {
      // Assert: server は 1.3 に切替えていない + downgrade / version 系で終了し得る
      try {
        expect(server.isDtls13).toBe(false);
        clearTimeout(timer);
        client.close();
        server.close();
        resolve();
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
    server.onError.subscribe(() => {
      // server 側エラーは無視（client の DOWNGRD abort と並行し得る）
    });
    await client.connect();
  });
}, 20_000);

test("e2e/self13 server [1.2,1.3] × client [1.3-only] selects 1.3", async () => {
  // Arrange: server は 1.2 優先 dual だが peer が 1.3 only なら 1.3 を選ぶ
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_2, DtlsVersion.V1_3],
    addressValidation: "none",
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3],
    addressValidation: "none",
  });

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("1.2-pref server × 1.3 client timeout")),
      15_000,
    );
    client.onConnect.subscribe(() => {
      // Assert: intersection が 1.3 のみなので 1.3 で接続
      expect(client.isDtls13).toBe(true);
      expect(server.isDtls13).toBe(true);
      void client.send(Buffer.from("pref12-but-13"));
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("pref12-but-13");
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

test("e2e/self13 client [1.2,1.3] × server [1.3] resumes 1.3 via dual CH", async () => {
  // Arrange: client は 1.2 優先 dual だが dual CH で 1.3 を広告 → 1.3 server と接続
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
    protocolVersions: [DtlsVersion.V1_2, DtlsVersion.V1_3],
    addressValidation: "none",
  });

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("client 1.2-first dual → 1.3 resume timeout")),
      15_000,
    );
    client.onConnect.subscribe(() => {
      // Assert: ServerHello で 1.3 が選ばれ dual path から resume
      expect(client.isDtls13).toBe(true);
      expect(server.isDtls13).toBe(true);
      void client.send(Buffer.from("client-pref12-13"));
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("client-pref12-13");
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
