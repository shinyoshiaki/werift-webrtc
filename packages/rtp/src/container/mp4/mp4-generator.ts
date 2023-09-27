/**
 * Generate MP4 Box
 * hls.js/src/remux/mp4-generator.ts
 */

import { appendUint8Array } from "./mp4-tools";

type HdlrTypes = {
  video: Uint8Array;
  audio: Uint8Array;
};

const UINT32_MAX = Math.pow(2, 32) - 1;

export class MP4 {
  public static types: Record<string, number[]>;
  private static HDLR_TYPES: HdlrTypes;
  private static STTS: Uint8Array;
  private static STSC: Uint8Array;
  private static STCO: Uint8Array;
  private static STSZ: Uint8Array;
  private static VMHD: Uint8Array;
  private static SMHD: Uint8Array;
  private static STSD: Uint8Array;
  private static FTYP: Uint8Array;
  private static DINF: Uint8Array;

  static init() {
    MP4.types = {
      avc1: [], // codingname
      avcC: [],
      btrt: [],
      dinf: [],
      dref: [],
      esds: [],
      ftyp: [],
      hdlr: [],
      mdat: [],
      mdhd: [],
      mdia: [],
      mfhd: [],
      minf: [],
      moof: [],
      moov: [],
      mp4a: [],
      ".mp3": [],
      dac3: [],
      "ac-3": [],
      mvex: [],
      mvhd: [],
      pasp: [],
      sdtp: [],
      stbl: [],
      stco: [],
      stsc: [],
      stsd: [],
      stsz: [],
      stts: [],
      tfdt: [],
      tfhd: [],
      traf: [],
      trak: [],
      trun: [],
      trex: [],
      tkhd: [],
      vmhd: [],
      smhd: [],
    };

    let i: string;
    for (i in MP4.types) {
      if (MP4.types.hasOwnProperty(i)) {
        MP4.types[i] = [
          i.charCodeAt(0),
          i.charCodeAt(1),
          i.charCodeAt(2),
          i.charCodeAt(3),
        ];
      }
    }

    const videoHdlr = new Uint8Array([
      0x00, // version 0
      0x00,
      0x00,
      0x00, // flags
      0x00,
      0x00,
      0x00,
      0x00, // pre_defined
      0x76,
      0x69,
      0x64,
      0x65, // handler_type: 'vide'
      0x00,
      0x00,
      0x00,
      0x00, // reserved
      0x00,
      0x00,
      0x00,
      0x00, // reserved
      0x00,
      0x00,
      0x00,
      0x00, // reserved
      0x56,
      0x69,
      0x64,
      0x65,
      0x6f,
      0x48,
      0x61,
      0x6e,
      0x64,
      0x6c,
      0x65,
      0x72,
      0x00, // name: 'VideoHandler'
    ]);

    const audioHdlr = new Uint8Array([
      0x00, // version 0
      0x00,
      0x00,
      0x00, // flags
      0x00,
      0x00,
      0x00,
      0x00, // pre_defined
      0x73,
      0x6f,
      0x75,
      0x6e, // handler_type: 'soun'
      0x00,
      0x00,
      0x00,
      0x00, // reserved
      0x00,
      0x00,
      0x00,
      0x00, // reserved
      0x00,
      0x00,
      0x00,
      0x00, // reserved
      0x53,
      0x6f,
      0x75,
      0x6e,
      0x64,
      0x48,
      0x61,
      0x6e,
      0x64,
      0x6c,
      0x65,
      0x72,
      0x00, // name: 'SoundHandler'
    ]);

    MP4.HDLR_TYPES = {
      video: videoHdlr,
      audio: audioHdlr,
    };

    const dref = new Uint8Array([
      0x00, // version 0
      0x00,
      0x00,
      0x00, // flags
      0x00,
      0x00,
      0x00,
      0x01, // entry_count
      0x00,
      0x00,
      0x00,
      0x0c, // entry_size
      0x75,
      0x72,
      0x6c,
      0x20, // 'url' type
      0x00, // version 0
      0x00,
      0x00,
      0x01, // entry_flags
    ]);

    const stco = new Uint8Array([
      0x00, // version
      0x00,
      0x00,
      0x00, // flags
      0x00,
      0x00,
      0x00,
      0x00, // entry_count
    ]);

    MP4.STTS = MP4.STSC = MP4.STCO = stco;

    MP4.STSZ = new Uint8Array([
      0x00, // version
      0x00,
      0x00,
      0x00, // flags
      0x00,
      0x00,
      0x00,
      0x00, // sample_size
      0x00,
      0x00,
      0x00,
      0x00, // sample_count
    ]);
    MP4.VMHD = new Uint8Array([
      0x00, // version
      0x00,
      0x00,
      0x01, // flags
      0x00,
      0x00, // graphicsmode
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // opcolor
    ]);
    MP4.SMHD = new Uint8Array([
      0x00, // version
      0x00,
      0x00,
      0x00, // flags
      0x00,
      0x00, // balance
      0x00,
      0x00, // reserved
    ]);

    MP4.STSD = new Uint8Array([
      0x00, // version 0
      0x00,
      0x00,
      0x00, // flags
      0x00,
      0x00,
      0x00,
      0x01,
    ]); // entry_count

    const majorBrand = new Uint8Array([105, 115, 111, 109]); // isom
    const avc1Brand = new Uint8Array([97, 118, 99, 49]); // avc1
    const minorVersion = new Uint8Array([0, 0, 0, 1]);

    MP4.FTYP = MP4.box(
      MP4.types.ftyp,
      majorBrand,
      minorVersion,
      majorBrand,
      avc1Brand
    );
    MP4.DINF = MP4.box(MP4.types.dinf, MP4.box(MP4.types.dref, dref));
  }

