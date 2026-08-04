import { readFileSync } from "fs";
import { join } from "path";

import {
  RtpPacket,
  TELEPHONE_EVENT_DEFAULT_PAYLOAD_TYPE,
  TelephoneEventPacketizer,
  TelephoneEventRtpPayload,
} from "../../src";
import { loadPayloadVector } from "../utils";

// RFC 4733 §2.3 Figure 1 — event | E R volume | duration
// Marker on first packet of event (§2.5.1.1), not last

describe("packages/rtp/tests/codec/telephoneEvent.test.ts", () => {
  it("deSerialize / serialize round-trip (synthetic vector)", () => {
    // Arrange: DTMF digit '1' (event=1), volume=10, duration=160, not end
    const wire = Buffer.from([0x01, 0x0a, 0x00, 0xa0]);
    // Act
    const parsed = TelephoneEventRtpPayload.deSerialize(wire);
    // Assert
    expect(parsed.event).toBe(1);
    expect(parsed.end).toBe(false);
    expect(parsed.reserved).toBe(false);
    expect(parsed.volume).toBe(10);
    expect(parsed.duration).toBe(160);
    expect(parsed.serialize()).toEqual(wire);
  });

  it("parses end-of-event bit", () => {
    // Arrange
    const wire = Buffer.from([0x05, 0x85, 0x03, 0x20]);
    // Act
    const parsed = TelephoneEventRtpPayload.deSerialize(wire);
    // Assert
    expect(parsed.event).toBe(5);
    expect(parsed.end).toBe(true);
    expect(parsed.volume).toBe(5);
    expect(parsed.duration).toBe(800);
  });

  it("rejects payloads shorter than 4 bytes", () => {
    // Act / Assert
    expect(() =>
      TelephoneEventRtpPayload.deSerialize(Buffer.from([0, 1, 2])),
    ).toThrow(/too short/);
  });

  it("packetizeStart / Continue / End set marker and E bit correctly", () => {
    // Arrange
    const p = new TelephoneEventPacketizer({
      sequenceNumber: 50,
      payloadType: TELEPHONE_EVENT_DEFAULT_PAYLOAD_TYPE,
    });
    const ts = 1000;
    // Act: 開始 → 継続 → 終了（同一タイムスタンプ、累積 duration）
    const start = p.packetizeStart(1, 10, 160, ts);
    const cont = p.packetizeContinue(1, 10, 480, ts);
    const end = p.packetizeEnd(1, 10, 800, ts);
    // Assert: marker は開始のみ (RFC 4733 §2.5.1.1)
    expect(start.header.marker).toBe(true);
    expect(cont.header.marker).toBe(false);
    expect(end.header.marker).toBe(false);
    expect(start.header.sequenceNumber).toBe(50);
    expect(end.header.sequenceNumber).toBe(52);
    expect(start.header.payloadType).toBe(101);

    const startBody = TelephoneEventRtpPayload.deSerialize(start.payload);
    const contBody = TelephoneEventRtpPayload.deSerialize(cont.payload);
    const endBody = TelephoneEventRtpPayload.deSerialize(end.payload);
    expect(startBody.end).toBe(false);
    expect(contBody.end).toBe(false);
    expect(endBody.end).toBe(true);
    expect(endBody.duration).toBe(800);
  });

  it("packetize(fields) supports start/end without packetizeEvent alias", () => {
    // Arrange
    const p = new TelephoneEventPacketizer({ sequenceNumber: 0 });
    // Act: 構造化引数で packetize（Buffer ではない）
    const [start] = p.packetize(
      { event: 5, volume: 8, duration: 160, start: true },
      0,
    );
    const [end] = p.packetize(
      { event: 5, volume: 8, duration: 640, end: true },
      0,
    );
    // Assert
    expect(start.header.marker).toBe(true);
    expect(end.header.marker).toBe(false);
    expect(TelephoneEventRtpPayload.deSerialize(end.payload).end).toBe(true);
  });

  it("packetize(Buffer) does not set start marker (use Start/Event APIs)", () => {
    // Arrange
    const p = new TelephoneEventPacketizer({ sequenceNumber: 0 });
    const raw = new TelephoneEventRtpPayload({
      event: 1,
      volume: 0,
      duration: 160,
    }).serialize();
    // Act
    const [pkt] = p.packetize(raw, 0);
    // Assert: 生バッファ経路は marker=false（開始には packetizeStart を使う）
    expect(pkt.header.marker).toBe(false);
  });

  it("decodes existing rtp_dtmf.bin fixture when present", () => {
    // Arrange
    const path = join(__dirname, "../data/rtp_dtmf.bin");
    const raw = readFileSync(path);
    // Act
    const rtp = RtpPacket.deSerialize(raw);
    // Assert
    expect(rtp.header.payloadType).toBe(101);
    expect(rtp.payload.length).toBeGreaterThanOrEqual(4);
    const evt = TelephoneEventRtpPayload.deSerialize(
      rtp.payload.subarray(0, 4),
    );
    expect(evt.event).toBeGreaterThanOrEqual(0);
    expect(evt.event).toBeLessThanOrEqual(255);
    expect(evt.volume).toBeLessThanOrEqual(63);
  });

  it("loads committed vector_telephone_event.bin (start + end)", () => {
    // Arrange
    const payloads = loadPayloadVector("vector_telephone_event.bin");
    // Assert
    expect(payloads.length).toBe(2);
    const start = TelephoneEventRtpPayload.deSerialize(payloads[0]);
    const end = TelephoneEventRtpPayload.deSerialize(payloads[1]);
    expect(start.event).toBe(5);
    expect(start.end).toBe(false);
    expect(start.duration).toBe(160);
    expect(end.event).toBe(5);
    expect(end.end).toBe(true);
    expect(end.duration).toBe(800);
  });
});
