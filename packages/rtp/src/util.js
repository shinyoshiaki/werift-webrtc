Object.defineProperty(exports, "__esModule", { value: true });
exports.RtpBuilder = void 0;
const src_1 = require("../../common/src");
const rtp_1 = require("./rtp/rtp");
const UINT32_MODULO = 4294967296;
class RtpBuilder {
  constructor(props) {
    Object.defineProperty(this, "props", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: props,
    });
    /** Sequence number of the last created packet. */
    Object.defineProperty(this, "sequenceNumber", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /** uint32 timestamp the timeline was last anchored to */
    Object.defineProperty(this, "baseTimestamp", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /** count of legacy `between` advances since the anchor */
    Object.defineProperty(this, "betweenCount", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0,
    });
    /** explicit samples advanced since the anchor (may be fractional) */
    Object.defineProperty(this, "advancedSamples", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(this, "betweenSamples", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    this.sequenceNumber =
      props.initialSequenceNumber !== undefined
        ? (0, src_1.uint16Add)(props.initialSequenceNumber, -1)
        : (0, src_1.random16)();
    this.baseTimestamp = toUint32(
      Math.round(props.initialTimestamp ?? (0, src_1.random32)()),
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
  set timestamp(timestamp) {
    this.baseTimestamp = toUint32(Math.round(timestamp));
    this.betweenCount = 0;
    this.advancedSamples = 0;
  }
  /** Advances the timestamp only; the sequence number is unchanged. */
  advanceSamples(samples) {
    if (!Number.isFinite(samples) || samples < 0) {
      throw new RangeError("samples must be a non-negative finite number");
    }
    this.advancedSamples += samples;
    return this.timestamp;
  }
  create(payload, options = {}) {
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
    this.sequenceNumber = (0, src_1.uint16Add)(this.sequenceNumber, 1);
    const header = new rtp_1.RtpHeader({
      sequenceNumber: this.sequenceNumber,
      timestamp: this.timestamp,
      payloadType: this.props.payloadType ?? 96,
      ssrc: this.props.ssrc ?? 0,
      extension: this.props.extension ?? true,
      marker: options.marker ?? this.props.marker ?? false,
      padding: false,
    });
    const rtp = new rtp_1.RtpPacket(header, payload);
    return rtp;
  }
}
exports.RtpBuilder = RtpBuilder;
function toUint32(value) {
  const mod = value % UINT32_MODULO;
  return mod < 0 ? mod + UINT32_MODULO : mod;
}
//# sourceMappingURL=util.js.map
