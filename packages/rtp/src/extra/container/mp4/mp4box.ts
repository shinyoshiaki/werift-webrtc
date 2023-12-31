// Rename some stuff so it's on brand.
export type {
  MP4ArrayBuffer as ArrayBuffer,
  MP4AudioTrack as AudioTrack,
  MP4File as File,
  MP4Info as Info,
  Sample,
  SampleOptions,
  MP4Track as Track,
  TrackOptions,
  MP4VideoTrack as VideoTrack,
} from "mp4box";
export {
  BoxParser,
  ISOFile,
  Log,
  createFile as New,
  DataStream as Stream,
} from "mp4box";

import {
  BoxParser,
  DataStream,
  MP4AudioTrack,
  MP4Track,
  MP4VideoTrack,
} from "mp4box";

export function isAudioTrack(track: MP4Track): track is MP4AudioTrack {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return (track as MP4AudioTrack).audio !== undefined;
}

export function isVideoTrack(track: MP4Track): track is MP4VideoTrack {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return (track as MP4VideoTrack).video !== undefined;
}

// TODO contribute to mp4box
BoxParser.dOpsBox.prototype.write = function (stream: DataStream) {
  this.size = 11;
  this.writeHeader(stream);

  stream.writeUint8(0);
  stream.writeUint8(this.OutputChannelCount);
  stream.writeUint16(this.PreSkip);
  stream.writeUint32(this.InputSampleRate);
  stream.writeUint16(0);
  stream.writeUint8(0);
};
