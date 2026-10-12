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

test("e2e/self13 相互認証で Finished の ACK が送れていない間は server を handshakeComplete にしない", async () => {
  // Arrange: 相互認証で client の最終 flight を Certificate / CertificateVerify /
  // Finished に分け、server の受信 datagram に carrier 世代を付ける
  const pair = await arrangeDtls13EnginePair({ certificateRequest: true });
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

  // Finished を運んだ record 番号を、受理直後の ACK 処理で記録する
  let finishedRecord: { epoch: number; sequenceNumber: number } | undefined;
  const originalFinishAck = server.finishHandshakeRecordAck.bind(server);
  server.finishHandshakeRecordAck = (epoch, sequenceNumber, generationArg) => {
    if (server.peerFinishedReceived && !finishedRecord) {
      finishedRecord = { epoch, sequenceNumber };
    }
    return originalFinishAck(epoch, sequenceNumber, generationArg);
  };
  // Finished を含む ACK だけ、送信の途中 (ACK 対象を queue から取り出した後)
  // で 2 回失敗させる。先行 record だけの ACK は成功させる。
  const includesFinished = () =>
    finishedRecord !== undefined &&
    server.receivedRecordNumbers.some(
      (r) =>
        r.epoch === finishedRecord!.epoch &&
        r.sequenceNumber === finishedRecord!.sequenceNumber,
    );
  const originalSendAck = server.sendAck.bind(server);
  const originalSendWithBudget = server.sendWithBudget.bind(server);
  let failFinishedAcks = 2;
  let finishedAckFailures = 0;
  let finishedAckSent = false;
  let otherAcksSentBeforeFinishedAck = 0;
  server.sendAck = async (opts) => {
    const withFinished = includesFinished();
    if (!withFinished || failFinishedAcks === 0) {
      const sent = await originalSendAck(opts);
      if (sent > 0 && withFinished) finishedAckSent = true;
      if (sent > 0 && !withFinished && !finishedAckSent) {
        otherAcksSentBeforeFinishedAck++;
      }
      return sent;
    }
    server.sendWithBudget = async () => {
      server.sendWithBudget = originalSendWithBudget;
      failFinishedAcks--;
      finishedAckFailures++;
      // 初回は Finished 処理中の世代変更と重なった失敗とする
      if (finishedAckFailures === 1) generation++;
      throw new Error("injected Finished ACK send failure");
    };
    return originalSendAck(opts);
  };
  let completedWithoutFinishedAck = false;
  server.onHandshakeComplete.subscribe(() => {
    if (!finishedAckSent) completedWithoutFinishedAck = true;
  });

  try {
    // Act: handshake を行い、両側の handshakeComplete を待つ
    void client.connect();
    const deadline = new Promise<never>((_r, reject) =>
      setTimeout(() => reject(new Error("handshakeComplete timeout")), 12_000),
    );
    await Promise.race([
      Promise.all([
        client.waitForHandshakeComplete(),
        server.waitForHandshakeComplete(),
      ]),
      deadline,
    ]);

    // Assert: Finished の ACK は 2 回失敗し、その間に先行 record の ACK が
    // 成功しても server は完了せず、Finished の ACK 送信後に両側が完了する
    expect(finishedRecord).toBeDefined();
    expect(finishedAckFailures).toBe(2);
    expect(otherAcksSentBeforeFinishedAck).toBeGreaterThan(0);
    expect(completedWithoutFinishedAck).toBe(false);
    expect(finishedAckSent).toBe(true);
    expect(server.readiness.handshakeComplete).toBe(true);
    expect(client.readiness.handshakeComplete).toBe(true);
  } finally {
    await pair.close();
  }
}, 20_000);
