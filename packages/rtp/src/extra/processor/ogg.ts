import { Event } from "../../imports/common";

import {
  createOpusHead,
  createOpusTags,
  getOpusPacketSamples,
  OggPager,
} from "../container";
import type { WebmInput } from "./webm";

/** Opus always runs at 48 kHz in Ogg (RFC 7845 §4) */
const OpusSamplesPerMs = 48;
/** 20 ms at 48 kHz */
const GapFillSamples = 960;
/**
 * CELT fullband frame sizes (2.5 / 5 / 10 / 20 ms) with their TOC config
 * (RFC 6716 §3.1, configs 28-31), largest first
 */
const GapFillFrames = [
  { samples: 960, config: 31 },
  { samples: 480, config: 30 },
  { samples: 240, config: 29 },
  { samples: 120, config: 28 },
];

export interface OggTrack {
  /** 1 or 2, default 2 */
  channels?: number;
  /**
   * samples (48 kHz) the decoder discards from the start. default 0:
   * recorded RTP carries no encoder priming audio, so a non-zero value would
   * cut real audio
   */
  preSkip?: number;
}

/** compatible with WebmInput, so Depacketize / Lipsync output can be piped */
export type OggInput = WebmInput;

export interface OggOutput {
  saveToFile?: Buffer;
  kind?: "initial" | "page";
  eol?: {
    /**ms */
    duration: number;
  };
}

export interface OggOption {
  /** ms of audio collected into one page before it is written. default 1000 */
  pageDuration?: number;
  /**
   * fill timestamp gaps (DTX, packet loss) of 2.5 ms or more with empty
   * Opus packets so the granule position follows the media time. default true
   */
  fillGaps?: boolean;
  /** bitstream serial number. default random */
  serialNumber?: number;
  /** default "werift" */
  vendor?: string;
}

/**
 * Writes Opus frames into an Ogg Opus stream (RFC 7845).
 * Output is append-only: page 0 holds OpusHead (BOS), page 1 OpusTags,
 * audio pages follow and the last page carries the EOS flag.
 */
export class OggBase {
  private pager: OggPager;
  private preSkip: number;
  private channels: number;
  /** 48 kHz samples written so far, excluding pre-skip */
  private samples = 0;
  /**
   * input time position (48 kHz samples from the first frame) that the
   * written packets reach. Equals `samples` when gaps are filled; without
   * gap filling it keeps counting the skipped gaps, so late and duplicated
   * packets are still detected
   */
  private position = 0;
  private pendingSamples = 0;
  private baseTime?: number;
  private lastToc?: number;
  stopped = false;
  internalStats: Record<string, any> = {};
  onStopped = new Event();

  constructor(
    track: OggTrack,
    private output: (output: OggOutput) => void,
    private options: OggOption = {},
  ) {
    this.channels = track.channels ?? 2;
    this.preSkip = track.preSkip ?? 0;
    this.pager = new OggPager(
      options.serialNumber ?? Math.floor(Math.random() * 0xffffffff),
    );
  }

  toJSON(): Record<string, any> {
    return {
      ...this.internalStats,
      samples: this.samples,
      stopped: this.stopped,
    };
  }

  /** ms of audio written so far */
  get duration() {
    return this.samples / OpusSamplesPerMs;
  }

  protected start() {
    const head = this.pager.addPacket(
      createOpusHead({ channels: this.channels, preSkip: this.preSkip }),
      0n,
    );
    const headPage = this.pager.flush();
    // a long vendor string makes OpusTags span several pages
    const tags = this.pager.addPacket(createOpusTags(this.options.vendor), 0n);
    const tagsPage = this.pager.flush();
    this.output({
      saveToFile: Buffer.concat([...head, ...headPage, ...tags, ...tagsPage]),
      kind: "initial",
    });
  }

  processAudioInput = (input: OggInput) => {
    if (this.stopped) {
      return;
    }
    if (input.frame) {
      this.internalStats["processAudioInput"] = new Date().toISOString();
      this.onFrameReceived(input.frame);
    } else if (input.eol) {
      this.stop();
    }
  };

  private onFrameReceived(frame: NonNullable<OggInput["frame"]>) {
    if (frame.data.length === 0) {
      return;
    }
    if (this.baseTime === undefined) {
      this.baseTime = frame.time;
    }

    const expected = Math.round(
      (frame.time - this.baseTime) * OpusSamplesPerMs,
    );
    const packetSamples = getOpusPacketSamples(frame.data) ?? GapFillSamples;
    if (expected + packetSamples / 2 <= this.position) {
      // late, reordered or duplicated: its span is already written (as audio
      // or as a gap fill), so writing it again would stretch the recording
      this.internalStats["droppedLate"] =
        (this.internalStats["droppedLate"] ?? 0) + 1;
      return;
    }

    if (this.options.fillGaps ?? true) {
      // 1 byte packets (TOC only) are decoded as lost frames (RFC 6716 §3.2.1).
      // The remainder below 20 ms is filled with shorter frames
      const stereo = (this.lastToc ?? 0) & 0x04;
      for (;;) {
        const gap = expected - this.position;
        const fill = GapFillFrames.find((f) => f.samples <= gap);
        if (!fill) {
          break;
        }
        this.writePacket(
          Buffer.from([(fill.config << 3) | stereo]),
          fill.samples,
        );
      }
    } else {
      this.position = Math.max(this.position, expected);
    }

    this.lastToc = frame.data[0];
    this.writePacket(frame.data, packetSamples);
  }

  private writePacket(packet: Buffer, samples: number) {
    this.samples += samples;
    this.position += samples;
    this.pendingSamples += samples;
    const pages = this.pager.addPacket(
      packet,
      BigInt(this.samples + this.preSkip),
    );
    if (
      this.pendingSamples >=
      (this.options.pageDuration ?? 1000) * OpusSamplesPerMs
    ) {
      pages.push(...this.pager.flush());
      this.pendingSamples = 0;
    }
    if (pages.length > 0) {
      this.output({ saveToFile: Buffer.concat(pages), kind: "page" });
    }
  }

  protected stop() {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    const pages = this.pager.flush({ eos: true });
    this.output({ saveToFile: Buffer.concat(pages), kind: "page" });
    this.output({ eol: { duration: this.duration } });
    this.onStopped.execute();
  }
}
