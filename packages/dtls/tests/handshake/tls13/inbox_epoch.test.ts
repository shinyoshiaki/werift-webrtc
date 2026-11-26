import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../../common/src";
import { SessionType } from "../../../src/cipher/suites/abstract";
import { Dtls13Connection } from "../../../src/engine/v1_3/connection";
import { HandshakeType } from "../../../src/handshake/const";
import { AlertDesc } from "../../../src/record/const";
import { FragmentedHandshake } from "../../../src/record/message/fragment";
import { certPem, keyPem } from "../../fixture";

function dummyHs(msgType: number, seq: number, body = Buffer.from([0xaa])) {
  return new FragmentedHandshake(
    msgType,
    body.length,
    seq,
    0,
    body.length,
    body,
  );
}

describe("handshake inbox preserves per-message epoch on reorder drain", () => {
  test("SH delay then EE drain dispatches EE with epoch 2", async () => {
    // Arrange: inbox に epoch 2 の EE を先置きし、nextReceiveSeq=0
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
    const eng = client as any;
    eng.hsPhase = "wait_server_hello";
    eng.nextReceiveSeq = 0;
    const dispatched: { type: number; epoch: number }[] = [];
    eng.dispatchHandshake = async (hs: FragmentedHandshake, epoch: number) => {
      dispatched.push({ type: hs.msg_type, epoch });
    };

    // Act: EE (seq=1, epoch 2) を先に enqueue し、SH (seq=0, epoch 0) で drain
    await eng.enqueueHandshake(
      dummyHs(HandshakeType.encrypted_extensions_8, 1),
      2,
    );
    expect(eng.handshakeInbox.get(1).epoch).toBe(2);
    await eng.enqueueHandshake(dummyHs(HandshakeType.server_hello_2, 0), 0);

    // Assert: drain は queued epoch を渡す（EE が epoch 0 にならない）
    expect(dispatched).toEqual([
      { type: HandshakeType.server_hello_2, epoch: 0 },
      { type: HandshakeType.encrypted_extensions_8, epoch: 2 },
    ]);

    client.close();
  });

  test("Finished queued before SH drains with epoch 2", async () => {
    // Arrange: Finished を epoch 2 で先置き
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
    const eng = client as any;
    eng.nextReceiveSeq = 0;
    const dispatched: { type: number; epoch: number }[] = [];
    eng.dispatchHandshake = async (hs: FragmentedHandshake, epoch: number) => {
      dispatched.push({ type: hs.msg_type, epoch });
    };

    // Act: Finished (seq=1, epoch 2) を SH (seq=0, epoch 0) より先に queue
    await eng.enqueueHandshake(dummyHs(HandshakeType.finished_20, 1), 2);
    await eng.enqueueHandshake(dummyHs(HandshakeType.server_hello_2, 0), 0);

    // Assert: Finished 検証に epoch 2 が渡る
    expect(dispatched).toEqual([
      { type: HandshakeType.server_hello_2, epoch: 0 },
      { type: HandshakeType.finished_20, epoch: 2 },
    ]);

    client.close();
  });

  test("in-order enqueue still dispatches with the record epoch", async () => {
    // Arrange: in-order 経路
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
    const eng = client as any;
    eng.nextReceiveSeq = 0;
    const dispatched: { type: number; epoch: number }[] = [];
    eng.dispatchHandshake = async (hs: FragmentedHandshake, epoch: number) => {
      dispatched.push({ type: hs.msg_type, epoch });
    };

    // Act: SH → EE を順に enqueue
    await eng.enqueueHandshake(dummyHs(HandshakeType.server_hello_2, 0), 0);
    await eng.enqueueHandshake(
      dummyHs(HandshakeType.encrypted_extensions_8, 1),
      2,
    );

    // Assert: in-order も各 record の epoch
    expect(dispatched).toEqual([
      { type: HandshakeType.server_hello_2, epoch: 0 },
      { type: HandshakeType.encrypted_extensions_8, epoch: 2 },
    ]);

    client.close();
  });

  test("Finished on epoch other than 2 is unexpected_message", async () => {
    // Arrange: wait_finished の client に epoch 0 の Finished
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
    client.hsPhase = "wait_finished";
    const fin = dummyHs(HandshakeType.finished_20, 4, Buffer.alloc(32));

    // Act / Assert: epoch !== 2 は拒否（inbox 修正と同時の検証）
    await expect(client.dispatchHandshake(fin, 0)).rejects.toMatchObject({
      name: "DtlsProtocolError",
      alertDescription: AlertDesc.UnexpectedMessage,
    });

    client.close();
  });
});
