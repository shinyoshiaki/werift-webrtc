import { createHash, randomBytes } from "crypto";
import { describe, expect, test } from "vitest";
import {
  createHandshakeDatagram,
  DirectHandshakeCarrier,
} from "../../../src/carrier/direct";
import { HandshakeType } from "../../../src/handshake/const";
import {
  cookieBinding,
  mintCookie,
  peerKeyFromAddr,
  verifyCookie,
} from "../../../src/handshake/extensions/cookie";
import { remainingAfterAck } from "../../../src/handshake/message/tls13/ack";
import { Certificate13 } from "../../../src/handshake/message/tls13/certificate";
import { FragmentedHandshake } from "../../../src/record/message/fragment";

describe("security bounds: cookie binding", () => {
  test("cookie verifies only for matching peer + ClientHello", () => {
    // Arrange
    const secret = randomBytes(16);
    const ch = randomBytes(80);
    const peer = "127.0.0.1:50000";
    const binding = cookieBinding(peer, ch);
    const cookie = mintCookie(secret, binding);

    // Act / Assert
    expect(verifyCookie(secret, cookie, binding)).toBe(true);
    // 別 peer では失敗
    expect(verifyCookie(secret, cookie, cookieBinding("10.0.0.1:9", ch))).toBe(
      false,
    );
    // 別 ClientHello では失敗
    expect(
      verifyCookie(secret, cookie, cookieBinding(peer, randomBytes(80))),
    ).toBe(false);
  });

  test("mint-time peer binding must match verify-time peer (dual reinject regression)", () => {
    // Arrange: dual upgrade used to mint with peerKey "unknown" then verify with real peer
    const secret = randomBytes(16);
    const ch1 = randomBytes(100);
    const mintPeer = "unknown";
    const realPeer = "127.0.0.1:54321";
    const cookie = mintCookie(secret, cookieBinding(mintPeer, ch1));

    // Act / Assert: mint と verify で peer が食い違うと失敗（バグ再現）
    expect(verifyCookie(secret, cookie, cookieBinding(realPeer, ch1))).toBe(
      false,
    );
    // 同一 peer を保持すれば成功
    expect(verifyCookie(secret, cookie, cookieBinding(mintPeer, ch1))).toBe(
      true,
    );

    // 正しい経路: 発行時も検証時も real peer
    const good = mintCookie(secret, cookieBinding(realPeer, ch1));
    expect(verifyCookie(secret, good, cookieBinding(realPeer, ch1))).toBe(true);
  });

  test("cookie binding includes peerKey bytes and ClientHello hash", () => {
    // Arrange
    const peer = "192.0.2.1:8443";
    const ch = Buffer.from("client-hello-body");
    // Act
    const binding = cookieBinding(peer, ch);
    // Assert: peer || 0x00 || SHA-256(ch)
    const peerBytes = Buffer.from(peer, "utf8");
    const chHash = createHash("sha256").update(ch).digest();
    expect(binding.subarray(0, peerBytes.length).equals(peerBytes)).toBe(true);
    expect(binding[peerBytes.length]).toBe(0);
    expect(binding.subarray(peerBytes.length + 1).equals(chHash)).toBe(true);
    // 異なる peer は異なる binding
    expect(cookieBinding("198.51.100.1:1", ch).equals(binding)).toBe(false);
  });

  test("peerKeyFromAddr formats tuples", () => {
    // Arrange / Act / Assert
    expect(peerKeyFromAddr(["1.2.3.4", 443])).toBe("1.2.3.4:443");
    expect(peerKeyFromAddr({ address: "a", port: 1 })).toBe("a:1");
    expect(peerKeyFromAddr(undefined)).toBe("unknown");
    expect(peerKeyFromAddr("already:key")).toBe("already:key");
  });
});

describe("security bounds: Certificate13", () => {
  test("rejects extensions that exceed certificate_list", () => {
    // Arrange: hand-crafted buffer with extLen past list end
    // context_len=0, list_len=10, cert_len=3, cert=aaa, extLen=100 (too big)
    const buf = Buffer.alloc(1 + 3 + 3 + 3 + 2);
    buf.writeUInt8(0, 0);
    buf.writeUIntBE(10, 1, 3); // list claims 10 bytes
    buf.writeUIntBE(3, 4, 3);
    buf.write("aaa", 7);
    buf.writeUInt16BE(100, 10); // extLen overruns

    // Act / Assert
    expect(() => Certificate13.deSerialize(buf)).toThrow(
      /extensions exceed|truncated/,
    );
  });

  test("roundtrip valid certificate list", () => {
    // Arrange
    const cert = Buffer.from("cert-der-bytes");
    const msg = new Certificate13(Buffer.alloc(0), [cert]);
    // Act
    const wire = msg.serialize();
    const parsed = Certificate13.deSerialize(wire);
    // Assert
    expect(parsed.certificates[0].equals(cert)).toBe(true);
  });
});

