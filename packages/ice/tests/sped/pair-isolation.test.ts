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

  it("ICE-TCP active/passive の同一ホスト経路は pin 後も SPED を通す", async () => {
    // Arrange
    const { handle, injected } = arrangeSpedRuntime();
    const generation = handle.session.generation;
    const active = tcpSpedPair({
      localType: "active",
      remoteType: "passive",
    });
    const passive = tcpSpedPair({
      localType: "passive",
      remoteType: "active",
    });
    const otherHost = tcpSpedPair({
      localType: "active",
      remoteType: "passive",
      remoteHost: "198.51.100.9",
    });
    const dataActive = Buffer.from([22, 0xa1]);
    const dataPassive = Buffer.from([22, 0xb2]);
    const dataOther = Buffer.from([22, 0xc3]);

    // Act: active を pin したあと、同一ホストの passive と別ホストの DATA を入れる
    await handle.runtime.handleAuthenticatedStun(
      bindingWithData(dataActive),
      active.remoteAddr,
      generation,
      active,
    );
    const resultPassive = await handle.runtime.handleAuthenticatedStun(
      bindingWithData(dataPassive),
      passive.remoteAddr,
      generation,
      passive,
    );
    const resultOther = await handle.runtime.handleAuthenticatedStun(
      bindingWithData(dataOther),
      otherHost.remoteAddr,
      generation,
      otherHost,
    );

    // Assert: ICE-TCP dual は同一 path。別 remote.host は混入しない
    expect(sameCandidatePair(active, passive)).toBe(true);
    expect(sameCandidatePair(active, otherHost)).toBe(false);
    expect(isSpedEligiblePair(active)).toBe(true);
    expect(resultPassive.inject?.equals(dataPassive)).toBe(true);
    expect(resultOther.inject).toBeUndefined();
    expect(injected.map((bytes) => bytes.toString("hex"))).toEqual([
      dataActive.toString("hex"),
      dataPassive.toString("hex"),
    ]);

    const onPassive = new Message(methods.BINDING, classes.REQUEST);
    const onOther = new Message(methods.BINDING, classes.REQUEST);
    handle.runtime.decorateOutgoing(onPassive, passive);
    handle.runtime.decorateOutgoing(onOther, otherHost);
    expect(getRawAttributeValue(onPassive, DTLS_IN_STUN_ACK)).toBeDefined();
    expect(getRawAttributeValue(onOther, DTLS_IN_STUN_DATA)).toBeUndefined();
    expect(getRawAttributeValue(onOther, DTLS_IN_STUN_ACK)).toBeUndefined();
  });
});
