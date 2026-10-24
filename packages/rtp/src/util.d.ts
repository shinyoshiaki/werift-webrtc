import type { RtpMediaClock, RtpMediaClockTick } from "./rtp/mediaClock";
import { RtpPacket } from "./rtp/rtp";

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
  /** Use the timestamp of a media clock tick (or `RtpMediaPacer` tick). */
  tick?: Pick<RtpMediaClockTick, "timestamp">;
  marker?: boolean;
}
export declare class RtpBuilder {
  private props;
  /** Sequence number of the last created packet. */
  sequenceNumber: number;
  /** uint32 timestamp the timeline was last anchored to */
  private baseTimestamp;
  /** count of legacy `between` advances since the anchor */
  private betweenCount;
  /** explicit samples advanced since the anchor (may be fractional) */
  private advancedSamples;
  private readonly betweenSamples?;
  constructor(props: RtpBuilderProps);
  /** Current RTP timestamp (uint32). */
  get timestamp(): number;
  set timestamp(timestamp: number);
  /** Advances the timestamp only; the sequence number is unchanged. */
  advanceSamples(samples: number): number;
  create(payload: Buffer, options?: RtpBuilderCreateOptions): RtpPacket;
}
