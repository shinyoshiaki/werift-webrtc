import {
  ProtectionProfileAeadAes128Gcm,
  Red,
  RtcpPacketConverter,
  RtcpRrPacket,
  RtpHeader,
  RtpPacket,
  SrtpSession,
  debug,
} from "../../src/index";
import { describe, expect, test, vi } from "vitest";

describe("browser RTP entry", () => {
  test("serializes RTP, RTCP, and RED packets and roundtrips SRTP", () => {
    // Arrange
    const header = new RtpHeader({ payloadType: 96, sequenceNumber: 7, timestamp: 9, ssrc: 11 });
    const payload = Buffer.from([1, 2, 3]);
    const masterKey = Buffer.alloc(16, 7);
    const masterSalt = Buffer.alloc(12, 9);
    const sender = new SrtpSession({
      profile: ProtectionProfileAeadAes128Gcm,
      keys: { localMasterKey: masterKey, localMasterSalt: masterSalt, remoteMasterKey: masterKey, remoteMasterSalt: masterSalt },
    });
    const receiver = new SrtpSession({
      profile: ProtectionProfileAeadAes128Gcm,
      keys: { localMasterKey: masterKey, localMasterSalt: masterSalt, remoteMasterKey: masterKey, remoteMasterSalt: masterSalt },
    });

    // Act
    const rtp = new RtpPacket(header, payload);
    const parsedRtp = RtpPacket.deSerialize(rtp.serialize());
    const rtcp = new RtcpRrPacket({ ssrc: 42 });
    const parsedRtcp = RtcpPacketConverter.deSerialize(rtcp.serialize());
    const red = new Red();
    red.blocks.push({ block: payload, blockPT: 96 });
    const parsedRed = Red.deSerialize(red.serialize());
    const encrypted = sender.encrypt(payload, header);
    const decrypted = receiver.decrypt(encrypted);

    // Assert
    expect(parsedRtp.serialize()).toEqual(rtp.serialize());
    expect(parsedRtcp).toHaveLength(1);
    expect((parsedRtcp[0] as RtcpRrPacket).ssrc).toBe(42);
    expect(parsedRed.blocks[0].block).toEqual(payload);
    expect(decrypted.subarray(12)).toEqual(payload);
  });

  test("debug is safe with or without localStorage.debug", () => {
    // Arrange
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => {});

    // Act
    localStorage.removeItem("debug");
    const disabledLogger = debug("werift:browser-smoke");
    disabledLogger("disabled");
    debug.enable("werift:browser-smoke");
    const enabledLogger = debug("werift:browser-smoke");
    enabledLogger("enabled %s", "message");

    // Assert
    expect(disabledLogger).toBeTypeOf("function");
    expect(consoleDebug).toHaveBeenCalledWith(
      "werift:browser-smoke enabled %s",
      "message",
    );
    debug.disable();
  });
});
