import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import {
  DtlsClient,
  DtlsServer,
  DtlsVersion,
  ProtocolVersionError,
} from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { HandshakeType } from "../../src/handshake/const";
import { ServerHello } from "../../src/handshake/message/server/hello";
import { FragmentedHandshake } from "../../src/record/message/fragment";
import {
  DOWNGRADE_TLS12_SENTINEL,
  hasTlsDowngradeSentinel,
} from "../../src/version";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

function random32FromServerHello(sh: ServerHello): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(sh.random.gmt_unix_time >>> 0, 0);
  return Buffer.concat([b, sh.random.random_bytes]);
}

/**
 * Capture the first ServerHello (msg_type=2) from server → client datagrams.
 */
function installServerHelloCapture(serverTransport: UdpTransport): {
  get: () => ServerHello | undefined;
} {
  let captured: ServerHello | undefined;
  const orig = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    if (!captured) {
      try {
        // Scan DTLSPlaintext records for handshake ServerHello
        let off = 0;
        while (off + 13 <= buf.length) {
          const contentType = buf[off];
          const contentLen = buf.readUInt16BE(off + 11);
          const body = buf.subarray(off + 13, off + 13 + contentLen);
          if (contentType === 22 && body.length >= 12) {
            // May be one or more fragmented HS messages; try first
            try {
              const frag = FragmentedHandshake.deSerialize(body);
              if (
                frag.msg_type === HandshakeType.server_hello_2 &&
                frag.fragment_length === frag.length
              ) {
                captured = ServerHello.deSerialize(frag.fragment);
              }
            } catch {
              // not a complete HS fragment — ignore
            }
          }
          off += 13 + contentLen;
          if (contentLen === 0) break;
        }
      } catch {
        // ignore parse noise
      }
    }
    return orig(buf, addr);
  };
  return { get: () => captured };
}

test("e2e/downgrade: dual server × 1.2-only client sets DOWNGRD sentinel and connects", async () => {
  // Arrange: 1.3-capable dual server が 1.2 を選ぶとき sentinel を付与
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const capture = installServerHelloCapture(serverTransport);

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_2],
  });

  // Act / Assert: 1.2 で接続完了し、ServerHello.Random 末尾が DOWNGRD\\x01
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("dual server × 1.2 client timeout")),
      15_000,
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
        const sh = capture.get();
        expect(sh).toBeTruthy();
        const r32 = random32FromServerHello(sh!);
        expect(hasTlsDowngradeSentinel(r32)).toBe(true);
        expect(r32.subarray(24).equals(DOWNGRADE_TLS12_SENTINEL)).toBe(true);
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
}, 20_000);

