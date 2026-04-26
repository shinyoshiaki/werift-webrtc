import SPSParser from "./sps-parser";

export enum H264NaluType {
  kUnspecified = 0,
  kSliceNonIDR = 1,
  kSliceDPA = 2,
  kSliceDPB = 3,
  kSliceDPC = 4,
  kSliceIDR = 5,
  kSliceSEI = 6,
  kSliceSPS = 7,
  kSlicePPS = 8,
  kSliceAUD = 9,
  kEndOfSequence = 10,
  kEndOfStream = 11,
  kFiller = 12,
  kSPSExt = 13,
  kReserved0 = 14,
}

export class H264NaluPayload {
  type!: H264NaluType;
  data!: Uint8Array;
}

export class H264NaluAVC1 {
  type: H264NaluType;
  data: Uint8Array;

  constructor(nalu: H264NaluPayload) {
    const nalu_size = nalu.data.byteLength;

    this.type = nalu.type;
    this.data = new Uint8Array(4 + nalu_size); // 4 byte length-header + nalu payload

    const v = new DataView(this.data.buffer);
    // Fill 4 byte length-header
    v.setUint32(0, nalu_size);
    // Copy payload
    this.data.set(nalu.data, 4);
  }
}

export class H264AnnexBParser {
  private readonly TAG: string = "H264AnnexBParser";

  private data_: Uint8Array;
  private current_startcode_offset_: number = 0;
  private eof_flag_: boolean = false;

  public constructor(data: Uint8Array) {
    this.data_ = data;
    this.current_startcode_offset_ = this.findNextStartCodeOffset(0);
  }

  private findNextStartCodeOffset(start_offset: number) {
    let i = start_offset;
    const data = this.data_;

    for (;;) {
      if (i + 3 >= data.byteLength) {
        this.eof_flag_ = true;
        return data.byteLength;
      }

      // search 00 00 00 01 or 00 00 01
      const uint32 =
        (data[i + 0] << 24) |
        (data[i + 1] << 16) |
        (data[i + 2] << 8) |
        data[i + 3];
      const uint24 = (data[i + 0] << 16) | (data[i + 1] << 8) | data[i + 2];
      if (uint32 === 0x00000001 || uint24 === 0x000001) {
        return i;
      } else {
        i++;
      }
    }
  }

  public readNextNaluPayload(): H264NaluPayload | null {
    const data = this.data_;
    let nalu_payload: H264NaluPayload | null = null;

    while (nalu_payload == null) {
      if (this.eof_flag_) {
        break;
      }
      // offset pointed to start code
      const startcode_offset = this.current_startcode_offset_;

      // nalu payload start offset
      let offset = startcode_offset;
      const u32 =
        (data[offset] << 24) |
        (data[offset + 1] << 16) |
        (data[offset + 2] << 8) |
        data[offset + 3];
      if (u32 === 0x00000001) {
        offset += 4;
      } else {
        offset += 3;
      }

      const nalu_type: H264NaluType = data[offset] & 0x1f;
      const forbidden_bit = (data[offset] & 0x80) >>> 7;

      const next_startcode_offset = this.findNextStartCodeOffset(offset);
      this.current_startcode_offset_ = next_startcode_offset;

      if (nalu_type >= H264NaluType.kReserved0) {
        continue;
      }
      if (forbidden_bit !== 0) {
        // Log.e(this.TAG, `forbidden_bit near offset ${offset} should be 0 but has value ${forbidden_bit}`);
        continue;
      }

      const payload_data = data.subarray(offset, next_startcode_offset);

      nalu_payload = new H264NaluPayload();
      nalu_payload.type = nalu_type;
      nalu_payload.data = payload_data;
    }

    return nalu_payload;
  }
}

export class AVCDecoderConfigurationRecord {
  private data: Uint8Array;

  // sps, pps: require Nalu without 4 byte length-header
  public constructor(sps: Uint8Array, pps: Uint8Array, sps_details: any) {
    let length = 6 + 2 + sps.byteLength + 1 + 2 + pps.byteLength;
    let need_extra_fields = false;

    if (sps[3] !== 66 && sps[3] !== 77 && sps[3] !== 88) {
      need_extra_fields = true;
      length += 4;
    }

    const data = (this.data = new Uint8Array(length));

    data[0] = 0x01; // configurationVersion
    data[1] = sps[1]; // AVCProfileIndication
    data[2] = sps[2]; // profile_compatibility
    data[3] = sps[3]; // AVCLevelIndication
    data[4] = 0xff; // 111111 + lengthSizeMinusOne(3)

    data[5] = 0xe0 | 0x01; // 111 + numOfSequenceParameterSets

    const sps_length = sps.byteLength;
    data[6] = sps_length >>> 8; // sequenceParameterSetLength
    data[7] = sps_length & 0xff;

    let offset = 8;
    data.set(sps, 8);
    offset += sps_length;

    data[offset] = 1; // numOfPictureParameterSets

    const pps_length = pps.byteLength;
    data[offset + 1] = pps_length >>> 8; // pictureParameterSetLength
    data[offset + 2] = pps_length & 0xff;

    data.set(pps, offset + 3);
    offset += 3 + pps_length;

    if (need_extra_fields) {
      data[offset] = 0xfc | sps_details.chroma_format_idc;
      data[offset + 1] = 0xf8 | (sps_details.bit_depth_luma - 8);
      data[offset + 2] = 0xf8 | (sps_details.bit_depth_chroma - 8);
      data[offset + 3] = 0x00; // number of sps ext
      offset += 4;
    }
  }

  public getData() {
    return this.data;
  }
}

export function annexb2avcc(data: Buffer) {
  const annexb_parser = new H264AnnexBParser(data);
  let nalu_payload: H264NaluPayload | null = null;
  const video_init_segment_dispatched_ = false;
  const video_metadata_changed_ = false;

  const video_metadata_: {
    sps: H264NaluAVC1 | undefined;
    pps: H264NaluAVC1 | undefined;
    details: any;
  } = {
    sps: undefined,
    pps: undefined,
    details: undefined,
  };

  while ((nalu_payload = annexb_parser.readNextNaluPayload()) != null) {
    const nalu_avc1 = new H264NaluAVC1(nalu_payload);

    if (nalu_avc1.type === H264NaluType.kSliceSPS) {
      // Notice: parseSPS requires Nalu without startcode or length-header
      const details = SPSParser.parseSPS(nalu_payload.data);
      if (!video_init_segment_dispatched_) {
        video_metadata_.sps = nalu_avc1;
        video_metadata_.details = details;
      }
    } else if (nalu_avc1.type === H264NaluType.kSlicePPS) {
      if (!video_init_segment_dispatched_ || video_metadata_changed_) {
        video_metadata_.pps = nalu_avc1;
      }
    }
  }

  const sps_without_header = video_metadata_.sps!.data.subarray(4);
  const pps_without_header = video_metadata_.pps!.data.subarray(4);
  const details = video_metadata_.details;
  const avcc = new AVCDecoderConfigurationRecord(
    sps_without_header,
    pps_without_header,
    details,
  );
  return avcc.getData();
}
