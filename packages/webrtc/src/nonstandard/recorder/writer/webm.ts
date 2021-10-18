import { SupportedCodec } from "../../../../../rtp/src/container/webm";
import {
  JitterBuffer,
  MediaStreamTrack,
  SampleBuilder,
  WebmOutput,
} from "../../..";
import { MediaWriter } from ".";

export class WebmFactory extends MediaWriter {
  webm?: WebmOutput;

  start(tracks: MediaStreamTrack[]) {
    this.webm = new WebmOutput(
      "./test.webm",
      tracks.map((track) => {
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
                throw new Error();
            }
          })();
          return {
            width: 640,
            height: 360,
            kind: "video",
            codec,
            clockRate: 90000,
            payloadType: track.codec!.payloadType,
            trackNumber: 1,
          };
        } else {
          return {
            kind: "audio",
            codec: "OPUS",
            clockRate: 48000,
            payloadType: track.codec!.payloadType,
            trackNumber: 2,
          };
        }
      })
    );

    tracks.forEach((track) => {
      const sampleBuilder =
        track.kind === "video"
          ? new SampleBuilder((h) => !!h.marker).pipe(this.webm!)
          : new SampleBuilder(() => true).pipe(this.webm!);
      new JitterBuffer({
        rtpStream: track.onReceiveRtp,
        rtcpStream: track.onReceiveRtcp,
      }).pipe(sampleBuilder);
    });
  }

  async stop() {
    await this.webm!.stop();
  }
}

const supportedVideoCodecs = ["h264", "vp8", "vp9", "av1x"] as const;
type SupportedVideoCodec = typeof supportedVideoCodecs[number];
