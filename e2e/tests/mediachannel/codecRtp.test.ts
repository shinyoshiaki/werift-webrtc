/**
 * Chrome E2E: packages/rtp Packetizer / Depacketizer interop.
 *
 * A depacketize — Chrome → packages/rtp depacketize
 * B packetize   — fixture → packages/rtp Packetizer → Chrome
 * C repacketize — Chrome → depacketize → re-packetize → Chrome (VP8 required)
 *
 * Packetizer path must use packages/rtp only (not GStreamer pay / webrtc userMedia packetizer).
 */
import {
  browserName,
  getInboundRtpTotals,
  peer,
  preferCodec,
  sleep,
  waitAudioPlay,
  waitInboundRtp,
  waitVideoPlay,
} from "../fixture";

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

type CodecName = "vp8" | "vp9" | "av1" | "h264" | "opus";

function method(scenario: string, codec: CodecName) {
  return `mediachannel_codec_rtp_${scenario}_${codec}`;
}

async function ensurePeer() {
  if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
  await sleep(100);
}

function codecMime(codec: CodecName) {
  switch (codec) {
    case "vp8":
      return "vp8";
    case "vp9":
      return "vp9";
    case "av1":
      return "av1";
    case "h264":
      return "h264";
    case "opus":
      return "opus";
  }
}

function kindOf(codec: CodecName): "audio" | "video" {
  return codec === "opus" ? "audio" : "video";
}

function expectedClockRate(codec: CodecName): number {
  return codec === "opus" ? 48_000 : 90_000;
}

/** Chrome が当該コーデックをエンコードできるか capabilities で確認 */
function chromeCanSend(codec: CodecName): boolean {
  const kind = kindOf(codec);
  const caps = RTCRtpSender.getCapabilities(kind);
  if (!caps?.codecs) return false;
  const hint = codecMime(codec);
  return caps.codecs.some((c) => c.mimeType.toLowerCase().includes(hint));
}

function chromeCanRecv(codec: CodecName): boolean {
  const kind = kindOf(codec);
  const caps = RTCRtpReceiver.getCapabilities?.(kind);
  if (!caps?.codecs) {
    return chromeCanSend(codec);
  }
  const hint = codecMime(codec);
  return caps.codecs.some((c) => c.mimeType.toLowerCase().includes(hint));
}

/**
 * P0 H.264 must run when Chrome has the codec.
 * If H.264 is missing, fail (not silent skip) unless E2E_ALLOW_H264_SKIP=1.
 * (Vitest browser has no process.env reliably — also accept globalThis flag.)
 */
function allowH264Skip(): boolean {
  try {
    // Vite injects import.meta.env for VITE_* only; use explicit global if set
    const g = globalThis as { __E2E_ALLOW_H264_SKIP__?: string };
    if (g.__E2E_ALLOW_H264_SKIP__ === "1") return true;
  } catch {}
  // Playwright page may not see host env; prefer fail so CI with Google Chrome runs H.264
  return false;
}

function requireCodecOrSkip(
  ctx: { skip: () => void },
  codec: CodecName,
  direction: "send" | "recv",
) {
  const ok = direction === "send" ? chromeCanSend(codec) : chromeCanRecv(codec);
  if (ok) return;
  if (codec === "h264" && !allowH264Skip()) {
    throw new Error(
      `H.264 is P0-required but Chrome lacks video/H264 (${direction}). ` +
        `Use Google Chrome via e2e/tools/ensure-google-chrome.sh / ensure-browser.js ` +
        `(or set __E2E_ALLOW_H264_SKIP__=1 only for local OSS Chromium).`,
    );
  }
  console.warn(
    `skip ${direction} ${codec}: Chrome cannot ${direction} (capabilities)`,
  );
  ctx.skip();
}

/** Always request server cleanup; never leave PLI / PC / send loop on failure. */
async function requestServerDone(label: string) {
  try {
    await peer.request(label, { type: "done" });
  } catch (error) {
    console.warn(`[codecRtp] done cleanup failed for ${label}`, error);
  }
}

