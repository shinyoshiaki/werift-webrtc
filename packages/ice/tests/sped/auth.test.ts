import type { Address } from "../../../common/src";
import { CandidatePair, CandidatePairState } from "../../src";
import { Candidate } from "../../src/candidate";
import { connectionDatagramEvent } from "../../src/internal/datagram";
import { attachSpedToConnection } from "../../src/internal/sped";
import {
  DTLS_IN_STUN_ACK,
  DTLS_IN_STUN_DATA,
} from "../../src/sped/draft00/constants";
import { classes, methods } from "../../src/stun/const";
import { Message, parseMessage } from "../../src/stun/message";
import { getRawAttributeValue } from "../../src/stun/rawAttributeValue";
import { createTestConnection } from "../utils";
import {
  SpedProtocolMock,
  appendStunFingerprint,
  rewriteStunMessageLength,
  serializeStunRawAttribute,
  spedPair,
} from "./helpers";

/** Shared Arrange: SPED connection that records inject / direct DTLS. */
function arrangeSpedInjectProbe() {
  const connection = createTestConnection(true);
  const injected: Buffer[] = [];
  const hello = Buffer.from([22, 1, 2, 3, 4]);
  const forged = Buffer.from([22, 9, 8, 7]);
  const handle = attachSpedToConnection(connection, {
    inject: async (bytes) => {
      injected.push(bytes);
    },
    onFallbackFlight: async () => {},
    setRetransmissionMode: () => {},
    updateRtt: () => {},
    resetRtt: () => {},
    setMtu: () => {},
  });
  handle.session.replaceL1([hello]);
  const protocol = new SpedProtocolMock();
  const sentDirect: Buffer[] = [];
  protocol.sendData = async (data: Buffer, _addr?: Address) => {
    sentDirect.push(Buffer.from(data));
  };
  (connection as any).ensureProtocol(protocol);
  return { connection, injected, forged, protocol, sentDirect };
}

/** Shared Arrange: non-empty checkList so checkIncoming runs on inbound Binding. */
function seedDummyPair(
  connection: ReturnType<typeof createTestConnection>,
  protocol: SpedProtocolMock,
) {
  const dummy = new CandidatePair(
    protocol,
    new Candidate("d", 1, "udp", 1, "8.8.8.8", 1, "host"),
    true,
  );
  dummy.updateState(CandidatePairState.WAITING);
  connection.checkList.push(dummy);
  return dummy;
}

function currentGenerationBinding(
  connection: ReturnType<typeof createTestConnection>,
  fingerprint: boolean,
) {
  const request = new Message(methods.BINDING, classes.REQUEST);
  request
    .setAttribute("USERNAME", `${connection.localUsername}:remote`)
    .setAttribute("PRIORITY", 1)
    .setAttribute("ICE-CONTROLLED", 1n)
    .addMessageIntegrity(Buffer.from(connection.localPassword));
  if (fingerprint) {
    request.addFingerprint();
  }
  return request;
}

function forgedSpedAttributes(data: Buffer) {
  const ack = Buffer.alloc(4);
  ack.writeUInt32BE(0xdeadbeef, 0);
  return Buffer.concat([
    serializeStunRawAttribute(DTLS_IN_STUN_ACK, ack),
    serializeStunRawAttribute(DTLS_IN_STUN_DATA, data),
  ]);
}

