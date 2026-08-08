import { describe, expect, test } from "vitest";
import {
  MAX_EARLY_APP_DATA_BYTES,
  MAX_EARLY_APP_DATA_RECORDS,
} from "../../../src/engine/v1_3/types";
import { ContentType } from "../../../src/record/const";
import {
  createEpochProtection,
  encryptRecord,
} from "../../../src/record/v1_3/record";
import { defaultKeySchedule } from "../../../src/cipher/tls13/keySchedule";
import { FragmentedHandshake } from "../../../src/record/message/fragment";
import { HandshakeType } from "../../../src/handshake/const";

describe("security bounds: early app data", () => {
  test("early app data caps are positive and small", () => {
    // Arrange / Act / Assert: pre-Finished reorder window is bounded
    expect(MAX_EARLY_APP_DATA_RECORDS).toBeGreaterThan(0);
    expect(MAX_EARLY_APP_DATA_RECORDS).toBeLessThanOrEqual(32);
    expect(MAX_EARLY_APP_DATA_BYTES).toBeGreaterThan(0);
    expect(MAX_EARLY_APP_DATA_BYTES).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("security bounds: encrypted handshake MTU", () => {
  test("encrypted HS record with maxFrag fits MTU (includes inner content type)", () => {
    // Arrange: unified header(5) + HS header(12) + fragment + content type(1) + tag(16)
    const mtu = 400;
    const maxFrag = mtu - 5 - 12 - 1 - 16;
    expect(maxFrag).toBe(366);

    const secret = Buffer.alloc(32, 7);
    const traffic = defaultKeySchedule.trafficKeys(secret);
    const ep = createEpochProtection(2);
    ep.writeKeys = traffic;

    // Act: full fragment at the size flight-tx would use after the fix
    const body = Buffer.alloc(maxFrag, 0xab);
    const hs = new FragmentedHandshake(
      HandshakeType.certificate_11,
      body.length,
      0,
      0,
      body.length,
      body,
    );
    const hsBytes = hs.serialize();
    expect(hsBytes.length).toBe(12 + maxFrag);
    const record = encryptRecord(hsBytes, ContentType.handshake, ep);

    // Assert: wire length never exceeds MTU
    expect(record.length).toBeLessThanOrEqual(mtu);
    // Old formula maxFrag = mtu-5-12-16 would produce mtu+1 after inner CT
    const oldMaxFrag = mtu - 5 - 12 - 16;
    const oldBody = Buffer.alloc(oldMaxFrag, 0xcd);
    const oldHs = new FragmentedHandshake(
      HandshakeType.certificate_11,
      oldBody.length,
      1,
      0,
      oldBody.length,
      oldBody,
    );
    const oldRecord = encryptRecord(
      oldHs.serialize(),
      ContentType.handshake,
      ep,
    );
    expect(oldRecord.length).toBe(mtu + 1);
  });
});
