import { unlink } from "fs/promises";
import { EventDisposer } from "rx.mini";

import {
  DepacketizeCallback,
  JitterBufferCallback,
  LipsyncCallback,
  NtpTimeCallback,
  RtcpSourceCallback,
  RtpSourceCallback,
  saveToFileSystem,
  WebmCallback,
  SupportedCodec,
} from "../../../../../rtp/src/extra";
import { MediaStreamTrack, WeriftError } from "../../..";
import { MediaWriter } from ".";

const sourcePath = "packages/webrtc/src/nonstandard/recorder/writer/webm.ts";

export class WebmFactory extends MediaWriter {
  rtpSources: RtpSourceCallback[] = [];

  unSubscribers = new EventDisposer();

  async start(tracks: MediaStreamTrack[]) {
    await unlink(this.path).catch((e) => e);

    const inputTracks = tracks.map((track, i) => {
      const trackNumber = i + 1;
      const payloadType = track.codec!.payloadType;

      if (track.kind === "video") {
        const codec = ((): SupportedCodec => {
          switch (track.codec?.name.toLowerCase() as SupportedVideoCodec) {
            case "vp8":
              return "VP8";
            case "vp9":
              return "VP9";
            case "h264":
              return "MPEG4/ISO/AVC";
            case "av1x":
              return "AV1";
            default:
              throw new WeriftError({
                message: "unsupported codec",
                payload: { track, path: sourcePath },
              });
          }
        })();
        return {
          kind: "video" as const,
          codec,
          clockRate: 90000,
          trackNumber,
          width: this.options.width,
          height: this.options.height,
          payloadType,
          track,
        };
      } else {
        return {
          kind: "audio" as const,
          codec: "OPUS" as const,
          clockRate: 48000,
          trackNumber,
          payloadType,
          track,
        };
      }
    });

    const webm = new WebmCallback(inputTracks, {
      duration: this.options.defaultDuration ?? 1000 * 60 * 60 * 24,
    });
    const lipsync = new LipsyncCallback();

    this.rtpSources = inputTracks.map(({ track, clockRate, codec }) => {
      const rtpSource = new RtpSourceCallback();
      const rtcpSource = new RtcpSourceCallback();
      track.onReceiveRtp
        .subscribe((rtp) => {
          rtpSource.input(rtp.clone());
        })
        .disposer(this.unSubscribers);
      track.onReceiveRtcp
        .subscribe((rtcp) => {
          rtcpSource.input(rtcp);
        })
        .disposer(this.unSubscribers);
      const ntpTime = new NtpTimeCallback(clockRate);

      if (track.kind === "video") {
        const depacketizer = new DepacketizeCallback(codec, {
          isFinalPacketInSequence: (h) => h.marker,
        });
        const jitterBuffer = new JitterBufferCallback(clockRate);

        rtpSource.pipe(jitterBuffer.input);
        rtcpSource.pipe(ntpTime.input);

        jitterBuffer.pipe(ntpTime.input);
        ntpTime.pipe(depacketizer.input);
        depacketizer.pipe(lipsync.inputVideo);
        lipsync.pipeVideo(webm.inputVideo);
      } else {
        const depacketizer = new DepacketizeCallback(codec);

        rtpSource.pipe(ntpTime.input);
        rtcpSource.pipe(ntpTime.input);

        ntpTime.pipe(depacketizer.input);
        depacketizer.pipe(lipsync.inputAudio);
        lipsync.pipeAudio(webm.inputAudio);
      }

      return rtpSource;
    });
    webm.pipe(saveToFileSystem(this.path));
  }

  async stop() {
    await Promise.all(this.rtpSources.map((r) => r.stop()));
    this.unSubscribers.dispose();
  }
}

const supportedVideoCodecs = ["h264", "vp8", "vp9", "av1x"] as const;
type SupportedVideoCodec = (typeof supportedVideoCodecs)[number];
