import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { createPlaintext } from "../../src/record/builder";
import { AlertDesc, ContentType } from "../../src/record/const";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

async function connectPair12() {
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
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 15_000);
    let c = false;
    let s = false;
    const done = () => {
      if (c && s) {
        clearTimeout(timer);
        resolve();
      }
    };
    client.onConnect.subscribe(() => {
      c = true;
      done();
    });
    server.onConnect.subscribe(() => {
      s = true;
      done();
    });
    void client.connect();
  });
  return { client, server, clientTransport, serverTransport };
}

function peerOf(t: { address: { address: string; port: number } | string }): [
  string,
  number,
] {
  const a = t.address as { address: string; port: number };
  return [a.address === "0.0.0.0" ? "127.0.0.1" : a.address, a.port];
}

/**
 * P2: 1.2 peer close_notify は transport.send が停滞しても onClose / tear down する。
 */
test("e2e/self12: peer close_notify frees association if send hangs", async () => {
  // Arrange
  const { client, server, clientTransport, serverTransport } =
    await connectPair12();

  // Hang flush path used by close_notify reply
  const hang = () =>
    new Promise<void>(() => {
      /* never resolve */
    });
  clientTransport.send = hang;
  clientTransport.sendAndWait = hang;

  const closes: number[] = [];
  client.onClose.subscribe(() => closes.push(Date.now()));

  // Act: AEAD close_notify from server
  const frag = Buffer.from([1, AlertDesc.CloseNotify]);
  const pkt = createPlaintext((server as any).dtls)(
    [{ type: ContentType.alert, fragment: frag }],
    ++(server as any).dtls.recordSequenceNumber,
  )[0];
  const wire = (server as any).cipher.encryptPacket(pkt).serialize();
  const t0 = Date.now();
  (client as any).udpOnMessage(wire, peerOf(serverTransport));

  // Assert: onClose within budget (~250ms) despite hung reply send
  for (let i = 0; i < 40; i++) {
    if (closes.length > 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(closes.length).toBe(1);
  expect(Date.now() - t0).toBeLessThan(800);
  expect((client as any).associationTornDown).toBe(true);
  expect(client.connected).toBe(false);
  await expect(client.send(Buffer.from("x"))).rejects.toThrow(/closed/i);

  try {
    server.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);
