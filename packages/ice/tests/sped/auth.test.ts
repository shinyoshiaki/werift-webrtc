import { type Address, Event } from "../../../common/src";
import { CandidatePair } from "../../src";
import { Candidate } from "../../src/candidate";
import { Connection } from "../../src/ice";
import { attachSpedToConnection } from "../../src/internal/sped";
import { DTLS_IN_STUN_DATA } from "../../src/sped/draft00/constants";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import type { Protocol } from "../../src/types/model";
import { createTestConnection } from "../utils";

class ProtocolMock implements Protocol {
  type = "mock";
  onRequestReceived: Event<[Message, any, Buffer]> = new Event();
  onDataReceived: Event<[Buffer, any]> = new Event();
  localCandidate = new Candidate(
    "some-foundation",
    1,
    "udp",
    1234,
    "1.2.3.4",
    1234,
    "host",
  );
  sentMessage?: Message;
  request = async () => null as any;
  sendStun = async (message: Message) => {
    this.sentMessage = message;
  };
  async connectionMade() {}
  async sendData(_data: Buffer, _addr?: Address) {}
  async close() {}
}

describe("ICE Binding Request 認証境界", () => {
  it("誤 HMAC の Binding Request は drop する", async () => {
    // Arrange
    const connection = createTestConnection(true);
    const protocol = new ProtocolMock();
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
      setMtu: () => {},
    });
    await connection.restart();
    const protocol = new ProtocolMock();
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
      setMtu: () => {},
    });
    const protocol = new ProtocolMock() as any;
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

  it("DATA 無しの current-generation Binding は exact same L1 で fallback する", async () => {
    // Arrange
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
      setMtu: () => {},
    });
    handle.session.replaceL1([hello]);
    const protocol = new ProtocolMock();
    protocol.sendData = async (data: Buffer, _addr?: Address) => {
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

    // Act: DATA の無い current-generation Binding を認証する
    protocol.onRequestReceived.execute(request, ["1.2.3.4", 9], request.bytes);
    await new Promise((r) => setTimeout(r, 30));

    // Assert: 作り直さず元 flight bytes のまま direct 送信する
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.equals(hello)).toBe(true);
    expect(sentDirect).toHaveLength(1);
    expect(sentDirect[0]!.equals(hello)).toBe(true);
    expect(handle.session.state).toBe("fallback");
  });
});
