import * as EBML from "@shinyoshiaki/ebml-builder";
import { debug } from "debug";
import { appendFile, readFile, unlink, writeFile } from "fs/promises";

import { BitWriter, bufferWriter, bufferWriterLE } from "../../../common/src";
import { OpusRtpPayload, Vp8RtpPayload } from "../../../rtp/src";
import { MediaStreamTrack } from "../media/track";
import { SampleBuilder } from "./sampleBuilder";

const log = debug("werift:packages/webrtc/src/nonstandard/recorder.ts log");

const ebmlHeader = EBML.build(
  EBML.element(EBML.ID.EBML, [
    EBML.element(EBML.ID.EBMLVersion, EBML.number(1)),
    EBML.element(EBML.ID.EBMLReadVersion, EBML.number(1)),
    EBML.element(EBML.ID.EBMLMaxIDLength, EBML.number(4)),
    EBML.element(EBML.ID.EBMLMaxSizeLength, EBML.number(8)),
    EBML.element(EBML.ID.DocType, EBML.string("webm")),
    EBML.element(EBML.ID.DocTypeVersion, EBML.number(4)),
    EBML.element(EBML.ID.DocTypeReadVersion, EBML.number(2)),
  ])
);

export class MediaRecorder {
  ebmlSegment!: Buffer;

  private audioSampleBuilder?: SampleBuilder;
  private videoSampleBuilder?: SampleBuilder;
  private disposer?: () => void;
  private relativeTimestamp = 0;
  private position = 0;

  /**video cuePoints (keyframe) */
  private cuePoints: CuePoint[] = [];

  constructor(
    public tracks: MediaStreamTrack[],
    public path: string,
    public options: Partial<{ width: number; height: number }> = {}
  ) {
    this.buildEbmlSegment();
  }

  private buildEbmlSegment(infoElements: EBML.EBMLData[] = []) {
    const entries = this.tracks.map((track, i) => {
      if (track.kind === "video") {
        return EBML.element(EBML.ID.TrackEntry, [
          EBML.element(EBML.ID.TrackNumber, EBML.number(i + 1)),
          EBML.element(EBML.ID.TrackUID, EBML.number(12345)),
          EBML.element(EBML.ID.TrackType, EBML.number(1)),
          EBML.element(EBML.ID.CodecID, EBML.string("V_VP8")),
          EBML.element(EBML.ID.Video, [
            EBML.element(EBML.ID.PixelWidth, EBML.number(this.options.width)),
            EBML.element(EBML.ID.PixelHeight, EBML.number(this.options.height)),
          ]),
        ]);
      } else if (track.kind === "audio") {
        return EBML.element(EBML.ID.TrackEntry, [
          EBML.element(EBML.ID.TrackNumber, EBML.number(i + 1)),
          EBML.element(EBML.ID.TrackUID, EBML.number(67891)),
          EBML.element(EBML.ID.CodecID, EBML.string("A_OPUS")),
          EBML.element(EBML.ID.TrackType, EBML.number(2)),
          EBML.element(EBML.ID.Audio, [
            EBML.element(EBML.ID.SamplingFrequency, EBML.float(48000.0)),
            EBML.element(EBML.ID.Channels, EBML.number(2)),
          ]),
          EBML.element(
            EBML.ID.CodecPrivate,
            EBML.bytes(
              Buffer.concat([
                Buffer.from("OpusHead"),
                bufferWriter([1, 1], [1, 2]),
                bufferWriterLE([2, 4, 2, 1], [312, 48000, 0, 0]),
              ])
            )
          ),
        ]);
      } else {
        throw new Error();
      }
    });
    this.ebmlSegment = Buffer.from(
      EBML.build(
        EBML.unknownSizeElement(EBML.ID.Segment, [
          EBML.element(EBML.ID.SeekHead, []),
          EBML.element(EBML.ID.Info, [
            EBML.element(EBML.ID.TimecodeScale, EBML.number(millisecond)),
            EBML.element(EBML.ID.MuxingApp, EBML.string("werift.mux")),
            EBML.element(EBML.ID.WritingApp, EBML.string("werift.write")),
            ...infoElements,
          ]),
          EBML.element(EBML.ID.Tracks, entries),
        ])
      )
    );
  }