  static box(type: number[], ...payload: Uint8Array[]) {
    let size = 8;
    let i = payload.length;
    const len = i;
    // calculate the total size we need to allocate
    while (i--) {
      size += payload[i].byteLength;
    }

    const result = new Uint8Array(size);
    result[0] = (size >> 24) & 0xff;
    result[1] = (size >> 16) & 0xff;
    result[2] = (size >> 8) & 0xff;
    result[3] = size & 0xff;
    result.set(type, 4);
    // copy the payload into the result
    for (i = 0, size = 8; i < len; i++) {
      // copy payload[i] array @ offset size
      result.set(payload[i], size);
      size += payload[i].byteLength;
    }
    return result;
  }

  static hdlr(type: "audio" | "video") {
    return MP4.box(MP4.types.hdlr, MP4.HDLR_TYPES[type]);
  }

  static mdat(data) {
    return MP4.box(MP4.types.mdat, data);
  }

  static mdhd(timescale: number, duration: number) {
    duration *= timescale;
    const upperWordDuration = Math.floor(duration / (UINT32_MAX + 1));
    const lowerWordDuration = Math.floor(duration % (UINT32_MAX + 1));
    return MP4.box(
      MP4.types.mdhd,
      new Uint8Array([
        0x01, // version 1
        0x00,
        0x00,
        0x00, // flags
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x02, // creation_time
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x03, // modification_time
        (timescale >> 24) & 0xff,
        (timescale >> 16) & 0xff,
        (timescale >> 8) & 0xff,
        timescale & 0xff, // timescale
        upperWordDuration >> 24,
        (upperWordDuration >> 16) & 0xff,
        (upperWordDuration >> 8) & 0xff,
        upperWordDuration & 0xff,
        lowerWordDuration >> 24,
        (lowerWordDuration >> 16) & 0xff,
        (lowerWordDuration >> 8) & 0xff,
        lowerWordDuration & 0xff,
        0x55,
        0xc4, // 'und' language (undetermined)
        0x00,
        0x00,
      ])
    );
  }

