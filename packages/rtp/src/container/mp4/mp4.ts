import MP4 from "./mp4-generator";

export class Mp4Builder {
  constructor() {
    const initSegment = MP4.initSegment([
      {
        timescale: 600,
        duration: 0,
        id: 1,
        width: 416,
        height: 234,
        type: "video",
        sps: [],
        pps: [],
        pixelRatio: [1, 1],
      },
      {
        timescale: 600,
        duration: 0,
        id: 2,
        width: 0,
        height: 0,
        type: "audio",
        segmentCodec: "?",
        codec: "?",
        samplerate: 48000,
        channelCount: 2,
      },
    ]);
  }

  fragment() {
    const moof = MP4.moof();
  }
}
