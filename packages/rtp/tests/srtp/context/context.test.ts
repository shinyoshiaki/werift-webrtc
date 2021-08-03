import { CipherAesCtr } from "../../../src/srtp/cipher/ctr";
import { ProtectionProfileAes128CmHmacSha1_80 } from "../../../src/srtp/const";
import { Context, SrtpSsrcState } from "../../../src/srtp/context/context";

describe("srtp/context", () => {
  test("TestValidSessionKeys", () => {
    const masterKey = Buffer.from([
      0xe1, 0xf9, 0x7a, 0x0d, 0x3e, 0x01, 0x8b, 0xe0, 0xd6, 0x4f, 0xa3, 0x2c,
      0x06, 0xde, 0x41, 0x39,
    ]);
    const masterSalt = Buffer.from([
      0x0e, 0xc6, 0x75, 0xad, 0x49, 0x8a, 0xfe, 0xeb, 0xb6, 0x96, 0x0b, 0x3a,
      0xab, 0xe6,
    ]);

    const expectedSessionKey = Buffer.from([
      0xc6, 0x1e, 0x7a, 0x93, 0x74, 0x4f, 0x39, 0xee, 0x10, 0x73, 0x4a, 0xfe,
      0x3f, 0xf7, 0xa0, 0x87,
    ]);
    const expectedSessionSalt = Buffer.from([
      0x30, 0xcb, 0xbc, 0x08, 0x86, 0x3d, 0x8c, 0x85, 0xd4, 0x9d, 0xb3, 0x4a,
      0x9a, 0xe1,
    ]);
    const expectedSessionAuthTag = Buffer.from([
      0xce, 0xbe, 0x32, 0x1f, 0x6f, 0xf7, 0x71, 0x6b, 0x6f, 0xd4, 0xab, 0x49,
      0xaf, 0x25, 0x6a, 0x15, 0x6d, 0x38, 0xba, 0xa4,
    ]);

    const c = new Context(
      masterKey,
      masterSalt,
      ProtectionProfileAes128CmHmacSha1_80
    );

    const sessionKey = c.generateSessionKey(0x00);
    expect(sessionKey).toEqual(expectedSessionKey);

    const sessionSalt = c.generateSessionSalt(2);
    expect(sessionSalt).toEqual(expectedSessionSalt);

    const sessionAuthTag = c.generateSessionAuthTag(1);
    expect(sessionAuthTag).toEqual(expectedSessionAuthTag);
  });

  test("TestValidPacketCounter", () => {
    const masterKey = Buffer.from([
      0x0d, 0xcd, 0x21, 0x3e, 0x4c, 0xbc, 0xf2, 0x8f, 0x01, 0x7f, 0x69, 0x94,
      0x40, 0x1e, 0x28, 0x89,
    ]);
    const masterSalt = Buffer.from([
      0x62, 0x77, 0x60, 0x38, 0xc0, 0x6d, 0xc9, 0x41, 0x9f, 0x6d, 0xd9, 0x43,
      0x3e, 0x7c,
    ]);
    const c = new Context(
      masterKey,
      masterSalt,
      ProtectionProfileAes128CmHmacSha1_80
    );
    const expectedCounter = Buffer.from([
      0xcf, 0x90, 0x1e, 0xa5, 0xda, 0xd3, 0x2c, 0x15, 0x00, 0xa2, 0x24, 0xae,
      0xae, 0xaf, 0x00, 0x00,
    ]);

    const counter = (c.cipher as CipherAesCtr).generateCounter(
      32846,
      0,
      4160032510,
      c.srtpSessionSalt
    );
    expect(counter).toEqual(expectedCounter);
  });

  test("TestRolloverCount", () => {
    const masterKey = Buffer.from([
      0x0d, 0xcd, 0x21, 0x3e, 0x4c, 0xbc, 0xf2, 0x8f, 0x01, 0x7f, 0x69, 0x94,
      0x40, 0x1e, 0x28, 0x89,
    ]);
    const masterSalt = Buffer.from([
      0x62, 0x77, 0x60, 0x38, 0xc0, 0x6d, 0xc9, 0x41, 0x9f, 0x6d, 0xd9, 0x43,
      0x3e, 0x7c,
    ]);

    const c = new Context(masterKey, masterSalt, 1);
    const s: SrtpSsrcState = {
      ssrc: 0,
      rolloverCounter: 0,
      lastSequenceNumber: 0,
    };

    c.updateRolloverCount(65530, s);

    c.updateRolloverCount(0, s);
    expect(s.rolloverCounter).toBe(1);

    c.updateRolloverCount(65530, s);
    expect(s.rolloverCounter).toBe(0);

    c.updateRolloverCount(5, s);
    expect(s.rolloverCounter).toBe(1);

    c.updateRolloverCount(6, s);
    c.updateRolloverCount(7, s);
    c.updateRolloverCount(8, s);
    expect(s.rolloverCounter).toBe(1);
  });

  test("TestRolloverCount Packet out of order", () => {
    const masterKey = Buffer.from([
      0x0d, 0xcd, 0x21, 0x3e, 0x4c, 0xbc, 0xf2, 0x8f, 0x01, 0x7f, 0x69, 0x94,
      0x40, 0x1e, 0x28, 0x89,
    ]);
    const masterSalt = Buffer.from([
      0x62, 0x77, 0x60, 0x38, 0xc0, 0x6d, 0xc9, 0x41, 0x9f, 0x6d, 0xd9, 0x43,
      0x3e, 0x7c,
    ]);

    const c = new Context(masterKey, masterSalt, 1);
    const s: SrtpSsrcState = {
      ssrc: 0,
      rolloverCounter: 0,
      lastSequenceNumber: 0,
    };

    c.updateRolloverCount(0, s);
    c.updateRolloverCount(65535, s);
    expect(s.rolloverCounter).toBe(0);
    c.updateRolloverCount(1, s);
    expect(s.rolloverCounter).toBe(1);

    c.updateRolloverCount(65534, s);
    expect(s.rolloverCounter).toBe(0);

    c.updateRolloverCount(99, s);
    expect(s.rolloverCounter).toBe(1);

    c.updateRolloverCount(101, s);
    c.updateRolloverCount(65535, s);
    c.updateRolloverCount(0, s);
    expect(s.rolloverCounter).toBe(2);

    c.updateRolloverCount(65534, s);
    expect(s.rolloverCounter).toBe(1);
    c.updateRolloverCount(1, s);
    expect(s.rolloverCounter).toBe(2);
  });
});
