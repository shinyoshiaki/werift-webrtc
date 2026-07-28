import { afterEach, describe, expect, it, vi } from "vitest";

import { Event } from "../../../common/src";
import {
  CONSENT_RESPONSE_TIMEOUT,
  consentResponseTimeoutMs,
} from "../../src/iceBase";
import { classes, methods } from "../../src/stun/const";
import { Message, parseMessage } from "../../src/stun/message";
import { StunProtocol } from "../../src/stun/protocol";
import { TcpActiveProtocol } from "../../src/stun/tcpProtocol";
import { StunOverTurnProtocol } from "../../src/turn/protocol";

const remotePassword = Buffer.from("remote-password", "utf8");
const peerAddr: [string, number] = ["192.0.2.50", 5000];

function bindingRequest() {
  return new Message(methods.BINDING, classes.REQUEST);
}

function bindingResponse(transactionId: Buffer, key?: Buffer) {
  const response = new Message(
    methods.BINDING,
    classes.RESPONSE,
    transactionId,
  );
  response.setAttribute("XOR-MAPPED-ADDRESS", peerAddr);
  if (key) {
    response.addMessageIntegrity(key).addFingerprint();
  }
  return response;
}

describe("consent wire-level protocol paths", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("StunProtocol: consent request は1回だけ送信し、正しい integrity/address の応答を受理する", async () => {
    // Arrange
    const protocol = new StunProtocol();
    const sentBuffers: Buffer[] = [];
    (protocol as any).transport = {
      closed: false,
      send: async (data: Buffer) => {
        sentBuffers.push(Buffer.from(data));
      },
    };

    const request = bindingRequest();
    const resultPromise = protocol.request(request, peerAddr, remotePassword, {
      retransmissions: 0,
      responseTimeout: CONSENT_RESPONSE_TIMEOUT,
    });

    // Assert: wire 上は1パケット
    expect(sentBuffers.length).toBe(1);
    expect(parseMessage(sentBuffers[0]!)?.transactionIdHex).toBe(
      request.transactionIdHex,
    );

    // Act: 別アドレス応答は無視
    const wrongAddrResponse = bindingResponse(
      request.transactionId,
      remotePassword,
    );
    (protocol as any).datagramReceived(wrongAddrResponse.bytes, [
      "198.51.100.9",
      9,
    ]);

    // Act: 改ざん integrity は無視
    const badKey = Buffer.from("wrong-password", "utf8");
    const badIntegrity = bindingResponse(request.transactionId, badKey);
    (protocol as any).datagramReceived(badIntegrity.bytes, peerAddr);

    // Act: 正しい integrity + address
    const good = bindingResponse(request.transactionId, remotePassword);
    (protocol as any).datagramReceived(good.bytes, peerAddr);

    // Assert
    const [response, addr] = await resultPromise;
    expect(response.messageClass).toBe(classes.RESPONSE);
    expect(addr).toEqual(peerAddr);
    expect(sentBuffers.length).toBe(1);
  });

  it("StunProtocol: retransmissions=0 では応答待ち中に再送しない", async () => {
    // Arrange
    vi.useFakeTimers();
    const protocol = new StunProtocol();
    const sentBuffers: Buffer[] = [];
    (protocol as any).transport = {
      closed: false,
      send: async (data: Buffer) => {
        sentBuffers.push(Buffer.from(data));
      },
    };

    const request = bindingRequest();
    const resultPromise = protocol
      .request(request, peerAddr, remotePassword, {
        retransmissions: 0,
        responseTimeout: 1000,
      })
      .then(
        () => "ok" as const,
        () => "timeout" as const,
      );

    // Act: timeout 直前まで進める
    await vi.advanceTimersByTimeAsync(999);
    expect(sentBuffers.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    // Assert
    expect(await resultPromise).toBe("timeout");
    expect(sentBuffers.length).toBe(1);
    vi.useRealTimers();
  });

  it("TcpActiveProtocol: request options を Transaction に渡し1回送信する", async () => {
    // Arrange: TCP 実ソケットの代わりに sendFrame 経路を差し替え
    const protocol = new TcpActiveProtocol();
    let sendCount = 0;
    (protocol as any).sendFrame = async () => {
      sendCount++;
    };
    // getSocket を bypass するため sendStun を直接カウント
    const originalSendStun = protocol.sendStun.bind(protocol);
    const sent: Message[] = [];
    protocol.sendStun = async (message, addr) => {
      sent.push(message);
      sendCount++;
      // skip real socket write
      void originalSendStun;
      void addr;
    };

    const request = bindingRequest();
    const pending = protocol.request(request, peerAddr, remotePassword, {
      retransmissions: 0,
      responseTimeout: 500,
    });

    // Assert: 送信1回
    expect(sent.length).toBe(1);
    expect(sendCount).toBe(1);

    // Act: integrity 付き応答を TCP frame handler 経由で注入
    const good = bindingResponse(request.transactionId, remotePassword);
    (protocol as any).handleFrame(good.bytes, peerAddr);

    const [response] = await pending;
    expect(response.messageClass).toBe(classes.RESPONSE);
  });

  it("StunOverTurnProtocol: retransmissions=0 を捨てず1回だけ sendStun する", async () => {
    // Arrange: 最小の TurnProtocol スタブ
    const onData = new Event<[Buffer, readonly [string, number]]>();
    const turnStub = {
      transactions: {} as Record<string, any>,
      onData,
      sendData: vi.fn(async () => undefined),
      close: async () => undefined,
    };
    const protocol = new StunOverTurnProtocol(turnStub as any);
    const sent: Message[] = [];
    protocol.sendStun = async (message) => {
      sent.push(message);
    };

    const request = bindingRequest();
    const pending = protocol.request(request, peerAddr, remotePassword, {
      retransmissions: 0,
      responseTimeout: 800,
    });

    // Assert: peer 向け STUN が1回
    expect(sent.length).toBe(1);
    expect(turnStub.transactions[request.transactionIdHex]).toBeDefined();

    // Act: 別アドレスは無視
    const good = bindingResponse(request.transactionId, remotePassword);
    (protocol as any).handleStunMessage(good.bytes, ["198.51.100.1", 9]);

    // Act: 正しい peer アドレス + integrity
    (protocol as any).handleStunMessage(good.bytes, peerAddr);

    const [response, addr] = await pending;
    expect(response.messageClass).toBe(classes.RESPONSE);
    expect(addr).toEqual(peerAddr);
    expect(sent.length).toBe(1);
  });

  it("StunOverTurnProtocol: 不正 MESSAGE-INTEGRITY の応答では consent を完了しない", async () => {
    // Arrange
    vi.useFakeTimers();
    const onData = new Event<[Buffer, readonly [string, number]]>();
    const turnStub = {
      transactions: {} as Record<string, any>,
      onData,
      sendData: async () => undefined,
      close: async () => undefined,
    };
    const protocol = new StunOverTurnProtocol(turnStub as any);
    protocol.sendStun = async () => undefined;

    const request = bindingRequest();
    const pending = protocol
      .request(request, peerAddr, remotePassword, {
        retransmissions: 0,
        responseTimeout: 300,
      })
      .then(
        () => "ok" as const,
        () => "timeout" as const,
      );

    // Act: 誤った鍵で署名された応答
    const bad = bindingResponse(
      request.transactionId,
      Buffer.from("other", "utf8"),
    );
    (protocol as any).handleStunMessage(bad.bytes, peerAddr);
    await vi.advanceTimersByTimeAsync(300);

    // Assert: 受理されず timeout
    expect(await pending).toBe("timeout");
    vi.useRealTimers();
  });

  it("consentResponseTimeoutMs が pair RTT を反映する", () => {
    // Assert
    expect(consentResponseTimeoutMs(0.1)).toBe(500); // floor
    expect(consentResponseTimeoutMs(0.3)).toBe(800); // 2*300+200
    expect(consentResponseTimeoutMs()).toBe(CONSENT_RESPONSE_TIMEOUT);
  });
});