  static mdia(track: Track) {
    return MP4.box(
      MP4.types.mdia,
      MP4.mdhd(track.timescale, track.duration),
      MP4.hdlr(track.type),
      MP4.minf(track)
    );
  }

  static mfhd(sequenceNumber: number) {
    return MP4.box(
      MP4.types.mfhd,
      new Uint8Array([
        0x00,
        0x00,
        0x00,
        0x00, // flags
        sequenceNumber >> 24,
        (sequenceNumber >> 16) & 0xff,
        (sequenceNumber >> 8) & 0xff,
        sequenceNumber & 0xff, // sequence_number
      ])
    );
  }

  static minf(track: Track) {
    if (track.type === "audio") {
      return MP4.box(
        MP4.types.minf,
        MP4.box(MP4.types.smhd, MP4.SMHD),
        MP4.DINF,
        MP4.stbl(track)
      );
    } else {
      return MP4.box(
        MP4.types.minf,
        MP4.box(MP4.types.vmhd, MP4.VMHD),
        MP4.DINF,
        MP4.stbl(track)
      );
    }
  }

  static moof(
    sequenceNumber: number,
    /**uint32 */
    baseMediaDecodeTime: number,
    track: Track
  ) {
    return MP4.box(
      MP4.types.moof,
      MP4.mfhd(sequenceNumber),
      MP4.traf(track, baseMediaDecodeTime)
    );
  }

  static moov(tracks: Track[]) {
    let i = tracks.length;
    const boxes: Uint8Array[] = [];

    while (i--) {
      boxes[i] = MP4.trak(tracks[i]);
    }

    return MP4.box.apply(null, [
      MP4.types.moov,
      MP4.mvhd(tracks[0].timescale, tracks[0].duration),
      ...boxes,
      MP4.mvex(tracks),
    ]);
  }

  static mvex(tracks: Track[]) {
    let i = tracks.length;
    const boxes: Uint8Array[] = [];

    while (i--) {
      boxes[i] = MP4.trex(tracks[i]);
    }

    return MP4.box.apply(null, [MP4.types.mvex, ...boxes]);
  }

  static mvhd(timescale: number, duration: number) {
    duration *= timescale;
    const upperWordDuration = Math.floor(duration / (UINT32_MAX + 1));
    const lowerWordDuration = Math.floor(duration % (UINT32_MAX + 1));
    const bytes = new Uint8Array([
      0x01, // version 1
      0x00,
      0x00,
      0x00, // flags
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x02, // creation_time
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x03, // modification_time
      (timescale >> 24) & 0xff,
      (timescale >> 16) & 0xff,
      (timescale >> 8) & 0xff,
      timescale & 0xff, // timescale
      upperWordDuration >> 24,
      (upperWordDuration >> 16) & 0xff,
      (upperWordDuration >> 8) & 0xff,
      upperWordDuration & 0xff,
      lowerWordDuration >> 24,
      (lowerWordDuration >> 16) & 0xff,
      (lowerWordDuration >> 8) & 0xff,
      lowerWordDuration & 0xff,
      0x00,
      0x01,
      0x00,
      0x00, // 1.0 rate
      0x01,
      0x00, // 1.0 volume
      0x00,
      0x00, // reserved
      0x00,
      0x00,
      0x00,
      0x00, // reserved
      0x00,
      0x00,
      0x00,
      0x00, // reserved
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x40,
      0x00,
      0x00,
      0x00, // transformation: unity matrix
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // pre_defined
      0xff,
      0xff,
      0xff,
      0xff, // next_track_ID
    ]);
    return MP4.box(MP4.types.mvhd, bytes);
  }

  static sdtp(track: Track) {
    const samples = track.samples || [];
    const bytes = new Uint8Array(4 + samples.length);
    let i;
    let flags;
    // leave the full box header (4 bytes) all zero
    // write the sample table
    for (i = 0; i < samples.length; i++) {
      flags = samples[i].flags;
      bytes[i + 4] =
        (flags.dependsOn << 4) |
        (flags.isDependedOn << 2) |
        flags.hasRedundancy;
    }

    return MP4.box(MP4.types.sdtp, bytes);
  }

