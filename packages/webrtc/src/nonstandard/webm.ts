import * as EBML from "@shinyoshiaki/ebml-builder";
import { appendFile, readFile, writeFile } from "fs/promises";

import { BitWriter, bufferWriter, bufferWriterLE } from "../../../common/src";
import { OpusRtpPayload, Vp8RtpPayload } from "../../../rtp/src";
import { PromiseQueue } from "../helper";
import { MediaStreamTrack } from "../media/track";
import { SampleBuilder } from "./sampleBuilder";

export class WebmFactory {
  private relativeTimestamp = 0;
  private disposer?: () => void;
  private position = 0;
  private staticPartOffset = 0;
  private queue = new PromiseQueue();

  /**video cuePoints (keyframe) */
  private cuePoints: CuePoint[] = [];
  private tracks: {
    audio?: {
      trackNumber: number;
      track: MediaStreamTrack;
      sampleBuilder: SampleBuilder;
    };
    video?: {
      trackNumber: number;
      track: MediaStreamTrack;
      sampleBuilder: SampleBuilder;
    };
  } = {};

  constructor(
    tracks: MediaStreamTrack[],
    public path: string,
    public options: TrackOptions = {}
  ) {
    tracks.forEach((track, i) => {
      const sampleBuilder = (() => {
        if (track.kind === "video") {
          return new SampleBuilder(Vp8RtpPayload, 90000);
        } else {
          return new SampleBuilder(OpusRtpPayload, 48000);
        }
      })();
      this.tracks[track.kind] = { track, trackNumber: i + 1, sampleBuilder };
    });
  }

