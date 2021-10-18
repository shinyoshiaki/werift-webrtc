import * as EBML from "@shinyoshiaki/ebml-builder";

import { BitWriter2, BufferChain } from "../../../common/src";
import { OpusRtpPayload } from "..";

export class WEBMBuilder {
  readonly ebmlHeader = EBML.build(
    EBML.element(EBML.ID.EBML, [
      EBML.element(EBML.ID.EBMLVersion, EBML.number(1)),
      EBML.element(EBML.ID.EBMLReadVersion, EBML.number(1)),
      EBML.element(EBML.ID.EBMLMaxIDLength, EBML.number(4)),
      EBML.element(EBML.ID.EBMLMaxSizeLength, EBML.number(8)),
      EBML.element(EBML.ID.DocType, EBML.string("webm")),
      EBML.element(EBML.ID.DocTypeVersion, EBML.number(2)),
      EBML.element(EBML.ID.DocTypeReadVersion, EBML.number(2)),
    ])
  );
  trackEntries: EBML.EBMLData[] = [];

  constructor(
    tracks: {
      width?: number;
      height?: number;
      kind: "audio" | "video";
      codec: SupportedCodec;
      trackNumber: number;
    }[]
  ) {
    this.trackEntries = tracks.map(
      ({ width, height, kind, codec, trackNumber }) => {
        return this.createTrackEntry(kind, trackNumber, codec, {
          width,
          height,
        });
      }
    );
  }

  createTrackEntry(
    kind: string,
    trackNumber: number,
    codec: string,
    { width, height }: Partial<{ kind: string; width: number; height: number }>
  ) {
    const trackElements: EBML.EBMLData[] = [];
    if (kind === "video") {
      trackElements.push(
        EBML.element(EBML.ID.Video, [
          EBML.element(EBML.ID.PixelWidth, EBML.number(width)),
          EBML.element(EBML.ID.PixelHeight, EBML.number(height)),
        ])
      );
    } else {
      trackElements.push(
        EBML.element(EBML.ID.Audio, [
          EBML.element(EBML.ID.SamplingFrequency, EBML.float(48000.0)),
          EBML.element(EBML.ID.Channels, EBML.number(2)),
        ])
      );
      // only support OPUS
      trackElements.push(
        EBML.element(
          EBML.ID.CodecPrivate,
          EBML.bytes(OpusRtpPayload.createCodecPrivate())
        )
      );
    }

    const trackEntry = EBML.element(EBML.ID.TrackEntry, [
      EBML.element(EBML.ID.TrackNumber, EBML.number(trackNumber)),
      EBML.element(EBML.ID.TrackUID, EBML.number(trackNumber)),
      EBML.element(EBML.ID.CodecName, EBML.string(codec)),
      EBML.element(EBML.ID.TrackType, EBML.number(kind === "video" ? 1 : 2)),
      EBML.element(
        EBML.ID.CodecID,
        EBML.string(`${kind === "video" ? "V" : "A"}_${codec}`)
      ),
      ...trackElements,
    ]);
    return trackEntry;
  }

  createSegment(duration?: number) {
    const elements = [
      EBML.element(EBML.ID.TimecodeScale, EBML.number(millisecond)),
      EBML.element(EBML.ID.MuxingApp, EBML.string("webrtc")),
      EBML.element(EBML.ID.WritingApp, EBML.string("webrtc")),
    ];
    if (duration) {
      elements.push(EBML.element(EBML.ID.Duration, EBML.float(duration)));
    }
    return EBML.build(
      EBML.unknownSizeElement(EBML.ID.Segment, [
        EBML.element(EBML.ID.SeekHead, []),
        EBML.element(EBML.ID.Info, elements),
        EBML.element(EBML.ID.Tracks, this.trackEntries),
      ])
    );
  }

  createCuePoint(
    relativeTimestamp: number,
    trackNumber: number,
    clusterPosition: number,
    blockNumber: number
  ) {
    return EBML.element(EBML.ID.CuePoint, [
      EBML.element(EBML.ID.CueTime, EBML.number(relativeTimestamp)),
      EBML.element(EBML.ID.CueTrackPositions, [
        EBML.element(EBML.ID.CueTrack, EBML.number(trackNumber)),
        EBML.element(EBML.ID.CueClusterPosition, EBML.number(clusterPosition)),
        EBML.element(EBML.ID.CueBlockNumber, EBML.number(blockNumber)),
      ]),
    ]);
  }

  createCues(cuePoints: EBML.EBMLData[]) {
    return EBML.build(EBML.element(EBML.ID.Cues, cuePoints));
  }

  createCluster(timecode: number) {
    return EBML.build(
      EBML.unknownSizeElement(EBML.ID.Cluster, [
        EBML.element(EBML.ID.Timecode, EBML.number(timecode)),
      ])
    );
  }

  createSimpleBlock(
    data: Buffer,
    isKeyframe: boolean,
    trackNumber: number,
    relativeTimestamp: number
  ) {
    const elementId = Buffer.from([0xa3]);
    const contentSize: Uint8Array = EBML.vintEncodedNumber(
      1 + 2 + 1 + data.length
    ).bytes;

    const keyframe = isKeyframe ? 1 : 0;
    const flags = new BitWriter2(8)
      .set(keyframe)
      .set(0, 3)
      .set(0)
      .set(0, 2)
      .set(0);

    const simpleBlock = Buffer.concat([
      elementId,
      contentSize,
      EBML.vintEncodedNumber(trackNumber).bytes,
      new BufferChain(2).writeInt16BE(relativeTimestamp).buffer,
      new BufferChain(1).writeUInt8(flags.value).buffer,
      data,
    ]);
    return simpleBlock;
  }
}

const supportedCodecs = ["MPEG4/ISO/AVC", "VP8", "VP9", "AV1", "OPUS"] as const;
export type SupportedCodec = typeof supportedCodecs[number];
const millisecond = 1000000;
