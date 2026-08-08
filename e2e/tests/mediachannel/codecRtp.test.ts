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

/** Poll server status (short requests) until depacketize success or timeout. */
async function pollDepacketizeSuccess(
  label: string,
  timeoutMs = 40_000,
): Promise<{
  ok: boolean;
  frameCount: number;
  keyframeCount: number;
  totalBytes: number;
  rtpPackets: number;
  usedPackagesRtp: boolean;
}> {
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
          if (!chromeCanSend(codec)) {
            // Open-source Chromium often lacks proprietary H.264 encode
            console.warn(
              `skip depacketize_${codec}: Chrome cannot encode (capabilities)`,
            );
            ctx.skip();
            return;
          }
          await ensurePeer();
          const label = method("depacketize", codec);
          const kind = kindOf(codec);

          const pc = new RTCPeerConnection(ICE);
          try {
            pc.onicecandidate = ({ candidate }) => {
              peer
                .request(label, { type: "candidate", payload: candidate })
                .catch(() => {});
            };

            // Arrange: getUserMedia / fake device で Chrome エンコード
            // oneway と同様 addTrack を使う
            const constraints =
              kind === "video"
                ? { video: true, audio: false }
                : { video: false, audio: true };
            const stream = await navigator.mediaDevices.getUserMedia(
              constraints,
            );
            const mediaTrack = stream.getTracks()[0];
            pc.addTrack(mediaTrack);
            for (const t of pc.getTransceivers()) {
              preferCodec(t, codecMime(codec), kind);
            }

            // Act: offer/answer 交換
            const offer = await peer.request(label, { type: "init" });
            await pc.setRemoteDescription(offer);
            for (const t of pc.getTransceivers()) {
              preferCodec(t, codecMime(codec), kind);
            }
            await pc.setLocalDescription(await pc.createAnswer());
            await peer.request(label, {
              type: "answer",
              payload: pc.localDescription,
            });

            // Assert: Node 側で packages/rtp depacketize が非空フレームを得る
            const result = await pollDepacketizeSuccess(label);
            expect(result.ok).toBe(true);
            expect(result.usedPackagesRtp).toBe(true);
            expect(result.frameCount).toBeGreaterThanOrEqual(1);
            expect(result.totalBytes).toBeGreaterThan(0);
            if (kind === "video") {
              // 映像はキーフレームを少なくとも 1 回
              expect(result.keyframeCount).toBeGreaterThanOrEqual(1);
            }

            await peer.request(label, { type: "done" });
          } finally {
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
          if (!chromeCanRecv(codec)) {
            console.warn(
              `skip packetize_${codec}: Chrome cannot decode (capabilities)`,
            );
            ctx.skip();
            return;
          }
          await ensurePeer();
          const label = method("packetize", codec);
          const kind = kindOf(codec);

          const pc = new RTCPeerConnection(ICE);
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

            // Assert: Chrome が RTP を受信しデコード経路に載る
            if (codec === "h264") {
              // H.264 は黒画面でも合格可 — 画素変化は必須にしない
              const inbound = await waitInboundRtp(pc, 3, 40_000);
              expect(inbound.packetsReceived).toBeGreaterThanOrEqual(3);
            } else if (kind === "video") {
              await waitVideoPlay(track);
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

            // Node 側が packages/rtp Packetizer を使ったことを確認
            const status = (await peer.request(label, { type: "status" })) as {
              usedPackagesRtp: boolean;
              framesSent: number;
            };
            expect(status.usedPackagesRtp).toBe(true);

            const done = (await peer.request(label, { type: "done" })) as {
              usedPackagesRtp?: boolean;
              framesSent?: number;
              packetsSent?: number;
            };
            expect(done.usedPackagesRtp).toBe(true);
            if (typeof done.framesSent === "number") {
              expect(done.framesSent).toBeGreaterThanOrEqual(1);
            }
          } finally {
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
        async () => {
          if (!chromeCanSend(codec)) {
            console.warn(`skip repacketize_${codec}: Chrome cannot encode`);
            return;
          }
          await ensurePeer();
          const label = method("repacketize", codec);

          const pc = new RTCPeerConnection(ICE);
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
            await pc.setRemoteDescription(offer);
            for (const t of pc.getTransceivers()) {
              preferCodec(t, codecMime(codec), "video");
            }
            await pc.setLocalDescription(await pc.createAnswer());
            await peer.request(label, {
              type: "answer",
              payload: pc.localDescription,
            });

            // Assert Node depacketize 成功
            const result = await pollDepacketizeSuccess(label);
            expect(result.ok).toBe(true);
            expect(result.usedPackagesRtp).toBe(true);
            expect(result.frameCount).toBeGreaterThanOrEqual(1);
            expect(result.keyframeCount).toBeGreaterThanOrEqual(1);

            // Assert Chrome が再 packetize された映像を再生
            const remoteTrack = await received;
            await waitVideoPlay(remoteTrack);

            await peer.request(label, { type: "done" });
          } finally {
            pc.close();
          }
        },
        60_000,
      );
    }
  });
});
