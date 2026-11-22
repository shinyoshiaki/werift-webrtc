import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../../common/src";
import { SessionType } from "../../../src/cipher/suites/abstract";
import { Dtls13Connection } from "../../../src/engine/v1_3/connection";
import { DtlsAck } from "../../../src/handshake/message/tls13/ack";
import { AlertDesc } from "../../../src/record/const";
import { createEpochProtection } from "../../../src/record/v1_3/record";
import { DtlsProtocolError } from "../../../src/version";
import { certPem, keyPem } from "../../fixture";

async function arrangeClientEngine() {
  const transport = await UdpTransport.init("udp4");
  const client = new Dtls13Connection(
    {
      transport,
      cert: certPem,
      key: keyPem,
      addressValidation: "none",
    },
    SessionType.CLIENT,
  );
  return { transport, client };
}

describe("authenticated malformed ACK is decode_error", () => {
  test("epoch 2 truncated / invalid listLen throws DtlsProtocolError DecodeError", async () => {
    // Arrange: 認証済み epoch の短い ACK / 非整列 listLen
    const { transport, client } = await arrangeClientEngine();
    const short = Buffer.from([0x00]);
    const oddLen = Buffer.from([0x00, 0x01]);

    // Act / Assert: epoch ≥ 2 は fatal decode_error
    expect(() => client.handleAck(short, 2)).toThrow(DtlsProtocolError);
    try {
      client.handleAck(oddLen, 2);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DtlsProtocolError);
      expect((e as DtlsProtocolError).alertDescription).toBe(
        AlertDesc.DecodeError,
      );
    }

    client.close();
    await transport.close();
  });

  test("epoch 2 trailing bytes are decode_error", async () => {
    // Arrange: 合法 empty ACK に trailing
    const { transport, client } = await arrangeClientEngine();
    const trailing = Buffer.concat([
      new DtlsAck([]).serialize(),
      Buffer.from([0xff]),
    ]);

    // Act / Assert: strict parse
    expect(() => client.handleAck(trailing, 2)).toThrow(DtlsProtocolError);

    client.close();
    await transport.close();
  });

  test("epoch 0 of the same bytes is silent drop", async () => {
    // Arrange: 未認証 epoch 0 の同じ不正 bytes
    const { transport, client } = await arrangeClientEngine();
    const short = Buffer.from([0x00]);
    const oddLen = Buffer.from([0x00, 0x01]);
    const trailing = Buffer.concat([
      new DtlsAck([]).serialize(),
      Buffer.from([0xff]),
    ]);

    // Act / Assert: epoch 0 は throw しない
    expect(() => client.handleAck(short, 0)).not.toThrow();
    expect(() => client.handleAck(oddLen, 0)).not.toThrow();
    expect(() => client.handleAck(trailing, 0)).not.toThrow();

    client.close();
    await transport.close();
  });
});

describe("sendAck MTU shrink does not drop unsent RecordNumbers", () => {
  test("when even one ACK cannot fit, all queued numbers remain including the oldest", async () => {
    // Arrange: 3 件 queued、見積もりは 3 件、実 MTU は 1 件分にも足りない
    const { transport, client } = await arrangeClientEngine();
    const ep = createEpochProtection(2);
    ep.writeKeys = {
      key: Buffer.alloc(16, 1),
      iv: Buffer.alloc(12, 2),
      snKey: Buffer.alloc(16, 3),
    };
    client.installEpoch(2, ep);
    client.writeEpoch = 2;
    client.receivedRecordNumbers = [
      { epoch: 2, sequenceNumber: 0 },
      { epoch: 2, sequenceNumber: 1 },
      { epoch: 2, sequenceNumber: 2 },
    ];
    client.maxAckRecordsForMtu = () => 3;
    client.carrier.getMtu = () => 8;
    const sent: Buffer[] = [];
    client.sendWithBudget = async (record: Buffer) => {
      sent.push(record);
      return true;
    };

    // Act: 縮退 defensive path
    await client.sendAck();

    // Assert: 未送信の先頭 epoch/seq が消えない
    expect(sent).toHaveLength(0);
    expect(client.receivedRecordNumbers).toEqual([
      { epoch: 2, sequenceNumber: 0 },
      { epoch: 2, sequenceNumber: 1 },
      { epoch: 2, sequenceNumber: 2 },
    ]);

    client.close();
    await transport.close();
  });

  test("when a prefix fits, only sent numbers leave the queue (oldest-first)", async () => {
    // Arrange: 見積もり 3 件だが実 MTU は 1 件分だけ
    const { transport, client } = await arrangeClientEngine();
    const ep = createEpochProtection(2);
    ep.writeKeys = {
      key: Buffer.alloc(16, 1),
      iv: Buffer.alloc(12, 2),
      snKey: Buffer.alloc(16, 3),
    };
    client.installEpoch(2, ep);
    client.writeEpoch = 2;
    client.receivedRecordNumbers = [
      { epoch: 2, sequenceNumber: 10 },
      { epoch: 2, sequenceNumber: 11 },
      { epoch: 2, sequenceNumber: 12 },
    ];
    client.maxAckRecordsForMtu = () => 3;
    // Encrypted 1-record ACK ≈ 40 bytes; 3-record is larger
    client.carrier.getMtu = () => 40;
    const sent: Buffer[] = [];
    client.sendWithBudget = async (record: Buffer) => {
      sent.push(record);
      return true;
    };

    // Act: 載る件数だけ送る
    await client.sendAck();

    // Assert: 先頭は送られて消え、残りは queue に残る（slice(1) で捨てない）
    expect(sent).toHaveLength(1);
    expect(client.receivedRecordNumbers.map((r) => r.sequenceNumber)).toEqual([
      11, 12,
    ]);

    client.close();
    await transport.close();
  });
});

describe("finishHandshakeRecordAck drain stops when sendAck cannot progress", () => {
  test("tiny MTU with ackAfterCurrentRecord returns and keeps the queue", async () => {
    // Arrange: epoch 2、キューあり、MTU が 1 件の ACK にも足りない
    const { transport, client } = await arrangeClientEngine();
    const ep = createEpochProtection(2);
    ep.writeKeys = {
      key: Buffer.alloc(16, 1),
      iv: Buffer.alloc(12, 2),
      snKey: Buffer.alloc(16, 3),
    };
    client.installEpoch(2, ep);
    client.writeEpoch = 2;
    client.receivedRecordNumbers = [
      { epoch: 2, sequenceNumber: 0 },
      { epoch: 2, sequenceNumber: 1 },
    ];
    client.maxAckRecordsForMtu = () => 3;
    client.carrier.getMtu = () => 8;
    const sent: Buffer[] = [];
    client.sendWithBudget = async (record: Buffer) => {
      sent.push(record);
      return true;
    };
    client.ackAfterCurrentRecord = true;

    // Act: Finished/NST と同じ ack-after-record 経路
    await client.finishHandshakeRecordAck(2, 2);

    // Assert: ループが終わり、未送信 RecordNumber は残る（今回分含む）
    expect(client.ackAfterCurrentRecord).toBe(false);
    expect(sent).toHaveLength(0);
    expect(client.receivedRecordNumbers).toEqual([
      { epoch: 2, sequenceNumber: 0 },
      { epoch: 2, sequenceNumber: 1 },
      { epoch: 2, sequenceNumber: 2 },
    ]);

    client.close();
    await transport.close();
  }, 2_000);
});
