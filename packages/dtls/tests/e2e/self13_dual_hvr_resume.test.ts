import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { ServerHelloVerifyRequest } from "../../src/handshake/message/server/helloVerifyRequest";
import { ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import { certPem, keyPem } from "../fixture";

/**
 * Build a DTLS 1.2 HelloVerifyRequest epoch-0 record (unauthenticated).
 */
function buildHvrDatagram(cookie = Buffer.alloc(16, 0xab)): Buffer {
  const hvr = new ServerHelloVerifyRequest(
    { major: 254, minor: 253 }, // DTLS 1.2 wire
    cookie,
  );
  hvr.messageSeq = 0;
  const frag = hvr.toFragment();
  frag.message_seq = 0;
  return serializePlaintextRecord(
    ContentType.handshake,
    0,
    0,
    frag.serialize(),
  );
}

test("e2e/dual: HVR then dual server selects 1.3 — client resumes 1.3 and app data works", async () => {
  // Arrange: dual client が最初の CH 後に unauthenticated HVR を受けても
  // supported_versions=[1.3,1.2] を維持し、dual server が 1.3 を選んだら
  // 1.3 engine に復帰してハンドシェイク＋ app data が成功すること。
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    // default dtls-cookie → HRR after dual CH; client must resume on 1.3 HRR
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });

  // Hold the first engine13 ClientHello; inject HVR; forward only subsequent dual CH.
  let clientSends = 0;
  const origClientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    clientSends += 1;
    if (clientSends === 1) {
      // Act: 最初の CH をサーバに届けず、stale/MITM HVR を注入
      const hvr = buildHvrDatagram();
      queueMicrotask(() => {
        clientTransport.onData?.(hvr, serverTransport.address as any);
      });
      return;
    }
    return origClientSend(buf, addr);
  };

  // Act / Assert: 1.3 で接続し双方向 app data
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("dual HVR→1.3 resume timeout")),
      20_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    client.onConnect.subscribe(() => {
      try {
        // Assert: dual 交渉の最終結果は DTLS 1.3
        expect(client.isDtls13).toBe(true);
        expect(server.isDtls13).toBe(true);
        void client.send(Buffer.from("dual-hvr-resume"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    server.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("dual-hvr-resume");
        void server.send(Buffer.from("dual-hvr-ok"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    client.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("dual-hvr-ok");
        clearTimeout(timer);
        client.close();
        server.close();
        resolve();
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    await client.connect();
  });
}, 25_000);

test("e2e/dual: HVR path still falls back to pure 1.2 server", async () => {
  // Arrange: 同じ dual 交渉が 1.2-only server では 1.2 完走すること（回帰）
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

  // Act / Assert: HVR はサーバ自身から。最終は 1.2。
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("dual→1.2 fallback after HVR timeout")),
      20_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    client.onConnect.subscribe(() => {
      try {
        expect(client.isDtls13).toBe(false);
        void client.send(Buffer.from("dual-12"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("dual-12");
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    });
    await client.connect();
  });
}, 25_000);
