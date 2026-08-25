import {
  DTLS_IN_STUN_ACK,
  DTLS_IN_STUN_DATA,
  spedDataCrc32,
} from "../../src/sped/draft00";
import { SpedSession } from "../../src/sped/draft00/session";
import { classes, methods } from "../../src/stun/const";
import { Message, paddingLength } from "../../src/stun/message";

function stunAttributeTypes(bytes: Buffer): number[] {
  const types: number[] = [];
  for (let pos = 20; pos + 4 <= bytes.length; ) {
    const type = bytes.readUInt16BE(pos);
    const length = bytes.readUInt16BE(pos + 2);
    types.push(type);
    pos += 4 + length + paddingLength(length);
  }
  return types;
}

describe("SPED draft00 session", () => {
  it("新 flight で L1 を置換し defensive copy する", () => {
    // Arrange
    const session = new SpedSession(0);
    const original = Buffer.from([22, 1, 2, 3]);

    // Act
    session.replaceL1([original]);
    original[1] = 99;
    const l1 = session.l1Datagrams;

    // Assert
    expect(l1[0]![1]).toBe(1);
    expect(l1[0]!.equals(Buffer.from([22, 1, 2, 3]))).toBe(true);
  });

  it("L2 が 5 件でも decorate の ACK は最大 4", () => {
    // Arrange
    const session = new SpedSession(0);
    for (let i = 0; i < 5; i++) {
      session.queueAck(i + 1);
    }
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.setAttribute("USERNAME", "a:b").setAttribute("PRIORITY", 1);

    // Act
    expect(session.decorate(request)).toBe(true);
    request.addMessageIntegrity(Buffer.from("pw")).addFingerprint();
    const types = stunAttributeTypes(request.bytes);
    const ack = request.getRawAttributeValue(DTLS_IN_STUN_ACK)!;

    // Assert: ACK → DATA → MI → FP。載せた 4 CRC は消費し 5 件目は次回へ
    expect(types.indexOf(DTLS_IN_STUN_ACK)).toBeLessThan(
      types.indexOf(DTLS_IN_STUN_DATA),
    );
    expect(types.indexOf(DTLS_IN_STUN_DATA)).toBeLessThan(
      types.indexOf(0x0008),
    );
    expect(types.at(-1)).toBe(0x8028);
    expect(ack.length).toBe(16);
    expect(session.l2Crcs).toEqual([5]);

    // Act: 繰り越し分を次 Binding に載せる
    const next = new Message(methods.BINDING, classes.REQUEST);
    next.setAttribute("USERNAME", "a:b").setAttribute("PRIORITY", 1);
    expect(session.decorate(next)).toBe(true);

    // Assert: L2 は空。ACK は残り 1 CRC
    expect(session.l2Crcs).toHaveLength(0);
    expect(next.getRawAttributeValue(DTLS_IN_STUN_ACK)?.length).toBe(4);
  });

  it("invalid demux は L2 に載せない", () => {
    // Arrange
    const session = new SpedSession(0);
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.setAttribute("USERNAME", "a:b");
    request.appendRawAttribute(DTLS_IN_STUN_DATA, Buffer.from([0x80, 1]));

    // Act
    const result = session.receiveAuthenticated(request);

    // Assert
    expect(result.inject).toBeUndefined();
    expect(session.l2Crcs).toHaveLength(0);
    expect(session.peerSupport).toBe("supported");
  });

  it("empty DATA は supported だが inject しない", () => {
    // Arrange
    const session = new SpedSession(0);
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.appendRawAttribute(DTLS_IN_STUN_DATA, Buffer.alloc(0));

    // Act
    const result = session.receiveAuthenticated(request);

    // Assert
    expect(result.inject).toBeUndefined();
    expect(session.peerSupport).toBe("supported");
    expect(session.state).toBe("active");
  });

  it("DATA 無しの最初の authenticated Binding は fallback", () => {
    // Arrange
    const session = new SpedSession(0);
    const hello = Buffer.from([22, 9, 8, 7]);
    session.replaceL1([hello]);
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.setAttribute("USERNAME", "a:b");

    // Act
    const result = session.receiveAuthenticated(request);

    // Assert: 元 L1 bytes がそのまま残る
    expect(result.fallback).toBe(true);
    expect(session.state).toBe("fallback");
    expect(session.fallbackFlightBytes()[0]!.equals(hello)).toBe(true);
  });

  it("一致 CRC のみ L1 から削除し、未知 CRC は ignore", () => {
    // Arrange
    const session = new SpedSession(0);
    const a = Buffer.from([22, 1]);
    const b = Buffer.from([22, 2]);
    session.replaceL1([a, b]);
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.appendRawAttribute(DTLS_IN_STUN_DATA, Buffer.alloc(0));
    const ack = Buffer.alloc(8);
    ack.writeUInt32BE(spedDataCrc32(a), 0);
    ack.writeUInt32BE(0xdeadbeef, 4);
    request.appendRawAttribute(DTLS_IN_STUN_ACK, ack);

    // Act
    session.receiveAuthenticated(request);

    // Assert
    expect(session.l1Datagrams).toHaveLength(1);
    expect(session.l1Datagrams[0]!.equals(b)).toBe(true);
  });

  it("DATA の順序入れ替えと重複でも各 datagram を inject 対象にする", () => {
    // Arrange
    const session = new SpedSession(0);
    const first = Buffer.from([22, 1, 2]);
    const second = Buffer.from([23, 3, 4]);
    const mk = (payload: Buffer) => {
      const message = new Message(methods.BINDING, classes.REQUEST);
      message.appendRawAttribute(DTLS_IN_STUN_DATA, payload);
      return message;
    };

    // Act: 後着 → 先着 → 重複
    const later = session.receiveAuthenticated(mk(second));
    const earlier = session.receiveAuthenticated(mk(first));
    const dup = session.receiveAuthenticated(mk(second));

    // Assert: SPED は並べ替えず inject し、DTLS 側で reorder / replay する
    expect(later.inject?.equals(second)).toBe(true);
    expect(earlier.inject?.equals(first)).toBe(true);
    expect(dup.inject?.equals(second)).toBe(true);
    expect(session.l2Crcs).toHaveLength(3);
  });

  it("handshake complete で L1/L2 を clear する", () => {
    // Arrange
    const session = new SpedSession(0);
    session.replaceL1([Buffer.from([22, 1])]);
    session.queueAck(1);

    // Act
    session.completeHandshake();

    // Assert
    expect(session.state).toBe("complete");
    expect(session.l1Datagrams).toHaveLength(0);
    expect(session.l2Crcs).toHaveLength(0);
  });
});
