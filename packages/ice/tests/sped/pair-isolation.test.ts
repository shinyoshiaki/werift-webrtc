import { CandidatePair, CandidatePairState } from "../../src";
import { Candidate } from "../../src/candidate";
import {
  attachSpedToConnection,
  isSpedEligiblePair,
  sameCandidatePair,
  spedDataCrc32,
} from "../../src/internal/sped";
import {
  DTLS_IN_STUN_ACK,
  DTLS_IN_STUN_DATA,
} from "../../src/sped/draft00/constants";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { getRawAttributeValue } from "../../src/stun/rawAttributeValue";
import { createTestConnection } from "../utils";
import { SpedProtocolMock, spedPair, tcpSpedPair } from "./helpers";

function arrangeSpedRuntime() {
  const connection = createTestConnection(true);
  const injected: Buffer[] = [];
  const handle = attachSpedToConnection(connection, {
    inject: async (bytes) => {
      injected.push(Buffer.from(bytes));
    },
    onFallbackFlight: async () => {},
    setRetransmissionMode: () => {},
    updateRtt: () => {},
    resetRtt: () => {},
    setMtu: () => {},
  });
  return { connection, handle, injected };
}

function bindingWithData(data: Buffer) {
  const message = new Message(methods.BINDING, classes.RESPONSE);
  message.appendRawAttribute(DTLS_IN_STUN_DATA, data);
  return message;
}