  async start() {
    const entries = createTrackEntries(
      Object.values(this.tracks).map(({ track }) => track),
      this.options
    );
    const segment = EBML.build(createSegment(entries));
    const staticPart = Buffer.concat([ebmlHeader, segment]);
    this.staticPartOffset = staticPart.length;

    await writeFile(this.path, staticPart);
    this.position += staticPart.length;

    const length = await this.appendCluster(0.0);
    this.appendCuePoint(0.0);
    this.position += length;

    const disposers = Object.values(this.tracks).map(
      ({ track, sampleBuilder, trackNumber }) => {
        const appendCluster = async () => {
          if (sampleBuilder.relativeTimestamp === 0) return;

          this.relativeTimestamp += sampleBuilder.relativeTimestamp;

          const length = await this.appendCluster(this.relativeTimestamp);
          this.appendCuePoint(this.relativeTimestamp);
          this.position += length;

          Object.values(this.tracks).forEach(({ sampleBuilder }) =>
            sampleBuilder.resetTimestamp()
          );
        };

        const { unSubscribe } = track.onReceiveRtp.subscribe((rtp) => {
          this.queue.push(async () => {
            {
              if (track.kind === "video") {
                if (
                  sampleBuilder.DePacketizer.deSerialize(rtp.payload)
                    .isKeyframe ||
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

              await this.write(
                data,
                isKeyframe,
                relativeTimestamp,
                trackNumber
              );
            }
          });
        });
        return unSubscribe;
      }
    );
    this.disposer = () => {
      disposers.forEach((unSubscribe) => unSubscribe());
    };
  }

  async stop() {
    await this.queue.push(async () => {
      if (!this.disposer) {
        throw new Error();
      }
      this.disposer();

      const latestTimestamp = Object.values(this.tracks)
        .map(({ sampleBuilder }) => sampleBuilder)
        .sort(
          (a, b) => a.relativeTimestamp - b.relativeTimestamp
        )[0].relativeTimestamp;
      const duration = this.relativeTimestamp + latestTimestamp;

      const entries = createTrackEntries(
        Object.values(this.tracks).map(({ track }) => track),
        this.options
      );
      const segment = EBML.build(
        createSegment(entries, [
          EBML.element(EBML.ID.Duration, EBML.float(duration)),
        ])
      );

      const staticPart = Buffer.concat([ebmlHeader, segment]);
      const staticPartGap = staticPart.length - this.staticPartOffset;

      this.cuePoints.forEach((cue) => {
        cue.offset = staticPartGap;
      });
      const cues = EBML.build(
        EBML.element(
          EBML.ID.Cues,
          this.cuePoints.map((cue) => cue.build())
        )
      );

      const clusters = (await readFile(this.path)).slice(this.staticPartOffset);

      await writeFile(this.path, staticPart);
      await appendFile(this.path, clusters);
      await appendFile(this.path, cues);
    });
  }

  private async write(
    data: Buffer,
    isKeyframe: boolean,
    relativeTimestamp: number,
    trackNumber: number
  ) {
    const simpleBlock = createSimpleBlock(
      data,
      isKeyframe,
      relativeTimestamp,
      trackNumber
    );
    this.position += simpleBlock.length;

    await appendFile(this.path, simpleBlock);
  }

  private async appendCluster(timecode: number) {
    const buf = EBML.build(
      EBML.unknownSizeElement(EBML.ID.Cluster, [
        EBML.element(EBML.ID.Timecode, EBML.number(timecode)),
      ])
    );
    await appendFile(this.path, buf);
    return buf.length;
  }

  private appendCuePoint(timecode: number) {
    const trackNumber = this.tracks?.video?.trackNumber;
    if (trackNumber != undefined) {
      this.cuePoints.push(new CuePoint(trackNumber, timecode, this.position));
    }
  }
}

///////////////////////////////////////////////

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

function createSimpleBlock(
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
  return simpleBlock;
}

function createTrackEntries(
  tracks: MediaStreamTrack[],
  options: TrackOptions = {}
) {
  return tracks.map((track, i) => {
    if (track.kind === "video") {
      return createTrackEntry(i + 1, "V_VP8", "video", [
        EBML.element(EBML.ID.Video, [
          EBML.element(EBML.ID.PixelWidth, EBML.number(options.width)),
          EBML.element(EBML.ID.PixelHeight, EBML.number(options.height)),
        ]),
      ]);
    } else {
      return createTrackEntry(i + 1, "A_OPUS", "audio", [
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
    }
  });
}

function createTrackEntry(
  trackNumber: number,
  codec: string,
  type: "audio" | "video",
  elements: EBML.EBMLData[] = []
) {
  return EBML.element(EBML.ID.TrackEntry, [
    EBML.element(EBML.ID.TrackNumber, EBML.number(trackNumber)),
    EBML.element(EBML.ID.TrackUID, EBML.number(trackNumber)),
    EBML.element(EBML.ID.CodecID, EBML.string(codec)),
    EBML.element(EBML.ID.TrackType, EBML.number(type === "video" ? 1 : 2)),
    ...elements,
  ]);
}

function createSegment(
  entries: EBML.EBMLData[],
  infoElements: EBML.EBMLData[] = []
) {
  return EBML.unknownSizeElement(EBML.ID.Segment, [
    EBML.element(EBML.ID.SeekHead, []),
    EBML.element(EBML.ID.Info, [
      EBML.element(EBML.ID.TimecodeScale, EBML.number(millisecond)),
      EBML.element(EBML.ID.MuxingApp, EBML.string("werift.mux")),
      EBML.element(EBML.ID.WritingApp, EBML.string("werift.write")),
      ...infoElements,
    ]),
    EBML.element(EBML.ID.Tracks, entries),
  ]);
}

const millisecond = 1000000;
/**32767 */
const maxSingedInt = (0x01 << 16) / 2 - 1;

type TrackOptions = Partial<{ width: number; height: number }>;

class CuePoint {
  private readonly seekHeadPosition = 48;
  offset?: number;
  blockNumber = 0;

  constructor(
    private trackNumber: number,
    private relativeTimestamp: number,
    private position: number
  ) {}

  build() {
    if (this.offset == undefined) throw new Error();

    const cue = EBML.element(EBML.ID.CuePoint, [
      EBML.element(EBML.ID.CueTime, EBML.number(this.relativeTimestamp)),
      EBML.element(EBML.ID.CueTrackPositions, [
        EBML.element(EBML.ID.CueTrack, EBML.number(this.trackNumber)),
        EBML.element(
          EBML.ID.CueClusterPosition,
          EBML.number(this.offset + this.position - this.seekHeadPosition)
        ),
        EBML.element(EBML.ID.CueBlockNumber, EBML.number(this.blockNumber)),
      ]),
    ]);
    return cue;
  }
}
