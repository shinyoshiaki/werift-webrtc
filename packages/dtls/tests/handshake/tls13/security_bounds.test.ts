import { describe, expect, test } from "vitest";
import { createHash, randomBytes } from "crypto";
import {
  cookieBinding,
  mintCookie,
  peerKeyFromAddr,
  verifyCookie,
} from "../../../src/handshake/extensions/cookie";
import { Certificate13 } from "../../../src/handshake/message/tls13/certificate";
import { FragmentedHandshake } from "../../../src/record/message/fragment";
import { HandshakeType } from "../../../src/handshake/const";

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
    expect(
      verifyCookie(secret, cookie, cookieBinding("10.0.0.1:9", ch)),
    ).toBe(false);
    // 別 ClientHello では失敗
    expect(
      verifyCookie(secret, cookie, cookieBinding(peer, randomBytes(80))),
    ).toBe(false);
  });

  test("peerKeyFromAddr formats tuples", () => {
    // Arrange / Act / Assert
    expect(peerKeyFromAddr(["1.2.3.4", 443])).toBe("1.2.3.4:443");
    expect(peerKeyFromAddr({ address: "a", port: 1 })).toBe("a:1");
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
    expect(() => Certificate13.deSerialize(buf)).toThrow(/extensions exceed|truncated/);
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

// silence unused
void createHash;
