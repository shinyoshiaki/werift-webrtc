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
    expect(getRawAttributeValue(onB, DTLS_IN_STUN_DATA)).toBeUndefined();
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

    // Assert: 別 5-tuple は inject / decorate / RTT しない
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
    expect(getRawAttributeValue(onB, DTLS_IN_STUN_DATA)).toBeUndefined();
    expect(getRawAttributeValue(onB, DTLS_IN_STUN_ACK)).toBeUndefined();
    expect(rttMs).toBe(0);
  });
});
