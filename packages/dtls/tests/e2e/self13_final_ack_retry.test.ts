import { expect, test } from "vitest";
import { arrangeDtls13EnginePair } from "../fixture";

/**
 * RFC 9147 §5.8.3: server が client Finished への ACK を送れなかった場合、
 * client は Finished を再送する。再送への ACK が成功したら、server も
 * handshakeComplete に到達しなければならない。
 */
test("e2e/self13 最初の最終 ACK が失敗しても、再送 Finished への ACK 成功で server が handshakeComplete になる", async () => {
  // Arrange: server の受信 datagram に carrier 世代を付け、client Finished
  // 処理中に世代が変わって最初の ACK 送信が reject する状況を作る
  // (失敗は旧世代のものとして捨てられ、association は失敗しない)
  const pair = await arrangeDtls13EnginePair();
  const { server, client, serverTransport } = pair;
  let generation = 0;
  server.expectedRxGeneration = () => generation;
  const deliver = serverTransport.onData as (
    data: Buffer,
    addr: unknown,
    meta?: { rxGeneration?: number },
  ) => void;
  serverTransport.onData = ((data: Buffer, addr: unknown) =>
    deliver(data, addr, {
      rxGeneration: generation,
    })) as typeof serverTransport.onData;
  const originalSendAck = server.sendAck.bind(server);
  let failedAcks = 0;
  let succeededAcksAfterFailure = 0;
  server.sendAck = async (opts) => {
    if (server.peerFinishedReceived && failedAcks === 0) {
      failedAcks++;
      generation++;
      throw new Error("injected final ACK send failure");
    }
    const sent = await originalSendAck(opts);
    if (failedAcks > 0 && sent > 0) succeededAcksAfterFailure++;
    return sent;
  };
  const errors: Error[] = [];
  server.onError.subscribe((e) => errors.push(e));
  client.onError.subscribe((e) => errors.push(e));

  try {
    // Act: handshake を行い、両側の handshakeComplete を待つ
    void client.connect();
    const deadline = (ms: number) =>
      new Promise<never>((_r, reject) =>
        setTimeout(() => reject(new Error("handshakeComplete timeout")), ms),
      );
    await Promise.race([
      Promise.all([
        client.waitForHandshakeComplete(),
        server.waitForHandshakeComplete(),
      ]),
      deadline(8_000),
    ]);

    // Assert: 最初の ACK は失敗し、再送 Finished への ACK で両側が完了する
    expect(failedAcks).toBe(1);
    expect(succeededAcksAfterFailure).toBeGreaterThan(0);
    expect(server.readiness.handshakeComplete).toBe(true);
    expect(client.readiness.handshakeComplete).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await pair.close();
  }
}, 15_000);
