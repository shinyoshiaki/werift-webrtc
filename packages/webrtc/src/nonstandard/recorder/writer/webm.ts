import { appendFile, open, unlink } from "fs/promises";
import { ReadableStreamDefaultReadResult } from "stream/web";

import { SupportedCodec } from "../../../../../rtp/src/container/webm";
import {
  depacketizeTransformer,
  jitterBufferTransformer,
  MediaStreamTrack,
  RtpSourceStream,
  WebmStream,
  WebmStreamOutput,
  WeriftError,
} from "../../..";
import { MediaWriter } from ".";

const sourcePath = "packages/webrtc/src/nonstandard/recorder/writer/webm.ts";

export class WebmFactory extends MediaWriter {
  rtpSources: RtpSourceStream[] = [];

  unSubscribers: Record<string, () => void> = {};

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

    const webm = new WebmStream(inputTracks, {
      duration: this.options.defaultDuration ?? 1000 * 60 * 60 * 24,
    });

    this.rtpSources = inputTracks.map(({ track, clockRate, codec }) => {
      const rtpSource = new RtpSourceStream();

      const { unSubscribe } = track.onReceiveRtp.subscribe((r) =>
        rtpSource.push(r)
      );
      this.unSubscribers[track.kind] = unSubscribe;

      const jitterBuffer = jitterBufferTransformer(clockRate, {
        latency: this.options.jitterBufferLatency,
        bufferSize: this.options.jitterBufferSize,
      });

      if (track.kind === "video") {
        rtpSource.readable
          .pipeThrough(jitterBuffer)
          .pipeThrough(
            depacketizeTransformer(codec, {
              waitForKeyframe: this.options.waitForKeyframe,
              isFinalPacketInSequence: (h) => h.marker,
            })
          )
          .pipeTo(webm.videoStream);
      } else {
        rtpSource.readable
          .pipeThrough(jitterBuffer)
          .pipeThrough(depacketizeTransformer(codec))
          .pipeTo(webm.audioStream);
      }

      return rtpSource;
    });

    const reader = webm.webmStream.getReader();
    const readChunk = async ({
      value,
      done,
    }: ReadableStreamDefaultReadResult<WebmStreamOutput>) => {
      if (done) return;

      if (value.saveToFile) {
        await appendFile(this.path, value.saveToFile);
      } else if (value.eol) {
        const { durationElement } = value.eol;
        const handler = await open(this.path, "r+");
        await handler.write(durationElement, 0, durationElement.length, 83);
        await handler.close();
      }
      reader.read().then(readChunk);
    };
    reader.read().then(readChunk);
  }

  async stop() {
    await Promise.all(this.rtpSources.map((r) => r.stop()));

    Object.keys(this.unSubscribers).forEach((item) => {
      this.unSubscribers[item]();
    });
    this.unSubscribers = {};
  }
}

const supportedVideoCodecs = ["h264", "vp8", "vp9", "av1x"] as const;
type SupportedVideoCodec = typeof supportedVideoCodecs[number];
