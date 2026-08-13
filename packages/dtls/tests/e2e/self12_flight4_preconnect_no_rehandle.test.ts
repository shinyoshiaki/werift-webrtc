import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { HandshakeType } from "../../src/handshake/const";
import { ContentType } from "../../src/record/const";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

/**
 * Improvement: before connect completes (and before client epoch advances),
 * re-inject controlled Flight4 packets and assert Flight5 handlers are not
 * re-applied for cached msg_types.
 *
 * Timing matter: Flight5.exec sets dtls.epoch=1 while building Finished, after
 * which socket drops epoch-0 HS. Hold ServerHelloDone so we stay in epoch 0.
 *
 * Pre-fix: every Flight4 retransmit re-ran ServerKeyExchange → ECDHE regen.
 */
test("e2e/self12: pre-connect Flight4 re-inject does not re-run Flight5 handlers", async () => {
  // Arrange
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

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

  const flight4PreShd: Buffer[] = [];
  const shdHold: Buffer[] = [];
  let releaseShd = false;
  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    const dtls = (server as any).dtls;
    if (
      dtls.clientHelloCommitted &&
      dtls.flight === 4 &&
      buf[0] === ContentType.handshake
    ) {
      // Hold ServerHelloDone (msg_type 14) so client stays epoch 0.
      // Handshake header: contentType(1)+ver(2)+epoch(2)+seq(6)+len(2)+HS...
      // FragmentedHandshake msg_type is at offset 13 of the DTLS record body
      // for a single unfragmented HS — parse simply: look at HS type byte.
      const hsType = buf.length > 13 ? buf[13] : -1;
      if (!releaseShd && hsType === HandshakeType.server_hello_done_14) {
        shdHold.push(Buffer.from(buf));
        return;
      }
      if (hsType !== HandshakeType.server_hello_done_14) {
        flight4PreShd.push(Buffer.from(buf));
      }
    }
    return origServerSend(buf, addr);
  };

  void client.connect();

  // Wait until Flight5 exists and localKeyPair is set (SKX processed), SHD held
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (
      (client as any).flight5 &&
      (client as any).cipher.localKeyPair &&
      flight4PreShd.length > 0 &&
      shdHold.length > 0
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  expect((client as any).flight5).toBeTruthy();
  expect((client as any).cipher.localKeyPair).toBeTruthy();
  expect(flight4PreShd.length).toBeGreaterThan(0);
  expect(shdHold.length).toBeGreaterThan(0);
  // Still epoch 0 — otherwise wire re-inject of Flight4 would be dropped
  expect((client as any).dtls.epoch).toBe(0);
  expect(client.connected).toBe(false);

  const keyPairBefore = (client as any).cipher.localKeyPair;
  const keyBefore = Buffer.from(keyPairBefore.publicKey as Buffer);
  const remoteRandomBefore = (client as any).cipher.remoteRandom;
  const cacheLenBefore = ((client as any).dtls.handshakeCache[4]?.data ?? [])
    .length;

  const flight5 = (client as any).flight5;
  let handlerCalls = 0;
  let applyPathCalls = 0;
  const origHandle = flight5.handleHandshake.bind(flight5);
  flight5.handleHandshake = (hs: any) => {
    handlerCalls += 1;
    const already = !!((client as any).dtls.handshakeCache[4]?.data ?? []).some(
      (t: { msg_type: number }) => t.msg_type === hs.msg_type,
    );
    if (!already) applyPathCalls += 1;
    return origHandle(hs);
  };

  // Act: re-inject Flight4 wire packets (SH/Cert/SKX) while still pre-connect
  const peer: [string, number] = [
    serverTransport.address.address,
    serverTransport.address.port,
  ];
  for (const pkt of flight4PreShd) {
    clientTransport.onData(pkt, peer);
  }
  await new Promise((r) => setTimeout(r, 40));

  const keyPairAfter = (client as any).cipher.localKeyPair;
  const keyAfter = Buffer.from(keyPairAfter.publicKey as Buffer);
  const cacheLenAfter = ((client as any).dtls.handshakeCache[4]?.data ?? [])
    .length;

  // Assert: ECDHE object identity unchanged (handlers short-circuit on cache)
  expect(keyPairAfter).toBe(keyPairBefore);
  expect(keyAfter.equals(keyBefore)).toBe(true);
  expect((client as any).cipher.remoteRandom).toBe(remoteRandomBefore);
  expect(cacheLenAfter).toBe(cacheLenBefore);
  // Wire path must hit Flight5.handleHandshake; apply path must not re-run
  expect(handlerCalls).toBeGreaterThan(0);
  expect(applyPathCalls).toBe(0);

  // Release ServerHelloDone so handshake can complete
  releaseShd = true;
  for (const buf of shdHold) {
    await origServerSend(buf);
  }

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 15_000);
    if (client.connected && server.connected) {
      clearTimeout(t);
      resolve();
      return;
    }
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
  });

  expect(client.connected).toBe(true);
  expect(server.connected).toBe(true);

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 30_000);
