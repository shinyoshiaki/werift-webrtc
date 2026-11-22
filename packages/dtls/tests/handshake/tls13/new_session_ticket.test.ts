import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../../common/src";
import { SessionType } from "../../../src/cipher/suites/abstract";
import { Dtls13Connection } from "../../../src/engine/v1_3/connection";
import { NewSessionTicket } from "../../../src/handshake/message/tls13/newSessionTicket";
import { AlertDesc } from "../../../src/record/const";
import { DtlsProtocolError } from "../../../src/version";
import { certPem, keyPem } from "../../fixture";

function arrangeTicket(overrides?: Partial<NewSessionTicket>) {
  return new NewSessionTicket(
    overrides?.ticketLifetime ?? 86400,
    overrides?.ticketAgeAdd ?? 0x11223344,
    overrides?.ticketNonce ?? Buffer.from([0x01, 0x02]),
    overrides?.ticket ?? Buffer.from("ticket-bytes"),
    overrides?.extensions ?? Buffer.alloc(0),
  );
}

describe("NewSessionTicket codec (RFC 8446 §4.6.1)", () => {
  test("roundtrips lifetime / ageAdd / nonce / ticket / empty extensions", () => {
    // Arrange: RFC フィールドを埋めた NST
    const nst = arrangeTicket();

    // Act: codec の往復
    const parsed = NewSessionTicket.deSerialize(nst.serialize());

    // Assert: 各フィールドが保たれる
    expect(parsed.ticketLifetime).toBe(86400);
    expect(parsed.ticketAgeAdd).toBe(0x11223344);
    expect(parsed.ticketNonce.equals(Buffer.from([0x01, 0x02]))).toBe(true);
    expect(parsed.ticket.equals(Buffer.from("ticket-bytes"))).toBe(true);
    expect(parsed.extensions.length).toBe(0);
  });

  test("roundtrips unknown extensions without failing", () => {
    // Arrange: 未知 extension（type 0x0039, empty data）
    const ext = Buffer.alloc(4);
    ext.writeUInt16BE(0x0039, 0);
    ext.writeUInt16BE(0, 2);
    const nst = arrangeTicket({ extensions: ext });

    // Act: 未知拡張を含む body を parse
    const parsed = NewSessionTicket.deSerialize(nst.serialize());

    // Assert: 拡張バイトはそのまま残る（skip）
    expect(parsed.extensions.equals(ext)).toBe(true);
  });

  test("rejects truncated / empty ticket / trailing bytes", () => {
    // Arrange: 不正 body
    const good = arrangeTicket().serialize();

    // Act / Assert: decode_error
    expect(() => NewSessionTicket.deSerialize(good.subarray(0, 8))).toThrow(
      DtlsProtocolError,
    );
    const emptyTicket = Buffer.concat([
      Buffer.alloc(4), // lifetime
      Buffer.alloc(4), // age_add
      Buffer.from([0]), // nonce empty
      Buffer.from([0x00, 0x00]), // ticket length 0
      Buffer.from([0x00, 0x00]),
    ]);
    expect(() => NewSessionTicket.deSerialize(emptyTicket)).toThrow(
      /empty ticket/,
    );
    expect(() =>
      NewSessionTicket.deSerialize(Buffer.concat([good, Buffer.from([0xff])])),
    ).toThrow(/trailing|mismatch/);
  });
});

describe("post-handshake NewSessionTicket dispatch", () => {
  test("client connected accepts NST, ACKs, discards, stays connected", async () => {
    // Arrange: connected client
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
    client.hsPhase = "connected";
    client.connected = true;
    const nst = arrangeTicket();
    nst.messageSeq = 10;
    const frag = nst.toFragment();
    frag.message_seq = 10;

    // Act: connected で dispatch
    await client.dispatchHandshake(frag, 3);

    // Assert: association は生存し、ACK 対象になる。ticket は保存しない
    expect(client.connected).toBe(true);
    expect(client.hsPhase).toBe("connected");
    expect(client.ackAfterCurrentRecord).toBe(true);
    expect((client as any).sessionTicket).toBeUndefined();

    client.close();
  });

  test("multiple consecutive NSTs keep connected", async () => {
    // Arrange: connected client
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
    client.hsPhase = "connected";
    client.connected = true;

    // Act: message_seq 連続で複数 NST
    for (const seq of [4, 5, 6]) {
      const nst = arrangeTicket({ ticket: Buffer.from(`t${seq}`) });
      nst.messageSeq = seq;
      const frag = nst.toFragment();
      frag.message_seq = seq;
      client.ackAfterCurrentRecord = false;
      await client.dispatchHandshake(frag, 3);
    }

    // Assert: 連続 dispatch しても connected
    expect(client.connected).toBe(true);
    expect(client.hsPhase).toBe("connected");
    expect(client.ackAfterCurrentRecord).toBe(true);

    client.close();
  });

  test("server connected rejects NST as unexpected_message", async () => {
    // Arrange: connected server
    const transport = await UdpTransport.init("udp4");
    const server = new Dtls13Connection(
      {
        transport,
        cert: certPem,
        key: keyPem,
        addressValidation: "none",
      },
      SessionType.SERVER,
    );
    server.hsPhase = "connected";
    server.connected = true;
    const nst = arrangeTicket();
    nst.messageSeq = 1;
    const frag = nst.toFragment();
    frag.message_seq = 1;

    // Act / Assert: server は NST を受けない
    await expect(server.dispatchHandshake(frag, 3)).rejects.toMatchObject({
      name: "DtlsProtocolError",
      alertDescription: AlertDesc.UnexpectedMessage,
    });

    server.close();
  });

  test("client wait_finished rejects NST as unexpected_message", async () => {
    // Arrange: handshake 中の client
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
    const nst = arrangeTicket();
    nst.messageSeq = 3;
    const frag = nst.toFragment();
    frag.message_seq = 3;

    // Act / Assert: handshake 中は unexpected_message
    await expect(client.dispatchHandshake(frag, 2)).rejects.toMatchObject({
      name: "DtlsProtocolError",
      alertDescription: AlertDesc.UnexpectedMessage,
    });

    client.close();
  });
});