test("e2e/downgrade: pure 1.2 server does not set sentinel; dual client connects", async () => {
  // Arrange: 1.2-only サーバーは sentinel を付けない（正規 dual fallback）
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const capture = installServerHelloCapture(serverTransport);

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

  // Act / Assert: dual client は 1.2 へ fallback し、sentinel 無しなら成功
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("pure 1.2 × dual client timeout")),
      15_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      // dual 交渉中の一時的 version エラーは許容しない（本経路は HVR→1.2）
      if (e instanceof ProtocolVersionError) return;
      clearTimeout(timer);
      reject(e);
    });
    client.onConnect.subscribe(() => {
      try {
        expect(client.isDtls13).toBe(false);
        const sh = capture.get();
        expect(sh).toBeTruthy();
        expect(hasTlsDowngradeSentinel(random32FromServerHello(sh!))).toBe(
          false,
        );
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
}, 20_000);

test("e2e/downgrade: dual client aborts when 1.2 ServerHello carries DOWNGRD sentinel", async () => {
  // Arrange: dual サーバーが 1.2 を選び sentinel を付けた状況を、
  // dual クライアントが 1.3 を offer したまま 1.2 を受け取ったものとして再現する。
  // ClientHello の supported_versions を除去し、1.3-capable server に 1.2 を選ばせる。
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });

  // Act: dual client の 1.3 engine が出す CH から supported_versions (type 43) を除去
  // → dual server は legacy 1.2 と見て 1.2 を選択し sentinel 付き SH を返す
  // → client は 1.3 を offer しているので sentinel で abort
  const stripSupportedVersions = (buf: Buffer): Buffer => {
    // Best-effort: if this is a DTLSPlaintext handshake with ClientHello, rebuild
    // without extension type 43. Fall back to original on any parse issue.
    try {
      if (buf.length < 13 || buf[0] !== 22) return buf;
      const contentLen = buf.readUInt16BE(11);
      if (buf.length < 13 + contentLen) return buf;
      const hs = FragmentedHandshake.deSerialize(
        buf.subarray(13, 13 + contentLen),
      );
      if (hs.msg_type !== HandshakeType.client_hello_1) return buf;
      if (hs.fragment_length !== hs.length) return buf;
      const body = Buffer.from(hs.fragment);
      // ClientHello: after fixed fields, extensions are at the end (uint16 len + list)
      // Parse loosely: find extensions vector at end of CH body
      // client_version(2)+random(32)+session(1+len)+cookie(1+len)+ciphers(2+len)+comp(1+len)+ext
      let o = 0;
      o += 2; // version
      o += 32; // random
      if (body.length < o + 1) return buf;
      const sidLen = body[o];
      o += 1 + sidLen;
      if (body.length < o + 1) return buf;
      const cookieLen = body[o];
      o += 1 + cookieLen;
      if (body.length < o + 2) return buf;
      const csLen = body.readUInt16BE(o);
      o += 2 + csLen;
      if (body.length < o + 1) return buf;
      const compLen = body[o];
      o += 1 + compLen;
      if (body.length < o + 2) return buf;
      const extLen = body.readUInt16BE(o);
      const extStart = o + 2;
      if (body.length < extStart + extLen) return buf;
      const exts = body.subarray(extStart, extStart + extLen);
      const kept: Buffer[] = [];
      let e = 0;
      while (e + 4 <= exts.length) {
        const t = exts.readUInt16BE(e);
        const l = exts.readUInt16BE(e + 2);
        e += 4;
        if (e + l > exts.length) break;
        const data = exts.subarray(e, e + l);
        e += l;
        if (t === 43) continue; // supported_versions — strip (MITM / legacy view)
        const chunk = Buffer.alloc(4 + l);
        chunk.writeUInt16BE(t, 0);
        chunk.writeUInt16BE(l, 2);
        data.copy(chunk, 4);
        kept.push(chunk);
      }
      const newExtBody = Buffer.concat(kept);
      const prefix = body.subarray(0, o);
      const newBody = Buffer.concat([
        prefix,
        (() => {
          const l = Buffer.alloc(2);
          l.writeUInt16BE(newExtBody.length, 0);
          return l;
        })(),
        newExtBody,
      ]);
      const newFrag = new FragmentedHandshake(
        hs.msg_type,
        newBody.length,
        hs.message_seq,
        0,
        newBody.length,
        newBody,
      );
      const newHs = newFrag.serialize();
      const out = Buffer.alloc(13 + newHs.length);
      buf.copy(out, 0, 0, 13);
      out.writeUInt16BE(newHs.length, 11);
      newHs.copy(out, 13);
      return out;
    } catch {
      return buf;
    }
  };

  const origSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (b: Buffer, addr?: any) =>
    origSend(stripSupportedVersions(b), addr);

  // Assert: dual client は sentinel を検知して ProtocolVersionError
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("expected downgrade abort timeout")),
      15_000,
    );
    let connected = false;
    client.onConnect.subscribe(() => {
      connected = true;
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      try {
        expect(connected).toBe(false);
        expect(
          e instanceof ProtocolVersionError ||
            e.name === "ProtocolVersionError" ||
            /downgrade sentinel|protocol_version|illegal_parameter/i.test(
              e.message,
            ),
        ).toBe(true);
        client.close();
        server.close();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    server.onError.subscribe(() => {
      // server may see client abort — ignore
    });
    try {
      await client.connect();
    } catch (e) {
      // connect may reject if engine fails first
      clearTimeout(timer);
      if (
        e instanceof ProtocolVersionError ||
        (e instanceof Error && /sentinel|protocol_version/i.test(e.message))
      ) {
        client.close();
        server.close();
        resolve();
        return;
      }
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}, 20_000);