  static stbl(track: Track) {
    return MP4.box(
      MP4.types.stbl,
      MP4.stsd(track),
      MP4.box(MP4.types.stts, MP4.STTS),
      MP4.box(MP4.types.stsc, MP4.STSC),
      MP4.box(MP4.types.stsz, MP4.STSZ),
      MP4.box(MP4.types.stco, MP4.STCO)
    );
  }

  static avc1(track: Track) {
    let sps: number[] = [];
    let pps: number[] = [];
    let i;
    let data;
    let len;
    // assemble the SPSs

    const trackSps = track.sps!;
    const trackPps = track.pps!;
    const width = track.width;
    const height = track.height;
    const hSpacing = track.pixelRatio![0];
    const vSpacing = track.pixelRatio![1];

    for (i = 0; i < trackSps.length; i++) {
      data = trackSps[i];
      len = data.byteLength;
      sps.push((len >>> 8) & 0xff);
      sps.push(len & 0xff);

      // SPS
      sps = sps.concat(Array.prototype.slice.call(data));
    }

    // assemble the PPSs
    for (i = 0; i < trackPps.length; i++) {
      data = trackPps[i];
      len = data.byteLength;
      pps.push((len >>> 8) & 0xff);
      pps.push(len & 0xff);

      pps = pps.concat(Array.prototype.slice.call(data));
    }

    const avcc = MP4.box(
      MP4.types.avcC,
      new Uint8Array(
        [
          0x01, // version
          sps[3], // profile
          sps[4], // profile compat
          sps[5], // level
          0xfc | 3, // lengthSizeMinusOne, hard-coded to 4 bytes
          0xe0 | trackSps.length, // 3bit reserved (111) + numOfSequenceParameterSets
        ]
          .concat(sps)
          .concat([
            trackPps.length, // numOfPictureParameterSets
          ])
          .concat(pps)
      )
    ); // "PPS"

    return MP4.box(
      MP4.types.avc1,
      new Uint8Array([
        0x00,
        0x00,
        0x00, // reserved
        0x00,
        0x00,
        0x00, // reserved
        0x00,
        0x01, // data_reference_index
        0x00,
        0x00, // pre_defined
        0x00,
        0x00, // reserved
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00, // pre_defined
        (width >> 8) & 0xff,
        width & 0xff, // width
        (height >> 8) & 0xff,
        height & 0xff, // height
        0x00,
        0x48,
        0x00,
        0x00, // horizresolution
        0x00,
        0x48,
        0x00,
        0x00, // vertresolution
        0x00,
        0x00,
        0x00,
        0x00, // reserved
        0x00,
        0x01, // frame_count
        0x12,
        0x64,
        0x61,
        0x69,
        0x6c, // dailymotion/hls.js
        0x79,
        0x6d,
        0x6f,
        0x74,
        0x69,
        0x6f,
        0x6e,
        0x2f,
        0x68,
        0x6c,
        0x73,
        0x2e,
        0x6a,
        0x73,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00, // compressorname
        0x00,
        0x18, // depth = 24
        0x11,
        0x11,
      ]), // pre_defined = -1
      avcc,
      MP4.box(
        MP4.types.btrt,
        new Uint8Array([
          0x00,
          0x1c,
          0x9c,
          0x80, // bufferSizeDB
          0x00,
          0x2d,
          0xc6,
          0xc0, // maxBitrate
          0x00,
          0x2d,
          0xc6,
          0xc0,
        ])
      ), // avgBitrate
      MP4.box(
        MP4.types.pasp,
        new Uint8Array([
          hSpacing >> 24, // hSpacing
          (hSpacing >> 16) & 0xff,
          (hSpacing >> 8) & 0xff,
          hSpacing & 0xff,
          vSpacing >> 24, // vSpacing
          (vSpacing >> 16) & 0xff,
          (vSpacing >> 8) & 0xff,
          vSpacing & 0xff,
        ])
      )
    );
  }

