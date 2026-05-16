import { expect, test } from "vitest";

import { resolveTimeoutProfile } from "../../tools/wpt-runner/timeoutLogic";

test("quick WebRTC WPT cases use a short timeout profile", () => {
  // 実行: constructor 系の軽量ケースに割り当てるタイムアウトを解決する。
  const profile = resolveTimeoutProfile({
    file: "webrtc/RTCPeerConnection-constructor.html",
    variant: "",
  });

  // 検証: 軽量ケースは短い完了待ち時間で全体の長時間化を防ぐ。
  expect(profile).toEqual({
    completionTimeoutMs: 400,
    cleanupTimeoutMs: 150,
    vmTimeoutMs: 400,
  });
});

test("heavy WebRTC WPT cases use a longer but bounded timeout profile", () => {
  // 実行: getStats 系の重いケースに割り当てるタイムアウトを解決する。
  const profile = resolveTimeoutProfile({
    file: "webrtc/RTCPeerConnection-getStats.https.html",
    variant: "",
  });

  // 検証: 重いケースでも上限付きの長めタイムアウトに収める。
  expect(profile).toEqual({
    completionTimeoutMs: 2_500,
    cleanupTimeoutMs: 400,
    vmTimeoutMs: 2_500,
  });
});
