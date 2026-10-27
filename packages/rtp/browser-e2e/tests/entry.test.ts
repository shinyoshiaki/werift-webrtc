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

    // Act: RTP / RTCP / RED を serialize → deserialize し、SRTP で暗号化 → 復号する
    const rtp = new RtpPacket(header, payload);
    const parsedRtp = RtpPacket.deSerialize(rtp.serialize());
    const rtcp = new RtcpRrPacket({ ssrc: 42 });
    const parsedRtcp = RtcpPacketConverter.deSerialize(rtcp.serialize());
    const red = new Red();
    red.blocks.push({ block: payload, blockPT: 96 });
    const parsedRed = Red.deSerialize(red.serialize());
    const encrypted = sender.encrypt(payload, header);
    const decrypted = receiver.decrypt(encrypted);

    // Assert: いずれも元の内容に戻る
    expect(parsedRtp.serialize()).toEqual(rtp.serialize());
    expect(parsedRtcp).toHaveLength(1);
    expect((parsedRtcp[0] as RtcpRrPacket).ssrc).toBe(42);
    expect(parsedRed.blocks[0].block).toEqual(payload);
    expect(decrypted.subarray(12)).toEqual(payload);
  });

  test("debug follows localStorage.debug and debug.enable()", () => {
    // Arrange
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const enabledLogger = debug("werift:browser-enabled");
    const disabledLogger = debug("werift:browser-disabled");

    // Act: localStorage.debug に一致する logger と一致しない logger を呼ぶ
    disabledLogger("disabled");
    enabledLogger("enabled %s", "message");

    // Assert: 一致する logger だけが namespace 付きで console.debug へ出力する
    expect(disabledLogger.enabled).toBe(false);
    expect(enabledLogger.enabled).toBe(true);
    expect(consoleDebug).toHaveBeenCalledTimes(1);
    expect(consoleDebug).toHaveBeenCalledWith(
      "werift:browser-enabled enabled %s",
      "message",
    );

    // Act: export された debug.enable() / debug.disable() で切り替える
    debug.enable("werift:browser-disabled");
    const enabledAfterSwitch = disabledLogger.enabled;
    debug.disable();

    // Assert: 設定の切り替えが既存の logger に反映される
    expect(enabledAfterSwitch).toBe(true);
    expect(disabledLogger.enabled).toBe(false);
    expect(enabledLogger.enabled).toBe(false);
  });

  test("debug does not throw when localStorage.debug is absent", () => {
    // Arrange
    localStorage.removeItem("debug");

    // Act: 設定なしで logger を作って呼ぶ
    const logger = debug("werift:browser-unset");
    const call = () => logger("ignored");

    // Assert: 例外にならず、無効のまま
    expect(call).not.toThrow();
    expect(logger.enabled).toBe(false);
  });
});
