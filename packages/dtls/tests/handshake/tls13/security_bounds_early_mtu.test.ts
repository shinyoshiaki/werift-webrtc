import { describe, expect, test } from "vitest";
import { defaultKeySchedule } from "../../../src/cipher/tls13/keySchedule";
import {
  MAX_EARLY_APP_DATA_BYTES,
  MAX_EARLY_APP_DATA_BYTES_CEILING,
  MAX_EARLY_APP_DATA_RECORDS,
  MAX_EARLY_APP_DATA_RECORDS_CEILING,
  resolveMaxEarlyAppDataBytes,
  resolveMaxEarlyAppDataRecords,
} from "../../../src/engine/v1_3/types";
import { HandshakeType } from "../../../src/handshake/const";
import { ContentType } from "../../../src/record/const";
import { FragmentedHandshake } from "../../../src/record/message/fragment";
import {
  createEpochProtection,
  encryptRecord,
} from "../../../src/record/v1_3/record";
import { arrangeDtls13Pair } from "../../fixture";

describe("security bounds: early app data", () => {
  test("default caps fit WebRTC DataChannel without being unbounded", () => {
    // Arrange: DataChannel 既定 64KiB + SCTP 制御・reorder 余裕
    // Act / Assert: 既定は DataChannel 向けに十分で、DoS 天井未満
    expect(MAX_EARLY_APP_DATA_RECORDS).toBe(256);
    expect(MAX_EARLY_APP_DATA_RECORDS).toBeLessThanOrEqual(
      MAX_EARLY_APP_DATA_RECORDS_CEILING,
    );
    expect(MAX_EARLY_APP_DATA_BYTES).toBe(256 * 1024);
    expect(MAX_EARLY_APP_DATA_BYTES).toBeLessThanOrEqual(
      MAX_EARLY_APP_DATA_BYTES_CEILING,
    );
  });

  test("Options override record/byte caps and clamp to the DoS ceiling", () => {
    // Arrange: 未指定 / 明示値 / 天井超え
    // Act / Assert: 未指定は既定、正の整数は採用、天井で clamp
    expect(resolveMaxEarlyAppDataRecords()).toBe(MAX_EARLY_APP_DATA_RECORDS);
    expect(resolveMaxEarlyAppDataRecords(8)).toBe(8);
    expect(
      resolveMaxEarlyAppDataRecords(MAX_EARLY_APP_DATA_RECORDS_CEILING + 10),
    ).toBe(MAX_EARLY_APP_DATA_RECORDS_CEILING);
    expect(resolveMaxEarlyAppDataBytes()).toBe(MAX_EARLY_APP_DATA_BYTES);
    expect(resolveMaxEarlyAppDataBytes(64 * 1024)).toBe(64 * 1024);
    expect(() => resolveMaxEarlyAppDataRecords(0)).toThrow(
      /maxEarlyAppDataRecords/,
    );
    expect(() => resolveMaxEarlyAppDataBytes(-1)).toThrow(
      /maxEarlyAppDataBytes/,
    );
  });

  test("DtlsClient / DtlsServer Options plumb the early-app-data caps", async () => {
    // Arrange: 公開 Options で上限を指定する
    const { client, server } = await arrangeDtls13Pair({
      maxEarlyAppDataRecords: 16,
      maxEarlyAppDataBytes: 48 * 1024,
    });
    try {
      // Act / Assert: 1.3 engine が同じ上限を持つ
      expect(client["engine13"]?.["maxEarlyAppDataRecords"]).toBe(16);
      expect(client["engine13"]?.["maxEarlyAppDataBytes"]).toBe(48 * 1024);
      expect(server["engine13"]?.["maxEarlyAppDataRecords"]).toBe(16);
      expect(server["engine13"]?.["maxEarlyAppDataBytes"]).toBe(48 * 1024);
    } finally {
      client.close();
      server.close();
    }
  });
});

describe("security bounds: encrypted handshake MTU", () => {
  test("encrypted HS record with maxFrag fits MTU (includes inner content type)", () => {
    // Arrange: 前提を準備する
    const mtu = 400;
    const maxFrag = mtu - 5 - 12 - 1 - 16;
    expect(maxFrag).toBe(366);

    const secret = Buffer.alloc(32, 7);
    const traffic = defaultKeySchedule.trafficKeys(secret);
    const ep = createEpochProtection(2);
    ep.writeKeys = traffic;

    // Act: MTU 制約を検証する
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

    // Assert: MTU 制約を検証する
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
