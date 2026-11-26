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

test("onicecandidateerror waits for the ICE server failures", () => {
  // 実行: TURN の UDP タイムアウトと TCP 接続タイムアウトを待つファイルのタイムアウトを解決する。
  const profile = resolveTimeoutProfile({
    file: "webrtc/RTCPeerConnection-onicecandidateerror.https.html",
    variant: "",
  });

  // 検証: UDP (約 6.4s) と TCP (8s) の失敗を待てる完了待ち時間になる。
  expect(profile.completionTimeoutMs).toBeGreaterThanOrEqual(15_000);
});

test("a long allowlisted WebRTC WPT file gets the long timeout profile", () => {
  // 実行: 多数の subtest を順に実行する RTCRtpTransceiver (?rest) のタイムアウトを解決する。
  const profile = resolveTimeoutProfile({
    file: "webrtc/RTCRtpTransceiver.https.html",
    variant: "?rest",
  });

  // 検証: ファイル全体のタイムアウトで subtest の結果を失わない長さにする。
  expect(profile.completionTimeoutMs).toBe(45_000);
});

test("RTCDataChannel-bufferedAmount gets the long timeout profile", () => {
  // 実行: data channel の組を subtest ごとに作り直すファイルのタイムアウトを解決する。
  const profile = resolveTimeoutProfile({
    file: "webrtc/RTCDataChannel-bufferedAmount.html",
    variant: "",
  });

  // 検証: 32 個の subtest を順に実行し終えられる完了待ち時間になる。
  expect(profile.completionTimeoutMs).toBe(45_000);
});

test("RTCPeerConnection-ondatachannel fits two 500ms negative waits in the heavy profile", () => {
  // 実行: open / datachannel が発火しないことを 500ms ずつ待つ subtest を 2 つ含むファイルのタイムアウトを解決する。
  const profile = resolveTimeoutProfile({
    file: "webrtc/RTCPeerConnection-ondatachannel.html",
    variant: "",
  });

  // 検証: 既定の datachannel 枠 (1.5s) ではなく、2 つの待ちと接続確立を含めて完了できる heavy 枠になる。
  expect(profile.completionTimeoutMs).toBe(2_500);
});

test("a timeout scale multiplies every limit of the profile", () => {
  // 実行: 再実行用に 4 倍のタイムアウトを解決する。
  const profile = resolveTimeoutProfile(
    { file: "webrtc/RTCPeerConnection-constructor.html", variant: "" },
    4,
  );

  // 検証: 軽量ケースの各上限が 4 倍になる。
  expect(profile).toEqual({
    completionTimeoutMs: 1_600,
    cleanupTimeoutMs: 600,
    vmTimeoutMs: 1_600,
  });
});