  static esds(track: Track) {
    const configlen = track.config.length;
    return new Uint8Array(
      [
        0x00, // version 0
        0x00,
        0x00,
        0x00, // flags

        0x03, // descriptor_type
        0x17 + configlen, // length
        0x00,
        0x01, // es_id
        0x00, // stream_priority

        0x04, // descriptor_type
        0x0f + configlen, // length
        0x40, // codec : mpeg4_audio
        0x15, // stream_type
        0x00,
        0x00,
        0x00, // buffer_size
        0x00,
        0x00,
        0x00,
        0x00, // maxBitrate
        0x00,
        0x00,
        0x00,
        0x00, // avgBitrate

        0x05, // descriptor_type
      ]
        .concat([configlen])
        .concat(track.config)
        .concat([0x06, 0x01, 0x02])
    ); // GASpecificConfig)); // length + audio config descriptor
  }

  static audioStsd(track: Track) {
    const samplerate = track.samplerate!;
    const channelCount = track.channelCount!;

    return new Uint8Array([
      0x00,
      0x00,
      0x00, // reserved
      0x00,
      0x00,
      0x00, // reserved
      0x00,
      0x01, // data_reference_index
      //---
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // reserved
      //---
      0x00,
      channelCount, // channelcount
      0x00,
      0x10, // sampleSize:16bits
      0x00,
      0x00,
      0x00,
      0x00, // reserved2
      //---
      (samplerate >> 8) & 0xff,
      samplerate & 0xff, //
      0x00,
      0x00,
    ]);
  }

  static mp4a(track: Track) {
    return MP4.box(
      MP4.types.mp4a,
      MP4.audioStsd(track),
      MP4.box(MP4.types.esds, MP4.esds(track))
    );
  }

  static mp3(track) {
    return MP4.box(MP4.types[".mp3"], MP4.audioStsd(track));
  }

  static ac3(track: Track) {
    return MP4.box(
      MP4.types["ac-3"],
      MP4.audioStsd(track),
      MP4.box(MP4.types.dac3, track.config)
    );
  }

  static stsd(track: Track) {
    const type = track.type;
    const codec = track.codec;
    const segmentCodec = track.segmentCodec;

    if (type === "audio") {
      if (segmentCodec === "mp3" && codec === "mp3") {
        return MP4.box(MP4.types.stsd, MP4.STSD, MP4.mp3(track));
      }
      if (segmentCodec === "ac3") {
        return MP4.box(MP4.types.stsd, MP4.STSD, MP4.ac3(track));
      }
      return MP4.box(MP4.types.stsd, MP4.STSD, MP4.mp4a(track));
    } else {
      return MP4.box(MP4.types.stsd, MP4.STSD, MP4.avc1(track));
    }
  }

  static tkhd(track: Track) {
    const id = track.id;
    const width = track.width;
    const height = track.height;
    const trackTimescale = track.timescale;
    const trackDuration = track.duration;

    const duration = trackDuration * trackTimescale;
    const upperWordDuration = Math.floor(duration / (UINT32_MAX + 1));
    const lowerWordDuration = Math.floor(duration % (UINT32_MAX + 1));

    return MP4.box(
      MP4.types.tkhd,
      new Uint8Array([
        0x01, // version 1
        0x00,
        0x00,
        0x07, // flags
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x02, // creation_time
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x03, // modification_time
        (id >> 24) & 0xff,
        (id >> 16) & 0xff,
        (id >> 8) & 0xff,
        id & 0xff, // track_ID
        0x00,
        0x00,
        0x00,
        0x00, // reserved
        upperWordDuration >> 24,
        (upperWordDuration >> 16) & 0xff,
        (upperWordDuration >> 8) & 0xff,
        upperWordDuration & 0xff,
        lowerWordDuration >> 24,
        (lowerWordDuration >> 16) & 0xff,
        (lowerWordDuration >> 8) & 0xff,
        lowerWordDuration & 0xff,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00, // reserved
        0x00,
        0x00, // layer
        0x00,
        0x00, // alternate_group
        0x00,
        0x00, // non-audio track volume
        0x00,
        0x00, // reserved
        0x00,
        0x01,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x01,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x40,
        0x00,
        0x00,
        0x00, // transformation: unity matrix
        (width >> 8) & 0xff,
        width & 0xff,
        0x00,
        0x00, // width
        (height >> 8) & 0xff,
        height & 0xff,
        0x00,
        0x00, // height
      ])
    );
  }