describe("ICE Binding Request 認証境界", () => {
  it("誤 HMAC の Binding Request は drop する", async () => {
    // Arrange
    const connection = createTestConnection(true);
    const protocol = new SpedProtocolMock();
    (connection as any).ensureProtocol(protocol);
    const request = new Message(methods.BINDING, classes.REQUEST);
    request
      .setAttribute("USERNAME", `${connection.localUsername}:remote`)
      .setAttribute("PRIORITY", 1)
      .addMessageIntegrity(Buffer.from("wrong-password"))
      .addFingerprint();

    // Act
    protocol.onRequestReceived.execute(request, ["1.2.3.4", 1], request.bytes);

    // Assert
    expect(protocol.sentMessage).toBeUndefined();
    expect(connection.checkList).toHaveLength(0);
  });

  it("old generation の認証済み request は current SPED を更新しない", async () => {
    // Arrange
    const connection = createTestConnection(true);
    const oldUser = connection.localUsername;
    const oldPass = connection.localPassword;
    const injected: Buffer[] = [];
    attachSpedToConnection(connection, {
      inject: async (bytes) => {
        injected.push(bytes);
      },
      onFallbackFlight: async () => {},
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: () => {},
    });
    await connection.restart();
    const protocol = new SpedProtocolMock();
    (connection as any).ensureProtocol(protocol);
    const request = new Message(methods.BINDING, classes.REQUEST);
    request
      .setAttribute("USERNAME", `${oldUser}:remote`)
      .setAttribute("PRIORITY", 1);
    request.appendRawAttribute(DTLS_IN_STUN_DATA, Buffer.from([22, 1, 2]));
    request.addMessageIntegrity(Buffer.from(oldPass)).addFingerprint();

    // Act
    protocol.onRequestReceived.execute(request, ["1.2.3.4", 9], request.bytes);
    await new Promise((r) => setTimeout(r, 20));

    // Assert: 旧 generation へは STUN response を返すが SPED inject しない
    expect(injected).toHaveLength(0);
    expect(protocol.sentMessage?.messageClass).toBe(classes.RESPONSE);
    expect(connection.checkList).toHaveLength(0);
  });

  it("pair.rtt 秒は carrier ミリ秒へ変換する", () => {
    // Arrange
    let rttMs = 0;
    const connection = createTestConnection(true);
    const handle = attachSpedToConnection(connection, {
      inject: async () => {},
      onFallbackFlight: async () => {},
      setRetransmissionMode: () => {},
      updateRtt: (ms) => {
        rttMs = ms;
      },
      resetRtt: () => {},
      setMtu: () => {},
    });
    const protocol = new SpedProtocolMock() as any;
    const pair = new CandidatePair(
      protocol,
      new Candidate("f", 1, "udp", 1, "1.2.3.4", 1, "host"),
      true,
    );
    pair.rtt = 0.05;

    // Act
    handle.runtime.syncRtt(pair);

    // Assert
    expect(rttMs).toBe(50);
  });

  it("pair 未生成の current-generation Binding は direct fallback しない", async () => {
    // Arrange: checkList が空なので pair ができない
    const connection = createTestConnection(true);
    const hello = Buffer.from([22, 9, 8, 7, 6]);
    const fallback: Buffer[] = [];
    const sentDirect: Buffer[] = [];
    const handle = attachSpedToConnection(connection, {
      inject: async () => {},
      onFallbackFlight: async (packets) => {
        fallback.push(...packets.map((packet) => Buffer.from(packet)));
      },
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: () => {},
    });
    handle.session.replaceL1([hello]);
    const protocol = new SpedProtocolMock();
    protocol.sendData = async (data: Buffer, _addr?: Address) => {
      sentDirect.push(Buffer.from(data));
    };
    (connection as any).ensureProtocol(protocol);
    const request = currentGenerationBinding(connection, true);

    // Act: DATA の無い Binding を pair 無しで認証する
    protocol.onRequestReceived.execute(request, ["1.2.3.4", 9], request.bytes);
    await new Promise((r) => setTimeout(r, 30));

    // Assert: STUN 応答は返すが pair が無いので capability も raw DTLS も動かない
    expect(protocol.sentMessage?.messageClass).toBe(classes.RESPONSE);
    expect(connection.checkList).toHaveLength(0);
    expect(fallback).toHaveLength(0);
    expect(sentDirect).toHaveLength(0);
    expect(handle.session.state).toBe("probing");
    expect(handle.session.peerSupport).toBe("unknown");
    expect(handle.runtime.fallbackStarted).toBe(false);
    expect(handle.runtime.lastPath).toBeUndefined();
  });

  it("認証済み pair がある DATA 無し Binding は exact same L1 で fallback する", async () => {
    // Arrange
    const connection = createTestConnection(true);
    const hello = Buffer.from([22, 9, 8, 7, 6]);
    const fallback: Buffer[] = [];
    const sentDirect: Buffer[] = [];
    const sentAddr: Address[] = [];
    const handle = attachSpedToConnection(connection, {
      inject: async () => {},
      onFallbackFlight: async (packets) => {
        fallback.push(...packets.map((packet) => Buffer.from(packet)));
      },
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: () => {},
    });
    handle.session.replaceL1([hello]);
    const protocol = new SpedProtocolMock();
    protocol.sendData = async (data: Buffer, addr?: Address) => {
      sentDirect.push(Buffer.from(data));
      if (addr) {
        sentAddr.push(addr);
      }
    };
    (connection as any).ensureProtocol(protocol);
    seedDummyPair(connection, protocol);
    const request = currentGenerationBinding(connection, true);

    // Act: DATA の無い current-generation Binding を認証する
    protocol.onRequestReceived.execute(request, ["1.2.3.4", 9], request.bytes);
    await new Promise((r) => setTimeout(r, 30));

    // Assert: 作り直さず元 flight bytes のまま authenticated pair へ送る
    const pair = connection.checkList.find(
      (item) => item.remoteAddr[0] === "1.2.3.4" && item.remoteAddr[1] === 9,
    );
    expect(pair).toBeDefined();
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.equals(hello)).toBe(true);
    expect(sentDirect).toHaveLength(1);
    expect(sentDirect[0]!.equals(hello)).toBe(true);
    expect(sentAddr).toEqual([["1.2.3.4", 9]]);
    expect(handle.session.state).toBe("fallback");
    expect(handle.runtime.lastPath).toBe(pair);
  });

  it("earlyChecks のあと pair ができてから exact same L1 を fallback する", async () => {
    // Arrange: 最初は pair が無く、connect 相当で earlyChecks を流す
    const connection = createTestConnection(true);
    const hello = Buffer.from([22, 1, 2, 3, 4]);
    const sentDirect: Buffer[] = [];
    const handle = attachSpedToConnection(connection, {
      inject: async () => {},
      onFallbackFlight: async () => {},
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: () => {},
    });
    handle.session.replaceL1([hello]);
    const protocol = new SpedProtocolMock();
    protocol.sendData = async (data: Buffer) => {
      sentDirect.push(Buffer.from(data));
    };
    (connection as any).ensureProtocol(protocol);
    const request = currentGenerationBinding(connection, true);

    // Act: pair 無し Binding のあと checkIncoming 相当で pair を作り再送機会を与える
    protocol.onRequestReceived.execute(request, ["1.2.3.4", 9], request.bytes);
    await new Promise((r) => setTimeout(r, 20));
    expect(sentDirect).toHaveLength(0);
    connection.checkIncoming(request, ["1.2.3.4", 9], protocol);
    protocol.onRequestReceived.execute(request, ["1.2.3.4", 9], request.bytes);
    await new Promise((r) => setTimeout(r, 30));

    // Assert: pair 生成後に初めて元 L1 を direct 送信する
    expect(sentDirect).toHaveLength(1);
    expect(sentDirect[0]!.equals(hello)).toBe(true);
    expect(handle.runtime.lastPath?.remoteAddr).toEqual(["1.2.3.4", 9]);
  });

  it("pair A の fallback 後に candidate B の Binding が来ても lastPath は A のまま", async () => {
    // Arrange: A で association を開始できるよう dummy pair を置く
    const connection = createTestConnection(true);
    const hello = Buffer.from([22, 9, 8, 7]);
    const sentA: Buffer[] = [];
    const sentB: Buffer[] = [];
    const handle = attachSpedToConnection(connection, {
      inject: async () => {},
      onFallbackFlight: async () => {},
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: () => {},
    });
    handle.session.replaceL1([hello]);
    const protocolA = new SpedProtocolMock();
    protocolA.sendData = async (data: Buffer) => {
      sentA.push(Buffer.from(data));
    };
    (connection as any).ensureProtocol(protocolA);
    seedDummyPair(connection, protocolA);
    const requestA = currentGenerationBinding(connection, true);

    // Act: A で fallback したあと、別 candidate B の認証済み Binding を入れる
    protocolA.onRequestReceived.execute(
      requestA,
      ["1.2.3.4", 9],
      requestA.bytes,
    );
    await new Promise((r) => setTimeout(r, 30));
    const pairA = handle.runtime.lastPath;
    const protocolB = new SpedProtocolMock();
    protocolB.localCandidate = new Candidate(
      "b",
      1,
      "udp",
      20,
      "5.6.7.8",
      5678,
      "host",
    );
    protocolB.sendData = async (data: Buffer) => {
      sentB.push(Buffer.from(data));
    };
    (connection as any).ensureProtocol(protocolB);
    const requestB = currentGenerationBinding(connection, true);
    protocolB.onRequestReceived.execute(
      requestB,
      ["9.9.9.9", 99],
      requestB.bytes,
    );
    await new Promise((r) => setTimeout(r, 30));

    // Assert: B へは DTLS を送らず、handshake path は A に固定されたまま
    expect(sentA).toHaveLength(1);
    expect(sentA[0]!.equals(hello)).toBe(true);
    expect(sentB).toHaveLength(0);
    expect(handle.runtime.lastPath).toBe(pairA);
    expect(handle.runtime.lastPath?.remoteAddr).toEqual(["1.2.3.4", 9]);
  });

  it("restart 後の旧 generation 応答は session 更新・inject 前に破棄する", async () => {
    // Arrange
    const injected: Buffer[] = [];
    const connection = createTestConnection(true);
    const handle = attachSpedToConnection(connection, {
      inject: async (bytes) => {
        injected.push(bytes);
      },
      onFallbackFlight: async () => {},
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: () => {},
    });
    const protocol = new SpedProtocolMock();
    const pair = spedPair(protocol, "host");
    const staleGeneration = connection.generation;
    await connection.restart();
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.setAttribute("USERNAME", "a:b").setAttribute("PRIORITY", 1);
    request.appendRawAttribute(DTLS_IN_STUN_DATA, Buffer.from([22, 1, 2]));

    // Act: 新 generation の runtime に旧 generation を渡す
    const result = await handle.runtime.handleAuthenticatedStun(
      request,
      ["1.2.3.4", 9],
      staleGeneration,
      pair,
    );

    // Assert: inject せず、新 session の L2 / peerSupport も汚さない
    expect(injected).toHaveLength(0);
    expect(result.fallback).toBe(false);
    expect(handle.session.l2Crcs).toHaveLength(0);
    expect(handle.session.peerSupport).toBe("unknown");
    expect(handle.session.generation).toBe(connection.generation);
  });

  it("inject 待ち中の ICE restart は旧 handshake を DTLS に渡さない", async () => {
    // Arrange
    const injected: Buffer[] = [];
    const connection = createTestConnection(true);
    const handle = attachSpedToConnection(connection, {
      inject: async (bytes) => {
        injected.push(bytes);
      },
      onFallbackFlight: async () => {},
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: () => {},
    });
    const protocol = new SpedProtocolMock();
    const pair = spedPair(protocol, "host");
    const generation = connection.generation;
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.setAttribute("USERNAME", "a:b").setAttribute("PRIORITY", 1);
    request.appendRawAttribute(DTLS_IN_STUN_DATA, Buffer.from([22, 1, 2]));

    // Act: inject が 1 tick 待つ間に restart する
    const pending = handle.runtime.handleAuthenticatedStun(
      request,
      ["1.2.3.4", 9],
      generation,
      pair,
    );
    void connection.restart();
    const result = await pending;

    // Assert: 旧 generation の inject は捨て、新 session は probing のまま
    expect(injected).toHaveLength(0);
    expect(result.fallback).toBe(false);
    expect(handle.session.peerSupport).toBe("unknown");
    expect(handle.session.l2Crcs).toHaveLength(0);
  });

  it("認証済み Binding Request 直後の WAITING pair は raw DTLS を通す", async () => {
    // Arrange: checkList を空でない状態にして checkIncoming を走らせる
    const connection = createTestConnection(true);
    const protocol = new SpedProtocolMock();
    (connection as any).ensureProtocol(protocol);
    const dummy = new CandidatePair(
      protocol,
      new Candidate("d", 1, "udp", 1, "8.8.8.8", 1, "host"),
      true,
    );
    dummy.updateState(CandidatePairState.WAITING);
    connection.checkList.push(dummy);
    const request = new Message(methods.BINDING, classes.REQUEST);
    request
      .setAttribute("USERNAME", `${connection.localUsername}:remote`)
      .setAttribute("PRIORITY", 1)
      .setAttribute("ICE-CONTROLLED", 1n)
      .addMessageIntegrity(Buffer.from(connection.localPassword))
      .addFingerprint();
    const seen: boolean[] = [];
    connectionDatagramEvent(connection).subscribe((ctx) => {
      seen.push(ctx.authenticated);
    });

    // Act: 認証済み request で pair を作り、triggered check 完了前の WAITING に戻して DTLS を流す
    protocol.onRequestReceived.execute(request, ["1.2.3.4", 9], request.bytes);
    await new Promise((r) => setTimeout(r, 30));
    const pair = connection.checkList.find(
      (item) => item.remoteAddr[0] === "1.2.3.4" && item.remoteAddr[1] === 9,
    );
    expect(pair).toBeDefined();
    expect(pair!.requestsReceived).toBeGreaterThan(0);
    pair!.updateState(CandidatePairState.WAITING);
    pair!.responsesReceived = 0;
    protocol.onDataReceived.execute(Buffer.from([22, 1, 2, 3]), ["1.2.3.4", 9]);

    // Assert: Binding Request 受信だけで inbound DTLS を通す（送信経路と同じ）
    expect(pair!.state).toBe(CandidatePairState.WAITING);
    expect(pair!.responsesReceived).toBe(0);
    expect(seen).toEqual([true]);
  });

  it("MESSAGE-INTEGRITY 後の DATA/ACK は DTLS に inject されない", async () => {
    // Arrange: HMAC 対象外へ DATA/ACK を挿し、FINGERPRINT だけ付け直す
    const { connection, injected, forged, protocol, sentDirect } =
      arrangeSpedInjectProbe();
    const request = currentGenerationBinding(connection, false);
    const tampered = appendStunFingerprint(
      Buffer.concat([request.bytes, forgedSpedAttributes(forged)]),
    );

    // Act: 認証付き parse を通る wire を Binding Request として渡す
    const verified = parseMessage(
      tampered,
      Buffer.from(connection.localPassword),
    );
    protocol.onRequestReceived.execute(request, ["1.2.3.4", 9], tampered);
    await new Promise((r) => setTimeout(r, 30));

    // Assert: DATA/ACK は属性に出ず、forged payload は inject されない
    expect(verified).toBeDefined();
    expect(getRawAttributeValue(verified!, DTLS_IN_STUN_DATA)).toBeUndefined();
    expect(getRawAttributeValue(verified!, DTLS_IN_STUN_ACK)).toBeUndefined();
    expect(injected).toHaveLength(0);
    expect(injected.some((bytes) => bytes.equals(forged))).toBe(false);
    expect(sentDirect.some((bytes) => bytes.equals(forged))).toBe(false);
  });

  it("FINGERPRINT 後の DATA/ACK は DTLS に inject されない", async () => {
    // Arrange: 長さフィールドを更新して FP の後ろへ DATA/ACK を足す
    const { connection, injected, forged, protocol, sentDirect } =
      arrangeSpedInjectProbe();
    const request = currentGenerationBinding(connection, true);
    const tampered = rewriteStunMessageLength(
      Buffer.concat([request.bytes, forgedSpedAttributes(forged)]),
    );

    // Act: 認証付き parse を通る wire を Binding Request として渡す
    const verified = parseMessage(
      tampered,
      Buffer.from(connection.localPassword),
    );
    protocol.onRequestReceived.execute(request, ["1.2.3.4", 9], tampered);
    await new Promise((r) => setTimeout(r, 30));

    // Assert: DATA/ACK は属性に出ず、forged payload は inject されない
    expect(verified).toBeDefined();
    expect(getRawAttributeValue(verified!, DTLS_IN_STUN_DATA)).toBeUndefined();
    expect(getRawAttributeValue(verified!, DTLS_IN_STUN_ACK)).toBeUndefined();
    expect(injected).toHaveLength(0);
    expect(injected.some((bytes) => bytes.equals(forged))).toBe(false);
    expect(sentDirect.some((bytes) => bytes.equals(forged))).toBe(false);
  });
});