describe("security bounds: partial ACK", () => {
  test("remainingAfterAck drops only matched records", () => {
    // Arrange
    const pending = [
      { epoch: 2, sequenceNumber: 0 },
      { epoch: 2, sequenceNumber: 1 },
      { epoch: 2, sequenceNumber: 2 },
    ];
    // Act: 1 件だけ ACK
    const mid = remainingAfterAck(pending, [
      { epoch: 2, sequenceNumber: 1 },
    ]);
    // Assert: 未 ACK は再送対象として残る
    expect(mid).toEqual([
      { epoch: 2, sequenceNumber: 0 },
      { epoch: 2, sequenceNumber: 2 },
    ]);
    // 全 ACK で空
    expect(
      remainingAfterAck(mid, [
        { epoch: 2, sequenceNumber: 0 },
        { epoch: 2, sequenceNumber: 2 },
      ]),
    ).toEqual([]);
    // 無関係 ACK は no-op
    expect(
      remainingAfterAck(pending, [{ epoch: 3, sequenceNumber: 9 }]),
    ).toEqual(pending);
  });
});

describe("security bounds: carrier flight immutability", () => {
  test("onFlightCreated packets are independent copies from retransmit cache", () => {
    // Arrange
    const src = Buffer.from([1, 2, 3, 4, 5]);
    const notify = createHandshakeDatagram(src, 1, 0, true);
    const cache = createHandshakeDatagram(src, 1, 0, true);
    // Act: callback 側 Buffer を破壊
    notify.bytes[0] = 0xff;
    // Assert: cache は不変、元バッファも独立
    expect(cache.bytes[0]).toBe(1);
    expect(src[0]).toBe(1);
    expect(notify.bytes).not.toBe(cache.bytes);
  });

  test("external → internal retransmission mode resumes schedule hook", async () => {
    // Arrange
    let modeEvents: string[] = [];
    const fakeTransport = {
      type: "udp",
      address: { address: "127.0.0.1", port: 0, family: "IPv4" },
      closed: false,
      onData: () => {},
      send: async () => {},
      close: async () => {},
    };
    const carrier = new DirectHandshakeCarrier(fakeTransport as any);
    carrier.events.onRetransmissionModeChange = (m) => {
      modeEvents.push(m);
    };
    // Act
    let fired = 0;
    carrier.setRetransmissionMode("external");
    const cancel = carrier.schedule(10, () => {
      fired++;
    });
    // external 中は timer が動かない
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(0);
    cancel();
    carrier.setRetransmissionMode("internal");
    // Assert
    expect(modeEvents).toEqual(["external", "internal"]);
    await new Promise<void>((resolve) => {
      carrier.schedule(15, () => {
        fired++;
        resolve();
      });
    });
    expect(fired).toBe(1);
    carrier.close();
  });
});

describe("security bounds: large Certificate13", () => {
  test("roundtrips multi-kilobyte certificate list", () => {
    // Arrange: 大きな DER 風 blob（実証明書断片化は e2e small-MTU で検証）
    const large = randomBytes(8 * 1024);
    const msg = new Certificate13(Buffer.alloc(0), [large, randomBytes(512)]);
    // Act
    const wire = msg.serialize();
    const parsed = Certificate13.deSerialize(wire);
    // Assert
    expect(parsed.certificates[0].equals(large)).toBe(true);
    expect(parsed.certificates[1].length).toBe(512);
    expect(wire.length).toBeGreaterThan(8 * 1024);
  });
});

describe("security bounds: fragment reassembly", () => {
  test("assemble rejects range past length", () => {
    // Arrange
    const parts = [
      new FragmentedHandshake(
        HandshakeType.certificate_11,
        10,
        0,
        8,
        5, // offset 8 + len 5 > 10
        Buffer.alloc(5),
      ),
    ];
    // Act / Assert
    expect(() => FragmentedHandshake.assemble(parts)).toThrow(
      /exceeds message length|fragment range/,
    );
  });

  test("assemble rejects conflicting overlap", () => {
    // Arrange
    const total = 4;
    const a = new FragmentedHandshake(
      HandshakeType.finished_20,
      total,
      1,
      0,
      3,
      Buffer.from([1, 2, 3]),
    );
    const b = new FragmentedHandshake(
      HandshakeType.finished_20,
      total,
      1,
      2,
      2,
      Buffer.from([9, 4]), // conflict at offset 2
    );
    // Act / Assert
    expect(() => FragmentedHandshake.assemble([a, b])).toThrow(
      /conflict|overlapping/,
    );
  });

  test("assemble accepts non-overlapping complete cover", () => {
    // Arrange
    const a = new FragmentedHandshake(
      HandshakeType.finished_20,
      4,
      1,
      0,
      2,
      Buffer.from([1, 2]),
    );
    const b = new FragmentedHandshake(
      HandshakeType.finished_20,
      4,
      1,
      2,
      2,
      Buffer.from([3, 4]),
    );
    // Act
    const full = FragmentedHandshake.assemble([a, b]);
    // Assert
    expect(full.fragment.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
  });
});