  private async appendCluster(timecode: number) {
    const buf = EBML.build(
      EBML.unknownSizeElement(EBML.ID.Cluster, [
        EBML.element(EBML.ID.Timecode, EBML.number(timecode)),
      ])
    );
    await appendFile(this.path, buf);
    await appendFile(this.path + ".tmp", buf);

    let trackNumber: number | undefined;
    this.tracks.forEach((t, i) => {
      if (t.kind === "video") {
        trackNumber = i + 1;
      }
    });
    if (trackNumber != undefined) {
      this.cuePoints.push(new CuePoint(trackNumber, timecode, this.position));
    }
  }

  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
    this.buildEbmlSegment();
  }

  async start() {
    const staticPart = Buffer.concat([ebmlHeader, this.ebmlSegment]);
    await writeFile(this.path, staticPart);
    await writeFile(this.path + ".tmp", Buffer.from([]));
    this.position += staticPart.length;

    await this.appendCluster(0.0);

    this.tracks.map((track) => {
      if (track.kind === "video") {
        this.videoSampleBuilder = new SampleBuilder(Vp8RtpPayload, 90000);
      } else {
        this.audioSampleBuilder = new SampleBuilder(OpusRtpPayload, 48000);
      }
    });

    const res = this.tracks.map((track, i) => {
      const sampleBuilder = (() => {
        if (track.kind === "video") {
          this.videoSampleBuilder = new SampleBuilder(Vp8RtpPayload, 90000);
          return this.videoSampleBuilder;
        } else {
          this.audioSampleBuilder = new SampleBuilder(OpusRtpPayload, 48000);
          return this.audioSampleBuilder;
        }
      })();

      const appendCluster = async () => {
        if (sampleBuilder.relativeTimestamp === 0) return;

        this.relativeTimestamp += sampleBuilder.relativeTimestamp;

        log("append cluster");

        await this.appendCluster(this.relativeTimestamp);

        this.audioSampleBuilder?.resetTimestamp?.();
        this.videoSampleBuilder?.resetTimestamp?.();
      };

      const { unSubscribe } = track.onReceiveRtp.subscribe(async (rtp) => {
        if (track.kind === "video") {
          if (
            sampleBuilder.DePacketizer.deSerialize(rtp.payload).isKeyframe ||
            sampleBuilder.relativeTimestamp >= maxSingedInt
          ) {
            await appendCluster();
          }
        } else {
          if (sampleBuilder.relativeTimestamp >= maxSingedInt) {
            await appendCluster();
          }
        }

        sampleBuilder.push(rtp);
        const res = sampleBuilder.build();
        if (!res) return;
        const { data, relativeTimestamp, isKeyframe } = res;

        if (track.kind === "video") {
          const [cuePoint] = this.cuePoints.slice(-1);
          cuePoint.blockNumber++;
        }

        const trackNumber = i + 1;
        await this.write(data, isKeyframe, relativeTimestamp, trackNumber);
      });
      return unSubscribe;
    });
    this.disposer = () => {
      res.forEach((unSubscribe) => unSubscribe());
    };
  }

  async stop() {
    if (!this.disposer) {
      throw new Error();
    }
    this.disposer();

    const latestTimestamp = [this.audioSampleBuilder, this.videoSampleBuilder]
      .filter((v): v is NonNullable<typeof v> => v != undefined)
      .sort(
        (a, b) => a.relativeTimestamp - b.relativeTimestamp
      )[0].relativeTimestamp;
    this.relativeTimestamp += latestTimestamp;

    this.buildEbmlSegment([
      EBML.element(EBML.ID.Duration, EBML.float(this.relativeTimestamp)),
    ]);
    const staticPart = Buffer.concat([ebmlHeader, this.ebmlSegment]);
    await writeFile(this.path, staticPart);

    if (this.cuePoints.length > 0) {
      const cues = EBML.build(
        EBML.element(
          EBML.ID.Cues,
          this.cuePoints.map((cue) => cue.build())
        )
      );
      await appendFile(this.path, cues);
    }

    const tmp = await readFile(this.path + ".tmp");
    await appendFile(this.path, tmp);
    await unlink(this.path + ".tmp");
  }

  private async write(
    data: Buffer,
    isKeyframe: boolean,
    relativeTimestamp: number,
    trackNumber: number
  ) {
    const elementId = Buffer.from([0xa3]);
    const contentSize: Uint8Array = EBML.vintEncodedNumber(
      1 + 2 + 1 + data.length
    ).bytes;

    const flags = new BitWriter(8);
    const keyframe = isKeyframe ? 1 : 0;
    flags.set(1, 0, keyframe);
    flags.set(3, 1, 0);
    flags.set(1, 4, 0);
    flags.set(2, 5, 0);
    flags.set(1, 7, 0);

    const simpleBlock = Buffer.concat([
      elementId,
      contentSize,
      EBML.vintEncodedNumber(trackNumber).bytes,
      bufferWriter([2, 1], [relativeTimestamp, flags.value]),
      data,
    ]);
    this.position += simpleBlock.length;

    await appendFile(this.path, simpleBlock);
    await appendFile(this.path + ".tmp", simpleBlock);
  }
}

const millisecond = 1000000;
/**32767 */
const maxSingedInt = (0x01 << 16) / 2 - 1;

class CuePoint {
  private readonly seekHeadPosition = 48;
  blockNumber = 0;

  constructor(
    private trackNumber: number,
    private relativeTimestamp: number,
    private position: number
  ) {}

  build() {
    const cue = EBML.element(EBML.ID.CuePoint, [
      EBML.element(EBML.ID.CueTime, EBML.number(this.relativeTimestamp)),
      EBML.element(EBML.ID.CueTrackPositions, [
        EBML.element(EBML.ID.CueTrack, EBML.number(this.trackNumber)),
        EBML.element(
          EBML.ID.CueClusterPosition,
          EBML.number(this.position - this.seekHeadPosition)
        ),
        EBML.element(EBML.ID.CueBlockNumber, EBML.number(this.blockNumber)),
      ]),
    ]);
    return cue;
  }
}
