import { appendFile, writeFile } from "fs/promises";
import * as EBML from "simple-ebml-builder";

import { BitWriter, bufferWriter } from "../../../common/src";
import { OpusRtpPayload, Vp8RtpPayload } from "../../../rtp/src";
import { MediaStreamTrack } from "../media/track";
import { SampleBuilder } from "./sampleBuilder";

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
  ebmlSegment!: Uint8Array;
  constructor(
    public tracks: MediaStreamTrack[],
    public path: string,
    public options: Partial<{ width: number; height: number }> = {}
  ) {
    this.buildEbml();
  }

  private buildEbml() {
    const entries = this.tracks.map((track, i) => {
      if (track.kind === "video") {
        return EBML.element(EBML.ID.TrackEntry, [
          EBML.element(EBML.ID.TrackNumber, EBML.number(i)),
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
          EBML.element(EBML.ID.TrackNumber, EBML.number(i)),
          EBML.element(EBML.ID.TrackUID, EBML.number(12345)),
          EBML.element(EBML.ID.CodecID, EBML.string("A_OPUS")),
          EBML.element(EBML.ID.TrackType, EBML.number(2)),
          EBML.element(EBML.ID.Audio, [
            EBML.element(EBML.ID.SamplingFrequency, EBML.number(48000.0)),
            EBML.element(EBML.ID.Channels, EBML.number(2)),
          ]),
        ]);
      } else {
        throw new Error();
      }
    });
    this.ebmlSegment = EBML.build(
      EBML.unknownSizeElement(EBML.ID.Segment, [
        EBML.element(EBML.ID.Info, [
          EBML.element(EBML.ID.TimecodeScale, EBML.number(millisecond)),
          EBML.element(EBML.ID.MuxingApp, EBML.string("werift.mux")),
          EBML.element(EBML.ID.WritingApp, EBML.string("werift.write")),
        ]),
        EBML.element(EBML.ID.Tracks, entries),
        EBML.unknownSizeElement(EBML.ID.Cluster, [
          EBML.element(EBML.ID.Timecode, EBML.number(0.0)),
        ]),
      ])
    );
  }

  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
    this.buildEbml();
  }

  private disposer?: () => void;

  async start() {
    await writeFile(this.path, Buffer.concat([ebmlHeader, this.ebmlSegment]));

    const res = this.tracks.map((track, i) => {
      const sampleBuilder =
        track.kind === "video"
          ? new SampleBuilder(Vp8RtpPayload, 90000)
          : new SampleBuilder(OpusRtpPayload, 48000);
      const { unSubscribe } = track.onReceiveRtp.subscribe((rtp) => {
        sampleBuilder.push(rtp);
        const res = sampleBuilder.build();
        if (!res) return;
        const { data, relativeTimestamp, isKeyframe } = res;
        this.write(data, isKeyframe, relativeTimestamp, i);
      });
      return unSubscribe;
    });
    this.disposer = () => {
      res.forEach((unSubscribe) => unSubscribe());
    };
  }

  stop() {
    if (!this.disposer) {
      throw new Error();
    }
    this.disposer();
  }

  private write(
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

    appendFile(this.path, simpleBlock);
  }
}

const millisecond = 1000000;
