import Event from "rx.mini";
import { TransformStream, TransformStreamDefaultController } from "stream/web";

import { Chunk } from "./chunk";
import * as MP4 from "./mp4";

type DecoderConfig = AudioDecoderConfig | VideoDecoderConfig;
type EncodedChunk = EncodedAudioChunk | EncodedVideoChunk;

export class Container {
  #mp4: MP4.ISOFile;
  #frame?: EncodedAudioChunk | EncodedVideoChunk; // 1 frame buffer
  track?: number;
  #segment = 0;
  onData = new Event<any>();

  constructor() {
    this.#mp4 = new MP4.ISOFile();
    this.#mp4.init();
  }

  write(frame: DecoderConfig | EncodedChunk) {
    if (isDecoderConfig(frame)) {
      return this.#init(frame);
    } else {
      return this.#enqueue(frame);
    }
  }

  #init(frame: DecoderConfig) {
    if (this.track) {
      throw new Error("duplicate decoder config");
    }

    let codec = frame.codec.substring(0, 4);
    if (codec == "opus") {
      codec = "Opus";
    }

    const options: MP4.TrackOptions = {
      type: codec,
      timescale: 1_000_000,
    };

    if (isVideoConfig(frame)) {
      options.width = frame.codedWidth;
      options.height = frame.codedHeight;
    } else {
      options.channel_count = frame.numberOfChannels;
      options.samplerate = frame.sampleRate;
    }

    if (!frame.description) throw new Error("missing frame description");
    const desc = frame.description as ArrayBufferLike;

    if (codec === "avc1") {
      options.avcDecoderConfigRecord = desc;
    } else if (codec === "hev1") {
      options.hevcDecoderConfigRecord = desc;
    } else if (codec === "Opus") {
      // description is an identification header: https://datatracker.ietf.org/doc/html/rfc7845#section-5.1
      // The first 8 bytes are the magic string "OpusHead", followed by what we actually want.
      const dops = new MP4.BoxParser.dOpsBox(undefined);

      // Annoyingly, the header is little endian while MP4 is big endian, so we have to parse.
      const data = new MP4.Stream(desc, 8, MP4.Stream.LITTLE_ENDIAN);
      dops.parse(data);

      options.description = dops;
    } else {
      throw new Error(`unsupported codec: ${codec}`);
    }

    try {
      this.track = this.#mp4.addTrack(options);
    } catch (error) {
      options;
      throw error;
    }
    if (!this.track) throw new Error("failed to initialize MP4 track");

    const buffer = MP4.ISOFile.writeInitializationSegment(
      this.#mp4.ftyp!,
      this.#mp4.moov!,
      0,
      0
    );
    const data = new Uint8Array(buffer);

    const res = {
      type: "init",
      timestamp: 0,
      duration: 0,
      data,
    };
    this.onData.execute(res);
    return res;
  }

  #enqueue(frame: EncodedChunk) {
    // Check if we should create a new segment
    if (frame.type == "key") {
      this.#segment += 1;
    } else if (this.#segment == 0) {
      throw new Error("must start with keyframe");
    }

    // We need a one frame buffer to compute the duration
    if (!this.#frame) {
      this.#frame = frame;
      return;
    }

    const duration = frame.timestamp - this.#frame.timestamp;

    // TODO avoid this extra copy by writing to the mdat directly
    // ...which means changing mp4box.js to take an offset instead of ArrayBuffer
    const buffer = new Uint8Array(this.#frame.byteLength);
    this.#frame.copyTo(buffer);

    if (!this.track) throw new Error("missing decoder config");

    // Add the sample to the container
    this.#mp4.addSample(this.track, buffer, {
      duration,
      dts: this.#frame.timestamp,
      cts: this.#frame.timestamp,
      is_sync: this.#frame.type == "key",
    });

    const stream = new MP4.Stream(undefined, 0, MP4.Stream.BIG_ENDIAN);

    // Moof and mdat atoms are written in pairs.
    // TODO remove the moof/mdat from the Box to reclaim memory once everything works
    for (;;) {
      const moof = this.#mp4.moofs.shift();
      const mdat = this.#mp4.mdats.shift();

      if (!moof && !mdat) break;
      if (!moof) throw new Error("moof missing");
      if (!mdat) throw new Error("mdat missing");

      moof.write(stream);
      mdat.write(stream);
    }

    // TODO avoid this extra copy by writing to the buffer provided in copyTo
    const data = new Uint8Array(stream.buffer);
    this.#frame = frame;

    const res = {
      type: this.#frame.type,
      timestamp: this.#frame.timestamp,
      duration: this.#frame.duration ?? 0,
      data,
    };
    this.onData.execute(res);
    return res;
  }

  /* TODO flush the last frame
	#flush(controller: TransformStreamDefaultController<Chunk>) {
		if (this.#frame) {
			// TODO guess the duration
			this.#enqueue(this.#frame, 0, controller)
		}
	}
	*/
}

function isDecoderConfig(
  frame: DecoderConfig | EncodedChunk
): frame is DecoderConfig {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return (frame as DecoderConfig).codec !== undefined;
}

function isVideoConfig(frame: DecoderConfig): frame is VideoDecoderConfig {
  return (frame as VideoDecoderConfig).codedWidth !== undefined;
}

export interface AudioDecoderConfig {
  codec: string;
  description?: ArrayBuffer | undefined;
  numberOfChannels: number;
  sampleRate: number;
}

export interface VideoDecoderConfig {
  codec: string;
  codedHeight?: number | undefined;
  codedWidth?: number | undefined;
  description?: ArrayBuffer | undefined;
  displayAspectHeight?: number | undefined;
  displayAspectWidth?: number | undefined;
  optimizeForLatency?: boolean | undefined;
}

interface EncodedAudioChunk {
  readonly byteLength: number;
  readonly duration: number | null;
  readonly timestamp: number;
  readonly type: EncodedAudioChunkType;
  copyTo(destination: ArrayBuffer): void;
}

type EncodedAudioChunkType = "delta" | "key";

interface EncodedVideoChunk {
  readonly byteLength: number;
  readonly duration: number | null;
  readonly timestamp: number;
  readonly type: EncodedVideoChunkType;
  copyTo(destination: ArrayBuffer): void;
}

type EncodedVideoChunkType = "delta" | "key";