describe("SPED pair eligibility と lastPath isolation", () => {
  it("host ↔ relay pair には C070/C071 を付けない", () => {
    // Arrange
    const { handle } = arrangeSpedRuntime();
    handle.session.replaceL1([Buffer.from([22, 1, 2, 3])]);
    const protocol = new SpedProtocolMock();
    const relayPair = spedPair(protocol, "relay", "203.0.113.1", 3478);
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.setAttribute("USERNAME", "a:b").setAttribute("PRIORITY", 1);

    // Act
    const ok = handle.runtime.decorateOutgoing(request, relayPair);

    // Assert: TURN 経路の Binding は SPED 対象外
    expect(isSpedEligiblePair(relayPair)).toBe(false);
    expect(ok).toBe(true);
    expect(getRawAttributeValue(request, DTLS_IN_STUN_DATA)).toBeUndefined();
    expect(getRawAttributeValue(request, DTLS_IN_STUN_ACK)).toBeUndefined();
  });

  it("relay response が先でも fallback せず、host↔host DATA で supported になる", async () => {
    // Arrange
    const { handle, injected } = arrangeSpedRuntime();
    const generation = handle.session.generation;
    const protocol = new SpedProtocolMock();
    const relayPair = spedPair(protocol, "relay", "203.0.113.1", 3478);
    const hostPair = spedPair(protocol, "host", "192.0.2.9", 9);
    const hello = Buffer.from([22, 0xfe, 0xfd, 0x00, 0x01]);

    // Act: relay の DATA 無し応答を先に処理する
    const relayResult = await handle.runtime.handleAuthenticatedStun(
      new Message(methods.BINDING, classes.RESPONSE),
      ["203.0.113.1", 3478],
      generation,
      relayPair,
    );

    // Assert: capability は未確定のまま
    expect(relayResult.fallback).toBe(false);
    expect(handle.session.peerSupport).toBe("unknown");
    expect(handle.session.state).toBe("probing");
    expect(handle.runtime.lastPath).toBeUndefined();

    // Act: その後 host↔host の DATA 付き応答を処理する
    const hostResult = await handle.runtime.handleAuthenticatedStun(
      bindingWithData(hello),
      ["192.0.2.9", 9],
      generation,
      hostPair,
    );

    // Assert: 正常 pair で supported / active になり inject する
    expect(hostResult.fallback).toBe(false);
    expect(hostResult.inject?.equals(hello)).toBe(true);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.equals(hello)).toBe(true);
    expect(handle.session.peerSupport).toBe("supported");
    expect(handle.session.state).toBe("active");
    expect(handle.runtime.lastPath).toBe(hostPair);
  });

  it("pin 後の別 candidate DATA は inject せず ACK にも載せない", async () => {
    // Arrange
    const { handle, injected } = arrangeSpedRuntime();
    const generation = handle.session.generation;
    handle.session.replaceL1([Buffer.from([22, 1])]);
    const protocolA = new SpedProtocolMock();
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
    const pairA = spedPair(protocolA, "host", "1.2.3.4", 9);
    const pairB = spedPair(protocolB, "host", "9.9.9.9", 99);
    const dataA = Buffer.from([22, 0xa, 0xa]);
    const dataB = Buffer.from([22, 0xb, 0xb]);

    // Act: A で supported にして pin したあと、B の別 DATA を入れる
    await handle.runtime.handleAuthenticatedStun(
      bindingWithData(dataA),
      pairA.remoteAddr,
      generation,
      pairA,
    );
    const afterA = handle.session.l2Crcs.slice();
    const resultB = await handle.runtime.handleAuthenticatedStun(
      bindingWithData(dataB),
      pairB.remoteAddr,
      generation,
      pairB,
    );

    // Assert: B は session に混入しない
    expect(injected.map((bytes) => bytes.toString("hex"))).toEqual([
      dataA.toString("hex"),
    ]);
    expect(resultB.inject).toBeUndefined();
    expect(handle.runtime.lastPath).toBe(pairA);
    expect(afterA).toEqual([spedDataCrc32(dataA)]);
    expect(handle.session.l2Crcs).toEqual(afterA);
    expect(handle.session.l2Crcs).not.toContain(spedDataCrc32(dataB));

    const ackOnA = new Message(methods.BINDING, classes.REQUEST);
    handle.runtime.decorateOutgoing(ackOnA, pairA);
    const ackValue = getRawAttributeValue(ackOnA, DTLS_IN_STUN_ACK);
    expect(ackValue?.readUInt32BE(0)).toBe(spedDataCrc32(dataA));
    expect(ackValue?.length).toBe(4);
  });

  it("pin 後に B が nominated でも outgoing SPED DATA は A だけ", () => {
    // Arrange
    const { handle } = arrangeSpedRuntime();
    const hello = Buffer.from([22, 1, 2, 3, 4]);
    handle.session.replaceL1([hello]);
    handle.session.noteAuthenticatedBindingHasData(true);
    const protocolA = new SpedProtocolMock();
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
    const pairA = spedPair(protocolA, "host", "1.2.3.4", 9);
    const pairB = spedPair(protocolB, "host", "9.9.9.9", 99);
    pairB.updateState(CandidatePairState.SUCCEEDED);
    pairB.nominated = true;
    handle.runtime.pinHandshakePath(pairA);

    // Act
    const onA = new Message(methods.BINDING, classes.REQUEST);
    const onB = new Message(methods.BINDING, classes.REQUEST);
    handle.runtime.decorateOutgoing(onA, pairA);
    handle.runtime.decorateOutgoing(onB, pairB);

    // Assert: B が SUCCEEDED / nominated でも SPED は pin 済み A のみ
    expect(getRawAttributeValue(onA, DTLS_IN_STUN_DATA)?.equals(hello)).toBe(
      true,
    );
    expect(getRawAttributeValue(onB, DTLS_IN_STUN_DATA)?.length).toBe(0);
    expect(getRawAttributeValue(onB, DTLS_IN_STUN_ACK)).toBeUndefined();
    expect(handle.runtime.lastPath).toBe(pairA);
  });

  it("isSpedEligiblePair は local host × remote relay を除外する", () => {
    // Arrange
    const protocol = new SpedProtocolMock();
    const hostHost = spedPair(protocol, "host");
    const hostRelay = spedPair(protocol, "relay");
    const localRelay = new SpedProtocolMock();
    localRelay.localCandidate = new Candidate(
      "relay-local",
      1,
      "udp",
      1,
      "203.0.113.2",
      9,
      "relay",
    );
    const relayHost = new CandidatePair(
      localRelay,
      new Candidate("r", 1, "udp", 1, "192.0.2.1", 9, "host"),
      true,
    );

    // Act / Assert
    expect(isSpedEligiblePair(hostHost)).toBe(true);
    expect(isSpedEligiblePair(hostRelay)).toBe(false);
    expect(isSpedEligiblePair(relayHost)).toBe(false);
    const hostPrflx = spedPair(protocol, "prflx");
    expect(isSpedEligiblePair(hostPrflx)).toBe(false);
    const tcpPrflx = tcpSpedPair({
      localType: "passive",
      remoteType: "active",
    });
    tcpPrflx.remoteCandidate.type = "prflx";
    expect(isSpedEligiblePair(tcpPrflx)).toBe(true);
  });

  it("empty DATA だけでは lastPath を pin しない", async () => {
    // Arrange
    const { handle, injected } = arrangeSpedRuntime();
    const generation = handle.session.generation;
    const pairA = spedPair(new SpedProtocolMock(), "host", "1.2.3.4", 9);
    const pairB = spedPair(new SpedProtocolMock(), "host", "9.9.9.9", 99);
    const empty = new Message(methods.BINDING, classes.RESPONSE);
    empty.appendRawAttribute(DTLS_IN_STUN_DATA, Buffer.alloc(0));
    const hello = Buffer.from([22, 0xfe, 0xfd, 0x00]);

    // Act: capability 広告のあと、別 pair の非空 DATA で association する
    await handle.runtime.handleAuthenticatedStun(
      empty,
      pairA.remoteAddr,
      generation,
      pairA,
    );
    expect(handle.runtime.lastPath).toBeUndefined();
    expect(handle.session.peerSupport).toBe("supported");

    const resultB = await handle.runtime.handleAuthenticatedStun(
      bindingWithData(hello),
      pairB.remoteAddr,
      generation,
      pairB,
    );

    // Assert: pin は非空 DATA の pair B
    expect(resultB.inject?.equals(hello)).toBe(true);
    expect(injected).toHaveLength(1);
    expect(handle.runtime.lastPath).toBe(pairB);
  });

  it("同一 IP でも別 TCP protocol/port は pin 後に混入しない", async () => {
    // Arrange
    const { handle, injected } = arrangeSpedRuntime();
    const generation = handle.session.generation;
    let rttMs = 0;
    handle.runtime.hooks.updateRtt = (ms) => {
      rttMs = ms;
    };
    const active = tcpSpedPair({
      localType: "active",
      remoteType: "passive",
      localHost: "192.0.2.1",
      remoteHost: "192.0.2.2",
      remotePort: 5000,
    });
    const passive = tcpSpedPair({
      localType: "passive",
      remoteType: "active",
      localHost: "192.0.2.1",
      remoteHost: "192.0.2.2",
      remotePort: 40000,
    });
    passive.rtt = 0.04;
    const dataA = Buffer.from([22, 0xa1]);
    const dataB = Buffer.from([22, 0xb2]);
    handle.session.replaceL1([Buffer.from([22, 1])]);

    // Act: A を pin したあと、同じ IP の別 TCP pair から DATA / RTT を入れる
    await handle.runtime.handleAuthenticatedStun(
      bindingWithData(dataA),
      active.remoteAddr,
      generation,
      active,
    );
    const afterA = handle.session.l2Crcs.slice();
    const resultB = await handle.runtime.handleAuthenticatedStun(
      bindingWithData(dataB),
      passive.remoteAddr,
      generation,
      passive,
    );
    handle.runtime.syncRtt(passive);

    const onB = new Message(methods.BINDING, classes.REQUEST);
    handle.runtime.decorateOutgoing(onB, passive);

    // Assert: 別 5-tuple は inject / L1 / ACK / RTT しない。空 C070 だけ載せる
    expect(sameCandidatePair(active, passive)).toBe(false);
    expect(isSpedEligiblePair(active)).toBe(true);
    expect(isSpedEligiblePair(passive)).toBe(true);
    expect(resultB.inject).toBeUndefined();
    expect(injected.map((bytes) => bytes.toString("hex"))).toEqual([
      dataA.toString("hex"),
    ]);
    expect(handle.runtime.lastPath).toBe(active);
    expect(handle.session.l2Crcs).toEqual(afterA);
    expect(handle.session.l2Crcs).not.toContain(spedDataCrc32(dataB));
    expect(getRawAttributeValue(onB, DTLS_IN_STUN_DATA)?.length).toBe(0);
    expect(getRawAttributeValue(onB, DTLS_IN_STUN_ACK)).toBeUndefined();
    expect(rttMs).toBe(0);
  });

  it("C070 無し UDP prflx は EOC かつ authenticated まで capability を保留する", async () => {
    // Arrange
    const { handle } = arrangeSpedRuntime();
    const generation = handle.session.generation;
    const prflx = spedPair(new SpedProtocolMock(), "prflx", "192.0.2.10", 1000);
    const empty = new Message(methods.BINDING, classes.RESPONSE);

    // Act: missing C070 を先に処理する
    await handle.runtime.handleAuthenticatedStun(
      empty,
      prflx.remoteAddr,
      generation,
      prflx,
    );

    // Assert: 保留中。EOC なし / 未認証 / 未 nominated では確定しない
    expect(handle.session.peerSupport).toBe("unknown");
    handle.runtime.settleUnconfirmedPair(prflx, {
      endOfCandidates: false,
      authenticated: true,
      nominated: false,
    });
    expect(handle.session.peerSupport).toBe("unknown");
    handle.runtime.settleUnconfirmedPair(prflx, {
      endOfCandidates: true,
      authenticated: false,
      nominated: false,
    });
    expect(handle.session.peerSupport).toBe("unknown");

    // Act: EOC なしでも nominated な lasting prflx
    handle.runtime.settleUnconfirmedPair(prflx, {
      endOfCandidates: false,
      authenticated: true,
      nominated: true,
    });

    // Assert: missing C070 を unsupported として確定する
    expect(handle.session.peerSupport).toBe("unsupported");
    expect(handle.session.state).toBe("fallback");
  });

  it("C070 無し UDP prflx は EOC だけでも capability を確定する", async () => {
    // Arrange
    const { handle } = arrangeSpedRuntime();
    const generation = handle.session.generation;
    const prflx = spedPair(new SpedProtocolMock(), "prflx", "192.0.2.11", 1001);
    const empty = new Message(methods.BINDING, classes.RESPONSE);

    await handle.runtime.handleAuthenticatedStun(
      empty,
      prflx.remoteAddr,
      generation,
      prflx,
    );

    // Act: nominated 前でも EOC なら lasting prflx とみなす
    handle.runtime.settleUnconfirmedPair(prflx, {
      endOfCandidates: true,
      authenticated: true,
      nominated: false,
    });

    // Assert
    expect(handle.session.peerSupport).toBe("unsupported");
    expect(handle.session.state).toBe("fallback");
  });

  it("host 昇格でも未認証 pair では missing C070 を確定しない", async () => {
    // Arrange: C070 無し Binding のあと type だけ host にする
    const { handle } = arrangeSpedRuntime();
    const generation = handle.session.generation;
    const pair = spedPair(new SpedProtocolMock(), "prflx", "192.0.2.12", 1002);
    await handle.runtime.handleAuthenticatedStun(
      new Message(methods.BINDING, classes.RESPONSE),
      pair.remoteAddr,
      generation,
      pair,
    );
    pair.remoteCandidate.type = "host";

    // Act: eligible だが authenticated=false のまま settle する
    const locked = handle.runtime.settleUnconfirmedPair(pair, {
      endOfCandidates: false,
      authenticated: false,
      nominated: false,
    });

    // Assert: pending は残し、認証済み pair を待つ
    expect(locked).toBe(false);
    expect(handle.session.peerSupport).toBe("unknown");

    // Act: 同じ pair が authenticated になってから確定する
    expect(
      handle.runtime.settleUnconfirmedPair(pair, {
        endOfCandidates: false,
        authenticated: true,
        nominated: false,
      }),
    ).toBe(true);
    expect(handle.session.peerSupport).toBe("unsupported");
  });

  it("association 未確定時は relay / unconfirmed prflx の RTT を carrier に入れない", () => {
    // Arrange
    let rttMs = 0;
    const { handle } = arrangeSpedRuntime();
    handle.runtime.hooks.updateRtt = (ms) => {
      rttMs = ms;
    };
    const relay = spedPair(
      new SpedProtocolMock(),
      "relay",
      "203.0.113.1",
      3478,
    );
    relay.rtt = 0.3;
    const prflx = spedPair(new SpedProtocolMock(), "prflx", "192.0.2.10", 1000);
    prflx.rtt = 0.2;
    const host = spedPair(new SpedProtocolMock(), "host", "192.0.2.9", 9);
    host.rtt = 0.05;

    // Act: lastPath 未確定のまま relay / prflx を同期する
    handle.runtime.syncRtt(relay);
    handle.runtime.syncRtt(prflx);

    // Assert: SPED 対象外の RTT は捨てる
    expect(rttMs).toBe(0);

    // Act: eligible host と、pin 後の prflx だけ採用する
    handle.runtime.syncRtt(host);
    expect(rttMs).toBe(50);
    handle.runtime.pinHandshakePath(prflx);
    handle.runtime.syncRtt(prflx);

    // Assert: association に pin された prflx の RTT だけ入る
    expect(rttMs).toBe(200);
  });

  it("trickle 前の relay アドレス prflx は capability を確定せず、relay 追加後も対象外", async () => {
    // Arrange: remote candidate 未登録
    const { connection, handle } = arrangeSpedRuntime();
    const protocol = new SpedProtocolMock();
    (connection as any).ensureProtocol(protocol);
    const request = new Message(methods.BINDING, classes.REQUEST);
    request
      .setAttribute("USERNAME", `${connection.localUsername}:remote`)
      .setAttribute("PRIORITY", 1)
      .setAttribute("ICE-CONTROLLED", 1n)
      .addMessageIntegrity(Buffer.from(connection.localPassword))
      .addFingerprint();

    // Act: C070 無し Binding が先着して prflx を学習する
    protocol.onRequestReceived.execute(
      request,
      ["203.0.113.1", 3478],
      request.bytes,
    );
    await new Promise((r) => setTimeout(r, 30));
    const prflxPair = connection.checkList.find(
      (pair) =>
        pair.remoteAddr[0] === "203.0.113.1" && pair.remoteAddr[1] === 3478,
    );

    // Assert: prflx は作るが capability は unknown のまま
    expect(prflxPair).toBeDefined();
    expect(prflxPair!.remoteCandidate.type).toBe("prflx");
    expect(handle.session.peerSupport).toBe("unknown");
    expect(handle.session.state).toBe("probing");
    expect(isSpedEligiblePair(prflxPair!)).toBe(false);

    // Act: 同アドレスを relay として trickle する
    await connection.addRemoteCandidate(
      new Candidate("relay", 1, "udp", 1, "203.0.113.1", 3478, "relay"),
    );

    // Assert: 既存 pair の type が relay になり、引き続き対象外
    expect(prflxPair!.remoteCandidate.type).toBe("relay");
    expect(isSpedEligiblePair(prflxPair!)).toBe(false);
    expect(handle.session.peerSupport).toBe("unknown");
    expect(handle.session.state).toBe("probing");
  });

  it("C070 無し UDP prflx のあと同アドレス host が来たら unsupported に確定する", async () => {
    // Arrange: remote candidate 未登録
    const { connection, handle } = arrangeSpedRuntime();
    const hello = Buffer.from([22, 0xfe, 0xfd, 0x00, 0x01]);
    const sentDirect: Buffer[] = [];
    handle.session.replaceL1([hello]);
    const protocol = new SpedProtocolMock();
    protocol.sendData = async (data: Buffer) => {
      sentDirect.push(Buffer.from(data));
    };
    (connection as any).ensureProtocol(protocol);
    const request = new Message(methods.BINDING, classes.REQUEST);
    request
      .setAttribute("USERNAME", `${connection.localUsername}:remote`)
      .setAttribute("PRIORITY", 1)
      .setAttribute("ICE-CONTROLLED", 1n)
      .addMessageIntegrity(Buffer.from(connection.localPassword))
      .addFingerprint();

    protocol.onRequestReceived.execute(
      request,
      ["203.0.113.1", 3478],
      request.bytes,
    );
    await new Promise((r) => setTimeout(r, 30));
    const prflxPair = connection.checkList[0]!;
    prflxPair.nominated = true;

    // Act: 同アドレスを host として trickle する
    await connection.addRemoteCandidate(
      new Candidate("host", 1, "udp", 1000, "203.0.113.1", 3478, "host"),
    );

    // Assert: 確定した eligible pair の missing C070 は unsupported。元の L1 を直送する
    expect(prflxPair.remoteCandidate.type).toBe("host");
    expect(isSpedEligiblePair(prflxPair)).toBe(true);
    expect(handle.session.peerSupport).toBe("unsupported");
    expect(handle.session.state).toBe("fallback");
    expect(sentDirect).toHaveLength(1);
    expect(sentDirect[0]!.equals(hello)).toBe(true);
  });

  it("adoptExistingPrflx 後は他 protocol とも pair し checklist を再 sort する", async () => {
    // Arrange: 2 つの local UDP protocol。incoming は A だけで prflx を学習
    const { connection } = arrangeSpedRuntime();
    const protocolA = new SpedProtocolMock();
    protocolA.localCandidate = new Candidate(
      "a",
      1,
      "udp",
      20,
      "192.0.2.1",
      1234,
      "host",
    );
    const protocolB = new SpedProtocolMock();
    protocolB.localCandidate = new Candidate(
      "b",
      1,
      "udp",
      10,
      "192.0.2.2",
      1235,
      "host",
    );
    (connection as any).ensureProtocol(protocolA);
    (connection as any).ensureProtocol(protocolB);
    (connection as any).protocols.push(protocolA, protocolB);
    const request = new Message(methods.BINDING, classes.REQUEST);
    request
      .setAttribute("USERNAME", `${connection.localUsername}:remote`)
      .setAttribute("PRIORITY", 1)
      .setAttribute("ICE-CONTROLLED", 1n)
      .addMessageIntegrity(Buffer.from(connection.localPassword))
      .addFingerprint();

    protocolA.onRequestReceived.execute(
      request,
      ["198.51.100.1", 5000],
      request.bytes,
    );
    await new Promise((r) => setTimeout(r, 30));

    // Assert: trickle 前は A-R のみ
    expect(connection.checkList).toHaveLength(1);
    expect(connection.checkList[0]!.protocol).toBe(protocolA);
    expect(connection.checkList[0]!.remoteCandidate.type).toBe("prflx");

    // Act: 同アドレスを高 priority の host として trickle する
    await connection.addRemoteCandidate(
      new Candidate("host", 1, "udp", 1_000_000, "198.51.100.1", 5000, "host"),
    );

    // Assert: B-R も形成され、priority 更新後に sort されている
    const pairB = connection.checkList.find(
      (pair) => pair.protocol === protocolB,
    );
    expect(pairB).toBeDefined();
    expect(pairB!.remoteCandidate.type).toBe("host");
    expect(pairB!.remoteCandidate.priority).toBe(1_000_000);
    expect(connection.checkList[0]!.remoteCandidate.priority).toBe(1_000_000);
  });

  it("prflx→host 昇格の fallback は未認証の高 priority pair ではなく認証済み pair へ送る", async () => {
    // Arrange: A は低 priority で C070 無し Binding を受信。B は高 priority の未認証 local
    const { connection, handle } = arrangeSpedRuntime();
    const hello = Buffer.from([22, 0xfe, 0xfd, 0x00, 0x01]);
    handle.session.replaceL1([hello]);
    const sent: { data: Buffer; protocol: SpedProtocolMock }[] = [];
    const protocolA = new SpedProtocolMock();
    protocolA.localCandidate = new Candidate(
      "a",
      1,
      "udp",
      10,
      "192.0.2.1",
      1234,
      "host",
    );
    const protocolB = new SpedProtocolMock();
    protocolB.localCandidate = new Candidate(
      "b",
      1,
      "udp",
      100,
      "192.0.2.2",
      1235,
      "host",
    );
    const recordSend = (protocol: SpedProtocolMock) => {
      protocol.sendData = async (data: Buffer) => {
        sent.push({ data: Buffer.from(data), protocol });
      };
    };
    recordSend(protocolA);
    recordSend(protocolB);
    (connection as any).ensureProtocol(protocolA);
    (connection as any).ensureProtocol(protocolB);
    (connection as any).protocols.push(protocolA, protocolB);
    const request = new Message(methods.BINDING, classes.REQUEST);
    request
      .setAttribute("USERNAME", `${connection.localUsername}:remote`)
      .setAttribute("PRIORITY", 1)
      .setAttribute("ICE-CONTROLLED", 1n)
      .addMessageIntegrity(Buffer.from(connection.localPassword))
      .addFingerprint();

    protocolA.onRequestReceived.execute(
      request,
      ["198.51.100.1", 5000],
      request.bytes,
    );
    await new Promise((r) => setTimeout(r, 30));
    const pairA = connection.checkList.find(
      (pair) => pair.protocol === protocolA,
    )!;
    pairA.requestsReceived = 1;

    // Act: 同アドレスを host として trickle する。sort 後は B-R が先頭
    await connection.addRemoteCandidate(
      new Candidate("host", 1, "udp", 1, "198.51.100.1", 5000, "host"),
    );
    const pairB = connection.checkList.find(
      (pair) => pair.protocol === protocolB,
    );

    // Assert: 未認証の B-R ではなく、Binding を受けた A-R へ original L1 を直送する
    expect(pairB).toBeDefined();
    expect(connection.checkList[0]).toBe(pairB);
    expect(pairB!.requestsReceived).toBe(0);
    expect(handle.session.peerSupport).toBe("unsupported");
    expect(handle.session.state).toBe("fallback");
    expect(handle.runtime.fallbackStarted).toBe(true);
    expect(handle.runtime.lastPath).toBe(pairA);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.protocol).toBe(protocolA);
    expect(sent[0]!.data.equals(hello)).toBe(true);
  });

  it("UDP prflx に非空 DATA で pin したあとその pair の outgoing は L1 を載せる", async () => {
    // Arrange: trickle 前の prflx と、別ホストの eligible pair
    const { handle, injected } = arrangeSpedRuntime();
    const generation = handle.session.generation;
    const hello = Buffer.from([22, 0xfe, 0xfd, 0x00, 0x01]);
    const serverHello = Buffer.from([22, 0xfe, 0xfd, 0x00, 0x02]);
    const prflx = spedPair(new SpedProtocolMock(), "prflx", "192.0.2.10", 1000);
    const hostB = spedPair(new SpedProtocolMock(), "host", "192.0.2.11", 1001);

    // Act: prflx の ClientHello を inject したあと ServerHello を L1 にする
    await handle.runtime.handleAuthenticatedStun(
      bindingWithData(hello),
      prflx.remoteAddr,
      generation,
      prflx,
    );
    handle.session.replaceL1([serverHello]);
    const onPrflx = new Message(methods.BINDING, classes.RESPONSE);
    handle.runtime.decorateOutgoing(onPrflx, prflx);
    const onHost = new Message(methods.BINDING, classes.RESPONSE);
    handle.runtime.decorateOutgoing(onHost, hostB);

    // Assert: pin 済み prflx だけが association。別 host は空 C070
    expect(isSpedEligiblePair(prflx)).toBe(false);
    expect(handle.runtime.lastPath).toBe(prflx);
    expect(handle.runtime.shouldDecorate(prflx)).toBe(true);
    expect(injected).toHaveLength(1);
    expect(
      getRawAttributeValue(onPrflx, DTLS_IN_STUN_DATA)?.equals(serverHello),
    ).toBe(true);
    expect(getRawAttributeValue(onHost, DTLS_IN_STUN_DATA)?.length).toBe(0);
  });

  it("pin 後の別 pair Response は空 C070 のみで、reorder しても fallback しない", async () => {
    // Arrange
    const server = arrangeSpedRuntime();
    const client = arrangeSpedRuntime();
    const hello = Buffer.from([22, 0xfe, 0xfd, 0x00, 0x01]);
    server.handle.session.replaceL1([hello]);
    const pairA = spedPair(new SpedProtocolMock(), "host", "192.0.2.10", 1000);
    const pairB = spedPair(new SpedProtocolMock(), "host", "192.0.2.11", 1001);
    const clientA = spedPair(
      new SpedProtocolMock(),
      "host",
      "192.0.2.10",
      1000,
    );
    const clientB = spedPair(
      new SpedProtocolMock(),
      "host",
      "192.0.2.11",
      1001,
    );

    // Act: server は A の非空 DATA で pin したあと B の Response を作る
    await server.handle.runtime.handleAuthenticatedStun(
      bindingWithData(hello),
      pairA.remoteAddr,
      server.handle.session.generation,
      pairA,
    );
    const responseB = new Message(methods.BINDING, classes.RESPONSE);
    responseB.setAttribute("XOR-MAPPED-ADDRESS", pairB.remoteAddr);
    server.handle.runtime.decorateOutgoing(responseB, pairB);
    const responseA = new Message(methods.BINDING, classes.RESPONSE);
    responseA.setAttribute("XOR-MAPPED-ADDRESS", pairA.remoteAddr);
    server.handle.runtime.decorateOutgoing(responseA, pairA);

    // Assert: B は C070 空。A の L1 は載せない
    const dataB = getRawAttributeValue(responseB, DTLS_IN_STUN_DATA);
    expect(dataB).toBeDefined();
    expect(dataB!.length).toBe(0);
    expect(getRawAttributeValue(responseB, DTLS_IN_STUN_ACK)).toBeUndefined();
    expect(
      getRawAttributeValue(responseA, DTLS_IN_STUN_DATA)?.equals(hello),
    ).toBe(true);

    // Act: client は B を A より先に処理する
    const first = await client.handle.runtime.handleAuthenticatedStun(
      responseB,
      clientB.remoteAddr,
      client.handle.session.generation,
      clientB,
    );
    const second = await client.handle.runtime.handleAuthenticatedStun(
      responseA,
      clientA.remoteAddr,
      client.handle.session.generation,
      clientA,
    );

    // Assert: reorder しても supported。A で inject する
    expect(first.fallback).toBe(false);
    expect(client.handle.session.peerSupport).toBe("supported");
    expect(client.handle.session.state).not.toBe("fallback");
    expect(second.inject?.equals(hello)).toBe(true);
    expect(client.injected).toHaveLength(1);
    expect(client.handle.runtime.lastPath).toBe(clientA);
  });

  it("SPED × non-SPED の lasting UDP prflx は EOC 後に fallback する", async () => {
    // Arrange: A は SPED、B は non-SPED。A には B の candidate を渡さない
    const a = createTestConnection(true);
    const b = createTestConnection(false);
    const hello = Buffer.from([22, 0xfe, 0xfd, 0x00, 0x01]);
    const sentDirect: Buffer[] = [];
    const handle = attachSpedToConnection(a, {
      inject: async () => {},
      onFallbackFlight: async () => {},
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: () => {},
    });
    handle.session.replaceL1([hello]);

    try {
      await a.gatherCandidates();
      await b.gatherCandidates();
      a.remoteUsername = b.localUsername;
      a.remotePassword = b.localPassword;
      b.remoteUsername = a.localUsername;
      b.remotePassword = a.localPassword;
      for (const protocol of (a as any).protocols as Array<{
        sendData: (data: Buffer, addr?: [string, number]) => Promise<void>;
      }>) {
        const sendData = protocol.sendData.bind(protocol);
        protocol.sendData = async (data, addr) => {
          sentDirect.push(Buffer.from(data));
          return sendData(data, addr);
        };
      }
      for (const candidate of a.localCandidates) {
        await b.addRemoteCandidate(candidate);
      }
      await b.addRemoteCandidate(undefined);

      // Act: B の Binding で A が prflx を学習し、ICE が nominated する
      await Promise.all([a.connect(), b.connect()]);
      await new Promise((r) => setTimeout(r, 30));

      // Assert: EOC 未到着でも nomination で lasting prflx を fallback する
      expect(a.remoteCandidatesEnd).toBe(false);
      expect(a.nominated?.remoteCandidate.type).toBe("prflx");
      expect(handle.session.peerSupport).toBe("unsupported");
      expect(handle.session.state).toBe("fallback");
      expect(sentDirect.some((bytes) => bytes.equals(hello))).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("fallback 開始後の別 pair は lastPath を動かさず再 fallback しない", async () => {
    // Arrange: pair A で missing DATA fallback。B は後から認証される
    const { connection, handle } = arrangeSpedRuntime();
    const hello = Buffer.from([22, 0xfe, 0xfd, 0x00, 0x01]);
    handle.session.replaceL1([hello]);
    const protocolA = new SpedProtocolMock();
    const protocolB = new SpedProtocolMock();
    const pairA = spedPair(protocolA, "host", "1.2.3.4", 9);
    const pairB = spedPair(protocolB, "host", "5.6.7.8", 8);
    pairA.requestsReceived = 1;
    pairB.requestsReceived = 1;
    connection.checkList.push(pairA, pairB);
    const missing = new Message(methods.BINDING, classes.REQUEST);
    missing.setAttribute("USERNAME", "a:b").setAttribute("PRIORITY", 1);

    // Act: A で fallback したあと、B の DATA 無し Binding を処理する
    await handle.runtime.handleAuthenticatedStun(
      missing,
      pairA.remoteAddr,
      connection.generation,
      pairA,
    );
    handle.runtime.pinHandshakePath(pairA);
    handle.runtime.beginFallback();
    await handle.runtime.handleAuthenticatedStun(
      missing,
      pairB.remoteAddr,
      connection.generation,
      pairB,
    );

    // Assert: association は A のまま。B は capability だけで fallback し直さない
    expect(handle.runtime.fallbackStarted).toBe(true);
    expect(handle.runtime.lastPath).toBe(pairA);
    expect(handle.session.state).toBe("fallback");
  });
});
