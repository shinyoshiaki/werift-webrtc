import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { ContentType } from "../../src/record/const";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

/**
 * P1: first Flight4 is lost; client retransmits CH2; server must NOT regenerate
 * serverRandom/ECDHE — cached Flight4 is bit-identical and handshake completes.
 */
test("e2e/self12: CH2 retransmit resends bit-identical Flight4 without re-commit", async () => {
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

  const firstFlight4: Buffer[] = [];
  const resentFlight4: Buffer[] = [];
  /** Drop Flight4 until client sends something after association commit (CH2 rtx). */
  let allowFlight4 = false;

  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    const dtls = (server as any).dtls;
    if (dtls.clientHelloCommitted && dtls.flight === 4) {
      if (!allowFlight4) {
        firstFlight4.push(Buffer.from(buf));
        return; // drop first Flight4 wave
      }
      resentFlight4.push(Buffer.from(buf));
    }
    return origServerSend(buf, addr);
  };

  const origClientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    // After cookie commit, further client handshake TX is CH2 retransmit (loss recovery).
    if (
      (server as any).dtls.clientHelloCommitted &&
      buf[0] === ContentType.handshake
    ) {
      allowFlight4 = true;
    }
    return origClientSend(buf, addr);
  };

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(
            `CH2 rtx Flight4 timeout (first4=${firstFlight4.length} resent=${resentFlight4.length} allow=${allowFlight4})`,
          ),
        ),
      25_000,
    );
    client.onConnect.subscribe(() => {
      try {
        expect(firstFlight4.length).toBeGreaterThan(0);
        expect(resentFlight4.length).toBeGreaterThan(0);
        const a = Buffer.concat(firstFlight4);
        // Resend may include timer-driven Flight4 retransmits after the cached
        // resend; the first wave of resent bytes must match the dropped Flight4.
        const b = Buffer.concat(resentFlight4);
        expect(b.length).toBeGreaterThanOrEqual(a.length);
        expect(b.subarray(0, a.length).equals(a)).toBe(true);
        expect((server as any).dtls.clientHelloCommitted).toBe(true);
        void client.send(Buffer.from("ch2-rtx-ok"));
      } catch (e) {
        clearTimeout(t);
        reject(e);
      }
    });
    server.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("ch2-rtx-ok");
        clearTimeout(t);
        resolve();
      } catch (e) {
        clearTimeout(t);
        reject(e);
      }
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

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 30_000);