  static traf(
    track: Track,
    /**uint32 */
    baseMediaDecodeTime: number
  ) {
    const sampleDependencyTable = MP4.sdtp(track);
    const id = track.id;
    const upperWordBaseMediaDecodeTime = Math.floor(
      baseMediaDecodeTime / (UINT32_MAX + 1)
    );
    const lowerWordBaseMediaDecodeTime = Math.floor(
      baseMediaDecodeTime % (UINT32_MAX + 1)
    );
    return MP4.box(
      MP4.types.traf,
      MP4.box(
        MP4.types.tfhd,
        new Uint8Array([
          0x00, // version 0
          0x00,
          0x00,
          0x00, // flags
          id >> 24,
          (id >> 16) & 0xff,
          (id >> 8) & 0xff,
          id & 0xff, // track_ID
        ])
      ),
      MP4.box(
        MP4.types.tfdt,
        new Uint8Array([
          0x01, // version 1
          0x00,
          0x00,
          0x00, // flags
          upperWordBaseMediaDecodeTime >> 24,
          (upperWordBaseMediaDecodeTime >> 16) & 0xff,
          (upperWordBaseMediaDecodeTime >> 8) & 0xff,
          upperWordBaseMediaDecodeTime & 0xff,
          lowerWordBaseMediaDecodeTime >> 24,
          (lowerWordBaseMediaDecodeTime >> 16) & 0xff,
          (lowerWordBaseMediaDecodeTime >> 8) & 0xff,
          lowerWordBaseMediaDecodeTime & 0xff,
        ])
      ),
      MP4.trun(
        track,
        sampleDependencyTable.length +
          16 + // tfhd
          20 + // tfdt
          8 + // traf header
          16 + // mfhd
          8 + // moof header
          8
      ), // mdat header
      sampleDependencyTable
    );
  }

  /**
   * Generate a track box.
   * @param track a track definition
   */
  static trak(track: Track) {
    track.duration = track.duration || 0xffffffff;
    return MP4.box(MP4.types.trak, MP4.tkhd(track), MP4.mdia(track));
  }

  static trex(track: Track) {
    const id = track.id;
    return MP4.box(
      MP4.types.trex,
      new Uint8Array([
        0x00, // version 0
        0x00,
        0x00,
        0x00, // flags
        id >> 24,
        (id >> 16) & 0xff,
        (id >> 8) & 0xff,
        id & 0xff, // track_ID
        0x00,
        0x00,
        0x00,
        0x01, // default_sample_description_index
        0x00,
        0x00,
        0x00,
        0x00, // default_sample_duration
        0x00,
        0x00,
        0x00,
        0x00, // default_sample_size
        0x00,
        0x01,
        0x00,
        0x01, // default_sample_flags
      ])
    );
  }

