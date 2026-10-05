import { random16, random32, uint16Add } from "../../common/src";
import type { RtpMediaClock, RtpMediaClockTick } from "./rtp/mediaClock";
import { RtpHeader, RtpPacket } from "./rtp/rtp";

const UINT32_MODULO = 0x1_0000_0000;

interface RtpBuilderCommonProps {
  /** Default: 96 */
  payloadType?: number;
  /** Default: 0 */
  ssrc?: number;
  /** Default marker bit. Default: false */
  marker?: boolean;
  /** Default: true */
  extension?: boolean;
  /** Sequence number of the first created packet. Default: random */
  initialSequenceNumber?: number;
  /** Timeline origin before the first advance. Default: random */
  initialTimestamp?: number;
}

/**
 * - `{ between, clockRate }`: legacy fixed pacing. Each `create()` advances the
 *   timestamp by `between * clockRate / 1000` (before the first packet too).
 * - `{ clock }`: `create()` uses the timestamp of the clock's latest tick.
 * - `{}`: explicit timeline via `advanceSamples()` / `create()` options.
 */
export type RtpBuilderProps =
  | (RtpBuilderCommonProps & {
      between: number;
      clockRate: number;
      clock?: undefined;
    })
  | (RtpBuilderCommonProps & {
      clock: RtpMediaClock;
      between?: undefined;
      clockRate?: number;
    })
  | (RtpBuilderCommonProps & {
      between?: undefined;
      clock?: undefined;
      clockRate?: number;
    });

export interface RtpBuilderCreateOptions {
  /** Samples to advance for this packet. `0` keeps the current timestamp. */
  elapsedSamples?: number;
  /** Absolute RTP timestamp (application-owned timeline, e.g. relay). */
  timestamp?: number;
  /** Use the timestamp of a media clock tick. */
  tick?: RtpMediaClockTick;
  marker?: boolean;
}

export class RtpBuilder {
  /** Sequence number of the last created packet. */
  sequenceNumber: number;

  /** uint32 timestamp the timeline was last anchored to */
  private baseTimestamp: number;
  /** count of legacy `between` advances since the anchor */
  private betweenCount = 0;
  /** explicit samples advanced since the anchor (may be fractional) */
  private advancedSamples = 0;
  private readonly betweenSamples?: number;

  constructor(private props: RtpBuilderProps) {
    this.sequenceNumber =
      props.initialSequenceNumber !== undefined
        ? uint16Add(props.initialSequenceNumber, -1)
        : random16();
    this.baseTimestamp = toUint32(
      Math.round(props.initialTimestamp ?? random32()),
    );
    if (props.between !== undefined) {
      this.betweenSamples = (props.between * props.clockRate) / 1000;
      if (!Number.isFinite(this.betweenSamples) || this.betweenSamples < 0) {
        throw new RangeError("between * clockRate must be a finite number");
      }
    }
  }

  /** Current RTP timestamp (uint32). */
  get timestamp() {
    const samples =
      this.betweenCount * (this.betweenSamples ?? 0) + this.advancedSamples;
    return toUint32(this.baseTimestamp + Math.round(samples));
  }

  set timestamp(timestamp: number) {
    this.baseTimestamp = toUint32(Math.round(timestamp));
    this.betweenCount = 0;
    this.advancedSamples = 0;
  }

  /** Advances the timestamp only; the sequence number is unchanged. */
  advanceSamples(samples: number) {
    if (!Number.isFinite(samples) || samples < 0) {
      throw new RangeError("samples must be a non-negative finite number");
    }
    this.advancedSamples += samples;
    return this.timestamp;
  }

  create(payload: Buffer, options: RtpBuilderCreateOptions = {}) {
    const timelineOptions = [
      options.elapsedSamples,
      options.timestamp,
      options.tick,
    ].filter((v) => v !== undefined);
    if (timelineOptions.length > 1) {
      throw new TypeError(
        "elapsedSamples, timestamp and tick are mutually exclusive",
      );
    }

    if (options.tick) {
      this.timestamp = options.tick.timestamp;
    } else if (options.timestamp !== undefined) {
      this.timestamp = options.timestamp;
    } else if (options.elapsedSamples !== undefined) {
      this.advanceSamples(options.elapsedSamples);
    } else if (this.props.clock) {
      this.timestamp = this.props.clock.timestamp;
    } else if (this.betweenSamples !== undefined) {
      this.betweenCount++;
    }

    this.sequenceNumber = uint16Add(this.sequenceNumber, 1);

    const header = new RtpHeader({
      sequenceNumber: this.sequenceNumber,
      timestamp: this.timestamp,
      payloadType: this.props.payloadType ?? 96,
      ssrc: this.props.ssrc ?? 0,
      extension: this.props.extension ?? true,
      marker: options.marker ?? this.props.marker ?? false,
      padding: false,
    });
    const rtp = new RtpPacket(header, payload);
    return rtp;
  }
}

function toUint32(value: number) {
  const mod = value % UINT32_MODULO;
  return mod < 0 ? mod + UINT32_MODULO : mod;
}