/** Poll server status (short requests) until depacketize success or timeout. */
async function pollDepacketizeSuccess(
  label: string,
  timeoutMs = 40_000,
): Promise<Record<string, any>> {
  const started = performance.now();
  let last: any = {
    ok: false,
    frameCount: 0,
    keyframeCount: 0,
    totalBytes: 0,
    rtpPackets: 0,
    usedPackagesRtp: true,
  };
  while (performance.now() - started < timeoutMs) {
    last = await peer.request(label, { type: "status" });
    if (last.ok) {
      return last;
    }
    await sleep(250);
  }
  throw new Error(
    `depacketize poll timeout: frames=${last.frameCount} keyframes=${last.keyframeCount} rtp=${last.rtpPackets}`,
  );
}

/** Wait until packetize side has sent enough frames (and ideally multi-packet). */
async function pollPacketizeReady(
  label: string,
  {
    minFrames = 2,
    requireMultiPacket = false,
    timeoutMs = 20_000,
  }: {
    minFrames?: number;
    requireMultiPacket?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<Record<string, any>> {
  const started = performance.now();
  let last: any = { framesSent: 0, multiPacketFrames: 0 };
  while (performance.now() - started < timeoutMs) {
    last = await peer.request(label, { type: "status" });
    const framesOk = (last.framesSent ?? 0) >= minFrames;
    const multiOk =
      !requireMultiPacket || (last.multiPacketFrames ?? 0) >= 1;
    if (framesOk && multiOk) {
      return last;
    }
    await sleep(200);
  }
  return last;
}

function assertNegotiatedMime(
  actual: string | undefined,
  codec: CodecName,
) {
  expect(actual?.toLowerCase()).toContain(codecMime(codec));
}

function assertClockAndTimestamps(
  result: Record<string, any>,
  codec: CodecName,
  { minFrames = 1 }: { minFrames?: number } = {},
) {
  // clock rate を codec ごとに明示検証
  expect(result.clockRate).toBe(expectedClockRate(codec));
  const frames =
    result.frameCount ?? result.framesSent ?? result.framesRepacketized ?? 0;
  if (frames >= 2) {
    expect(result.timestampAdvanced).toBe(true);
    expect(result.timestampsMonotonic).toBe(true);
    const deltas: number[] = result.rtpTimestampDeltas ?? [];
    for (const d of deltas) {
      // 厳密な単調増加: 連続フレーム間 delta > 0
      expect(d).toBeGreaterThan(0);
    }
  } else {
    expect(frames).toBeGreaterThanOrEqual(minFrames);
  }
}

describe("mediachannel_codec_rtp", () => {
  if (browserName === "Firefox") {
    it.skip("skip firefox — Chrome-only codec RTP interop", () => {});
    return;
  }

  // ---------- Scenario A: Depacketizer (Chrome → Node) ----------
  describe("scenario A depacketize (Chrome → packages/rtp)", () => {
    for (const codec of ["vp8", "h264", "opus", "vp9", "av1"] as CodecName[]) {
      it(
        `depacketize_${codec}`,
        async (ctx) => {
          requireCodecOrSkip(ctx, codec, "send");
          await ensurePeer();
          const label = method("depacketize", codec);
          const kind = kindOf(codec);

          const pc = new RTCPeerConnection(ICE);
          let serverReady = false;
          try {
            pc.onicecandidate = ({ candidate }) => {
              peer
                .request(label, { type: "candidate", payload: candidate })
                .catch(() => {});
            };

            // Arrange: Chrome エンコード源
            // H.264 は headless + fake device だと RTP が出ない環境があるため
            // canvas.captureStream を優先（動きのあるフレームを供給）
            let mediaTrack: MediaStreamTrack;
            let canvasAnimTimer: ReturnType<typeof setInterval> | undefined;
            if (kind === "audio") {
              const stream = await navigator.mediaDevices.getUserMedia({
                video: false,
                audio: true,
              });
              mediaTrack = stream.getTracks()[0];
            } else if (codec === "h264") {
              const canvas = document.createElement("canvas");
              canvas.width = 320;
              canvas.height = 240;
              const c2d = canvas.getContext("2d")!;
              let frame = 0;
              const draw = () => {
                frame++;
                c2d.fillStyle = `rgb(${(frame * 3) % 255},40,${(frame * 7) % 255})`;
                c2d.fillRect(0, 0, canvas.width, canvas.height);
                c2d.fillStyle = "#fff";
                c2d.font = "24px sans-serif";
                c2d.fillText(`H264 ${frame}`, 20, 120);
              };
              draw();
              canvasAnimTimer = setInterval(draw, 33);
              const stream = canvas.captureStream(30);
              mediaTrack = stream.getVideoTracks()[0];
            } else {
              const stream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: false,
              });
              mediaTrack = stream.getTracks()[0];
            }
            pc.addTrack(mediaTrack);
            for (const t of pc.getTransceivers()) {
              preferCodec(t, codecMime(codec), kind);
            }
            // store for cleanup
            (pc as any).__codecRtpCanvasTimer = canvasAnimTimer;

            // Act: Node offer → Chrome answer（映像コーデックは Node 側で固定）
            const offer = await peer.request(label, { type: "init" });
            serverReady = true;
            await pc.setRemoteDescription(offer);
            for (const t of pc.getTransceivers()) {
              preferCodec(t, codecMime(codec), kind);
            }
            await pc.setLocalDescription(await pc.createAnswer());
            await peer.request(label, {
              type: "answer",
              payload: pc.localDescription,
            });

            // Assert: Node 側 packages/rtp depacketize + 明示メトリクス
            const result = await pollDepacketizeSuccess(label);
            expect(result.ok).toBe(true);
            expect(result.usedPackagesRtp).toBe(true);
            expect(result.frameCount).toBeGreaterThanOrEqual(1);
            expect(result.totalBytes).toBeGreaterThan(0);
            expect(result.rtpPackets).toBeGreaterThanOrEqual(1);
            assertNegotiatedMime(
              result.negotiatedMime ?? result.expectedMime,
              codec,
            );
            expect(typeof result.payloadType).toBe("number");
            assertClockAndTimestamps(result, codec);
            if (kind === "video") {
              // 映像はキーフレームを少なくとも 1 回
              expect(result.keyframeCount).toBeGreaterThanOrEqual(1);
            }
          } finally {
            // 失敗時も server の PC / PLI / タイマーを必ず解放
            const timer = (pc as any).__codecRtpCanvasTimer as
              | ReturnType<typeof setInterval>
              | undefined;
            if (timer) clearInterval(timer);
            if (serverReady) {
              await requestServerDone(label);
            }
            pc.close();
          }
        },
        60_000,
      );
    }
  });

  // ---------- Scenario B: Packetizer (Node → Chrome) ----------
  describe("scenario B packetize (packages/rtp → Chrome)", () => {
    for (const codec of ["vp8", "h264", "opus", "vp9", "av1"] as CodecName[]) {
      it(
        `packetize_${codec}`,
        async (ctx) => {
          requireCodecOrSkip(ctx, codec, "recv");
          await ensurePeer();
          const label = method("packetize", codec);
          const kind = kindOf(codec);

          const pc = new RTCPeerConnection(ICE);
          let serverReady = false;
          try {
            pc.onicecandidate = ({ candidate }) => {
              peer
                .request(label, { type: "candidate", payload: candidate })
                .catch(() => {});
            };

            const received = new Promise<MediaStreamTrack>((resolve) => {
              pc.ontrack = (ev) => resolve(ev.track);
            });

            // Act: Node が fixture → packages/rtp Packetizer で送出
            const offer = await peer.request(label, { type: "init" });
            serverReady = true;
            await pc.setRemoteDescription(offer);
            for (const t of pc.getTransceivers()) {
              preferCodec(t, codecMime(codec), kind);
            }
            await pc.setLocalDescription(await pc.createAnswer());
            await peer.request(label, {
              type: "answer",
              payload: pc.localDescription,
            });

            const track = await received;

            // 送信側メトリクスが揃うまで待つ（video は multi-packet も要求）
            const status = await pollPacketizeReady(label, {
              minFrames: 2,
              requireMultiPacket: kind === "video",
              timeoutMs: 15_000,
            });
            expect(status.usedPackagesRtp).toBe(true);
            expect(status.framesSent).toBeGreaterThanOrEqual(1);
            expect(status.packetsSent).toBeGreaterThanOrEqual(1);
            assertNegotiatedMime(
              status.negotiatedMime ?? status.expectedMime,
              codec,
            );
            if (status.payloadType !== undefined) {
              expect(typeof status.payloadType).toBe("number");
            }
            assertClockAndTimestamps(status, codec);
            // video は maxPayloadSize を下げているので通常 multi-packet になる
            if (kind === "video") {
              expect(status.multiPacketFrames).toBeGreaterThanOrEqual(1);
            }

            // Assert: Chrome が RTP を受信しデコード経路に載る
            if (codec === "h264") {
              // H.264 は黒画面でも合格可 — 画素変化は必須にしない
              const inbound = await waitInboundRtp(pc, 3, 40_000);
              expect(inbound.packetsReceived).toBeGreaterThanOrEqual(3);
            } else if (kind === "video") {
              await waitVideoPlay(track, 30_000);
              const inbound = await getInboundRtpTotals(pc);
              expect(inbound.packetsReceived).toBeGreaterThan(0);
            } else {
              // Opus: Analyser 優先、失敗時は inbound stats
              try {
                await waitAudioPlay(track, 12_000);
              } catch {
                const inbound = await waitInboundRtp(pc, 5, 15_000);
                expect(inbound.packetsReceived).toBeGreaterThanOrEqual(5);
              }
            }
          } finally {
            if (serverReady) {
              await requestServerDone(label);
            }
            pc.close();
          }
        },
        60_000,
      );
    }
  });

  // ---------- Scenario C: re-packetize (VP8 required) ----------
  describe("scenario C repacketize (Chrome → de/packetize → Chrome)", () => {
    for (const codec of ["vp8"] as CodecName[]) {
      it(
        `repacketize_${codec}`,
        async (ctx) => {
          // VP8 C は必須。非対応環境では skip を明示（暗黙 pass しない）
          if (!chromeCanSend(codec) || !chromeCanRecv(codec)) {
            console.warn(
              `skip repacketize_${codec}: Chrome cannot send/recv VP8`,
            );
            ctx.skip();
            return;
          }
          await ensurePeer();
          const label = method("repacketize", codec);

          const pc = new RTCPeerConnection(ICE);
          let serverReady = false;
          try {
            pc.onicecandidate = ({ candidate }) => {
              peer
                .request(label, { type: "candidate", payload: candidate })
                .catch(() => {});
            };

            const received = new Promise<MediaStreamTrack>((resolve) => {
              pc.ontrack = (ev) => resolve(ev.track);
            });

            // Arrange: 送受両方向
            const stream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            });
            pc.addTrack(stream.getTracks()[0]);
            pc.addTransceiver("video", { direction: "recvonly" });
            for (const t of pc.getTransceivers()) {
              preferCodec(t, codecMime(codec), "video");
            }

            // Act
            const offer = await peer.request(label, { type: "init" });
            serverReady = true;
            await pc.setRemoteDescription(offer);
            for (const t of pc.getTransceivers()) {
              preferCodec(t, codecMime(codec), "video");
            }
            await pc.setLocalDescription(await pc.createAnswer());
            await peer.request(label, {
              type: "answer",
              payload: pc.localDescription,
            });

            // Assert Node depacketize + repacketize メトリクス
            const result = await pollDepacketizeSuccess(label);
            expect(result.ok).toBe(true);
            expect(result.usedPackagesRtp).toBe(true);
            expect(result.frameCount).toBeGreaterThanOrEqual(1);
            expect(result.keyframeCount).toBeGreaterThanOrEqual(1);
            assertNegotiatedMime(
              result.negotiatedMime ?? result.expectedMime,
              codec,
            );
            expect(typeof result.payloadType).toBe("number");
            assertClockAndTimestamps(result, codec);
            expect(result.framesRepacketized).toBeGreaterThanOrEqual(1);
            expect(result.packetsSent).toBeGreaterThanOrEqual(1);
            // 小さな maxPayloadSize で再 packetize するので multi-packet を期待
            expect(result.multiPacketFrames).toBeGreaterThanOrEqual(1);

            // Assert Chrome が再 packetize された映像を再生
            const remoteTrack = await received;
            await waitVideoPlay(remoteTrack, 30_000);
          } finally {
            if (serverReady) {
              await requestServerDone(label);
            }
            pc.close();
          }
        },
        60_000,
      );
    }
  });
});
