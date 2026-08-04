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
    // bit layout: event=0x01, E=0 R=0 volume=10 → 0x0a, duration=0x00a0
    const wire = Buffer.from([0x01, 0x0a, 0x00, 0xa0]);
    // Act
    const parsed = TelephoneEventRtpPayload.deSerialize(wire);
    // Assert: フィールドが RFC 4733 どおり
    expect(parsed.event).toBe(1);
    expect(parsed.end).toBe(false);
    expect(parsed.reserved).toBe(false);
    expect(parsed.volume).toBe(10);
    expect(parsed.duration).toBe(160);
    expect(parsed.serialize()).toEqual(wire);
  });

  it("parses end-of-event bit", () => {
    // Arrange: E=1, volume=5, duration=800
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
    // Act / Assert: 最小長検証
    expect(() =>
      TelephoneEventRtpPayload.deSerialize(Buffer.from([0, 1, 2])),
    ).toThrow(/too short/);
  });

  it("packetizeEvent sets marker on start and E bit on end", () => {
    // Arrange
    const packetizer = new TelephoneEventPacketizer({
      sequenceNumber: 50,
      payloadType: TELEPHONE_EVENT_DEFAULT_PAYLOAD_TYPE,
    });
    // Act: 開始パケット
    const start = packetizer.packetizeEvent(
      { event: 1, volume: 10, duration: 160, start: true },
      1000,
    );
    // Act: 終了パケット（同一タイムスタンプ、累積 duration）
    const end = packetizer.packetizeEvent(
      { event: 1, volume: 10, duration: 800, end: true },
      1000,
    );
    // Assert: marker は開始のみ (RFC 4733 §2.5.1.1)
    expect(start.header.marker).toBe(true);
    expect(end.header.marker).toBe(false);
    expect(start.header.sequenceNumber).toBe(50);
    expect(end.header.sequenceNumber).toBe(51);
    expect(start.header.payloadType).toBe(101);

    const startBody = TelephoneEventRtpPayload.deSerialize(start.payload);
    const endBody = TelephoneEventRtpPayload.deSerialize(end.payload);
    expect(startBody.end).toBe(false);
    expect(endBody.end).toBe(true);
    expect(endBody.duration).toBe(800);
  });

  it("decodes existing rtp_dtmf.bin fixture when present", () => {
    // Arrange: 既存フィクスチャ (PT 101 / 4 バイトペイロード)
    const path = join(__dirname, "../data/rtp_dtmf.bin");
    const raw = readFileSync(path);
    // Act: RTP パケットとして解釈しペイロードを RFC 4733 で読む
    const rtp = RtpPacket.deSerialize(raw);
    // Assert: ペイロード長と PT
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
    // Assert: 開始/終了の 2 ペイロード
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