  static trun(track: Track, offset) {
    const samples = track.samples || [];
    const len = samples.length;
    const arraylen = 12 + 16 * len;
    const array = new Uint8Array(arraylen);
    let i;
    let sample;
    let duration;
    let size;
    let flags;
    let cts;
    offset += 8 + arraylen;
    array.set(
      [
        track.type === "video" ? 0x01 : 0x00, // version 1 for video with signed-int sample_composition_time_offset
        0x00,
        0x0f,
        0x01, // flags
        (len >>> 24) & 0xff,
        (len >>> 16) & 0xff,
        (len >>> 8) & 0xff,
        len & 0xff, // sample_count
        (offset >>> 24) & 0xff,
        (offset >>> 16) & 0xff,
        (offset >>> 8) & 0xff,
        offset & 0xff, // data_offset
      ],
      0
    );
    for (i = 0; i < len; i++) {
      sample = samples[i];
      duration = sample.duration;
      size = sample.size;
      flags = sample.flags;
      cts = sample.cts;
      array.set(
        [
          (duration >>> 24) & 0xff,
          (duration >>> 16) & 0xff,
          (duration >>> 8) & 0xff,
          duration & 0xff, // sample_duration
          (size >>> 24) & 0xff,
          (size >>> 16) & 0xff,
          (size >>> 8) & 0xff,
          size & 0xff, // sample_size
          (flags.isLeading << 2) | flags.dependsOn,
          (flags.isDependedOn << 6) |
            (flags.hasRedundancy << 4) |
            (flags.paddingValue << 1) |
            flags.isNonSync,
          flags.degradPrio & (0xf0 << 8),
          flags.degradPrio & 0x0f, // sample_flags
          (cts >>> 24) & 0xff,
          (cts >>> 16) & 0xff,
          (cts >>> 8) & 0xff,
          cts & 0xff, // sample_composition_time_offset
        ],
        12 + 16 * i
      );
    }
    return MP4.box(MP4.types.trun, array);
  }

  static initSegment(tracks: Track[]) {
    if (!MP4.types) {
      MP4.init();
    }

    const movie = MP4.moov(tracks);
    const result = appendUint8Array(MP4.FTYP, movie);
    return result;
  }
}

export default MP4;

export type Track = DemuxedVideoTrack;

export interface DemuxedVideoTrackBase extends DemuxedTrack {
  width: number;
  height: number;
  pixelRatio?: [number, number];
  audFound?: boolean;
  pps?: Uint8Array[];
  sps?: Uint8Array[];
  naluState?: number;
  segmentCodec?: string;
  manifestCodec?: string;
  samples?: VideoSample[] | Uint8Array;
  config?: any;
  channelCount?: number;
  samplerate?: number;
}

export interface DemuxedVideoTrack extends DemuxedVideoTrackBase {
  samples?: VideoSample[];
}
export interface VideoSample {
  dts: number;
  pts: number;
  key: boolean;
  frame: boolean;
  units: VideoSampleUnit[];
  debug: string;
  length: number;
  flags?: any;
}
export interface VideoSampleUnit {
  data: Uint8Array;
  type: number;
  state?: number;
}
export interface DemuxedTrack {
  type: "audio" | "video";
  id: number;

  samples?:
    | AudioSample[]
    | VideoSample[]
    | MetadataSample[]
    | UserdataSample[]
    | Uint8Array;
  timescale: number;
  container?: string;
  duration: number;
  pesData?: ElementaryStreamData | null;
  codec?: string;
}
export type AudioSample = {
  unit: Uint8Array;
  pts: number;
};
export interface MetadataSample {
  pts: number;
  dts: number;
  duration: number;
  len?: number;
  data: Uint8Array;
  type: MetadataSchema;
}
export interface UserdataSample {
  pts: number;
  bytes?: Uint8Array;
  type?: number;
  payloadType?: number;
  uuid?: string;
  userData?: string;
  userDataBytes?: Uint8Array;
}
export interface ElementaryStreamData {
  data: Uint8Array[];
  size: number;
}
export const enum MetadataSchema {
  audioId3 = "org.id3",
  dateRange = "com.apple.quicktime.HLS",
  emsg = "https://aomedia.org/emsg/ID3",
}
