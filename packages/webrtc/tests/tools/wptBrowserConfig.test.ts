import { expect, test } from "vitest";

import { CompatibilityModes, RTCPeerConnection } from "../../src";
import {
  BROWSER_COMPATIBLE_PEER_CONFIG,
  withBrowserCompatibleConfig,
} from "../../tools/wpt-runner/browserConfig";

const compatibilityOptions = [
  "certificateScope",
  "mLineReuse",
  "transceiverPairing",
  "keyFrameRequestRouting",
] as const;

test("the WPT configuration sets every compatibility option to standard", async () => {
  // Act: WPT の既定設定 (テストが何も指定しない場合) で作成する
  const pc = new RTCPeerConnection(
    withBrowserCompatibleConfig(undefined) as never,
  );

  try {
    // Assert: 互換性オプションはすべて standard、STUN サーバーはブラウザと同じく空
    const config = pc.getConfiguration();
    for (const option of compatibilityOptions) {
      expect(config[option]).toBe("standard");
      expect(BROWSER_COMPATIBLE_PEER_CONFIG[option]).toBe(
        CompatibilityModes[0],
      );
    }
    expect(config.iceServers).toEqual([]);
    expect(config.iceUseDefaultStunServer).toBe(false);
  } finally {
    await pc.close();
  }
});

test("a value the WPT test gives is kept, an undefined one is filled", () => {
  // Act: テストが一部のキーを指定した場合
  const merged = withBrowserCompatibleConfig({
    iceServers: [{ urls: "stun:example.test" }],
    mLineReuse: undefined,
    bundlePolicy: "max-bundle",
  }) as Record<string, unknown>;

  // Assert: 指定値はそのまま、undefined は互換設定で埋める
  expect(merged.iceServers).toEqual([{ urls: "stun:example.test" }]);
  expect(merged.bundlePolicy).toBe("max-bundle");
  expect(merged.mLineReuse).toBe("standard");
  expect(merged.certificateScope).toBe("standard");
});

test("a non-object configuration is passed through for the constructor to reject", () => {
  // Act / Assert: 変換エラーを試すテストの入力は書き換えない
  expect(withBrowserCompatibleConfig("not a dictionary")).toBe(
    "not a dictionary",
  );
  expect(withBrowserCompatibleConfig(null)).toMatchObject({
    certificateScope: "standard",
  });
});
