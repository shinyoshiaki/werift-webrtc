// Main-thread half of the custom player: decodes the encoded frames taken out
// by Encoded Transform with WebCodecs, finds holes by RTP sequence number,
// sends application-layer NACKs within the budget and handles generations.
import { DecodeOrder } from "./decodeOrder";
import type { EncodedAudioFrameMessage } from "./encodedFrames";

const SAMPLE_RATE = 48000;
const NACK_INTERVAL_MS = 40;
const MAX_UNRESOLVED_FRAMES = 500;

export type PlayerOptions = {
  /** Buffered before playback starts (jitter absorption). */
  minDelayMs: number;
  /** Latency budget: later frames are concealed / dropped. */
  maxDelayMs: number;
  /** Ignore the CSRC (as when the browser gives no contributingSources) */
  ignoreCsrc?: boolean;
  /** Send an application-layer NACK (DataChannel); omit to disable. */
  nack?: (seqs: number[]) => void;
};

export type WorkletStats = {
  playedFrames: number;
  concealedFrames: number;
  lateDiscardedFrames: number;
  recoveredFrames: number;
  skippedSilentFrames: number;
  flushedFrames: number;
  oldGenerationPlayed: number;
  stalledMs: number;
  delayMs: number;
  startDelayMs: number;
  maxDelayMs: number;
  spurts: number;
  spurtPlayedSamples: number;
  spurtFirstFrame: number;
  spurtLastFrame: number;
};

export type PlayerStats = WorkletStats & {
  receivedFrames: number;
  missingFrames: number;
  nackSent: number;
  nackGaveUp: number;
  staleGenerationFrames: number;
  decodedFrames: number;
  unmatchedOutputs: number;
  /** frames that arrived after their hole was given up (not decoded) */
  lateDroppedFrames: number;
  /** frames decoded behind an already decoded seq: must stay 0 */
  outOfOrderDecodedFrames: number;
  /** frames waiting for an earlier hole to be recovered */
  heldFrames: number;
  generation: number;
  /** wall-clock span over which the frames of the current spurt arrived */
  arrivalSpanMs: number;
  /** media duration of the frames that arrived in the current spurt */
  arrivalMediaMs: number;
  /** media played / wall time of the current spurt (1.0 = real time) */
  playbackRate: number;
};

type FrameMeta = { pos: number; seq: number; gen: number };
type Pending = { pos: number; deadline: number };
type DecodeItem = { meta: FrameMeta; data: ArrayBuffer };

export class BudgetPlayer {
  readonly node: AudioWorkletNode;
  private readonly output: GainNode;
  private decoder!: AudioDecoder;
  private decodeIndex = 0;
  /** AudioDecoder emits one output per Opus frame, in decode order. */
  private readonly metas: FrameMeta[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly nackTimer?: ReturnType<typeof setInterval>;
  private generation = 0;
  private firstTimestamp?: number;
  private awaitingStart = false;
  /** frames received between a local interrupt and its control message */
  private readonly unresolved: EncodedAudioFrameMessage[] = [];
  private lastSeq?: number;
  private lastPos = 0;
  private refTimestamp?: number;
  private refPos = 0;
  private anchorWall = 0;
  private anchorPos = 0;
  private spurtStart = 0;
  private spurtFirstPos = 0;
  private spurtLastArrival = 0;
  private spurtLastPos = 0;
  private worklet?: WorkletStats;
  private counters = {
    receivedFrames: 0,
    missingFrames: 0,
    nackSent: 0,
    nackGaveUp: 0,
    staleGenerationFrames: 0,
    decodedFrames: 0,
    unmatchedOutputs: 0,
    lateDroppedFrames: 0,
    outOfOrderDecodedFrames: 0,
  };
  private lastDecodedSeq?: number;
  /** Decode in sequence order; wait for a hole while its deadline is ahead. */
  private readonly order = new DecodeOrder<DecodeItem>((seq) => {
    const hole = this.pending.get(seq);
    return hole !== undefined && performance.now() <= hole.deadline;
  });

  constructor(
    private readonly context: AudioContext,
    private readonly options: PlayerOptions,
  ) {
    this.node = new AudioWorkletNode(context, "budget-player", {
      outputChannelCount: [1],
      processorOptions: {
        minDelayMs: options.minDelayMs,
        maxDelayMs: options.maxDelayMs,
      },
    });
    this.node.port.onmessage = ({ data }) => {
      if (data.type === "stats") this.worklet = data.stats;
    };
    this.output = context.createGain();
    this.node.connect(this.output).connect(context.destination);
    this.createDecoder();
    // Also ends the wait for a hole when there is no NACK to send.
    this.nackTimer = setInterval(() => this.sendNacks(), NACK_INTERVAL_MS);
  }

  static async load(context: AudioContext) {
    await context.audioWorklet.addModule(
      new URL("./player-worklet.js", import.meta.url),
    );
  }

  set muted(muted: boolean) {
    this.output.gain.value = muted ? 0 : 1;
  }

  setDelay(minDelayMs: number, maxDelayMs: number) {
    this.options.minDelayMs = minDelayMs;
    this.options.maxDelayMs = maxDelayMs;
    this.node.port.postMessage({ type: "config", minDelayMs, maxDelayMs });
  }

  private createDecoder() {
    this.decoder = new AudioDecoder({
      output: (data) => this.onDecoded(data),
      error: (error) => {
        console.warn("AudioDecoder error, recreating", error);
        this.metas.length = 0;
        this.createDecoder();
      },
    });
    this.decoder.configure({
      codec: "opus",
      sampleRate: SAMPLE_RATE,
      numberOfChannels: 2,
    });
  }

  /**
   * Barge-in: drop everything buffered or still decoding right now and ignore
   * older generations. Called on the user's action or on the control message,
   * so it does not wait for the first RTP packet of the new generation.
   */
  interrupt(generation?: number, firstTimestamp?: number) {
    const local = generation === undefined;
    const next = generation ?? this.generation + 1;
    if (this.awaitingStart && firstTimestamp !== undefined) {
      // The control message of an interrupt already flushed locally: adopt the
      // server's generation and decide the frames that waited for it.
      this.awaitingStart = false;
      this.generation = Math.max(this.generation, next);
      this.firstTimestamp = firstTimestamp;
      for (const frame of this.unresolved.splice(0)) this.push(frame);
      return;
    }
    if (next <= this.generation) return;
    this.generation = next;
    this.node.port.postMessage({ type: "flush", generation: next });
    this.pending.clear();
    this.order.clear();
    this.lastSeq = undefined;
    this.unresolved.length = 0;
    this.firstTimestamp = firstTimestamp;
    // Without CSRC the new generation is only known from the control message.
    this.awaitingStart = local && firstTimestamp === undefined;
  }

  /**
   * Generation of a frame: the CSRC when there is one, otherwise decided by
   * the first RTP timestamp announced with the interrupt. `undefined` while
   * that is still on its way.
   */
  private generationOf(frame: EncodedAudioFrameMessage) {
    const csrc = this.options.ignoreCsrc ? [] : frame.contributingSources;
    if (csrc.length > 0) return csrc[0];
    if (this.awaitingStart) return undefined;
    if (
      this.firstTimestamp !== undefined &&
      ((frame.rtpTimestamp - this.firstTimestamp) | 0) < 0
    ) {
      return this.generation - 1;
    }
    return this.generation;
  }

  /** RTP timestamp -> media position in samples (32bit unwrap). */
  private unwrap(timestamp: number) {
    if (this.refTimestamp === undefined) {
      this.refTimestamp = timestamp;
      return this.refPos;
    }
    const pos = this.refPos + ((timestamp - this.refTimestamp) | 0);
    if (pos > this.refPos) {
      this.refTimestamp = timestamp;
      this.refPos = pos;
    }
    return pos;
  }

  push(frame: EncodedAudioFrameMessage) {
    const gen = this.generationOf(frame);
    if (gen === undefined) {
      if (this.unresolved.length < MAX_UNRESOLVED_FRAMES) {
        this.unresolved.push(frame);
      }
      return;
    }
    if (gen < this.generation) {
      this.counters.staleGenerationFrames++;
      return;
    }
    if (gen > this.generation) {
      // In-band generation bump (CSRC): flush everything already buffered.
      this.interrupt(gen);
    }

    const now = performance.now();
    const pos = this.unwrap(frame.rtpTimestamp);
    const seq = frame.sequenceNumber;
    this.counters.receivedFrames++;

    // A jump in RTP time with contiguous seq is a new talk spurt; a jump with
    // missing seqs is loss and keeps the anchor the deadlines are based on.
    const newSpurt =
      this.lastSeq === undefined ||
      (seq !== undefined &&
        ((seq - this.lastSeq) & 0xffff) === 1 &&
        pos - this.lastPos > SAMPLE_RATE / 5);
    if (newSpurt) {
      // the wall clock anchor of the budget
      this.anchorWall = now;
      this.anchorPos = pos;
      this.spurtStart = now;
      this.spurtFirstPos = pos;
      this.spurtLastPos = pos;
    }
    this.spurtLastArrival = now;
    this.spurtLastPos = Math.max(this.spurtLastPos, pos);

    if (seq !== undefined) {
      if (this.lastSeq === undefined) {
        this.lastSeq = seq;
        this.lastPos = pos;
      } else {
        const diff = (seq - this.lastSeq) & 0xffff;
        if (diff === 0) return;
        if (diff < 0x8000) {
          for (let k = 1; k < diff; k++) {
            // A hole: tell the worklet to wait for it, and NACK it.
            const missingSeq = (this.lastSeq + k) & 0xffff;
            const missingPos = this.lastPos + ((pos - this.lastPos) * k) / diff;
            const len = (pos - this.lastPos) / diff;
            this.counters.missingFrames++;
            this.node.port.postMessage({
              type: "missing",
              chunk: { pos: missingPos, len, seq: missingSeq, gen },
            });
            const expectedAt =
              this.anchorWall +
              ((missingPos - this.anchorPos) * 1000) / SAMPLE_RATE;
            this.pending.set(missingSeq, {
              pos: missingPos,
              deadline: expectedAt + this.options.maxDelayMs,
            });
          }
          this.lastSeq = seq;
          this.lastPos = pos;
        } else {
          this.pending.delete(seq);
        }
      }
    }

    const item = { meta: { pos, seq: seq ?? -1, gen }, data: frame.data };
    if (seq === undefined) {
      this.decode(item);
      return;
    }
    const { ready, late } = this.order.push(seq, item);
    if (late) this.counters.lateDroppedFrames++;
    for (const next of ready) this.decode(next);
  }

  private decode({ meta, data }: DecodeItem) {
    if (
      meta.seq >= 0 &&
      this.lastDecodedSeq !== undefined &&
      ((meta.seq - this.lastDecodedSeq) & 0xffff) >= 0x8000
    ) {
      this.counters.outOfOrderDecodedFrames++;
    }
    if (meta.seq >= 0) this.lastDecodedSeq = meta.seq;
    // Monotonic fake timestamps: the decoder re-derives its own anyway.
    const timestamp = this.decodeIndex++ * 20_000;
    this.metas.push(meta);
    this.decoder.decode(
      new EncodedAudioChunk({ type: "key", timestamp, data }),
    );
  }

  private onDecoded(data: AudioData) {
    // Output timestamps are re-derived by the decoder, so match by order.
    const meta = this.metas.shift();
    this.counters.decodedFrames++;
    if (!meta) this.counters.unmatchedOutputs++;
    if (!meta || meta.gen < this.generation) {
      data.close();
      return;
    }
    const samples = new Float32Array(data.numberOfFrames);
    data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
    data.close();
    let sum = 0;
    for (const v of samples) sum += v * v;
    this.node.port.postMessage(
      {
        type: "chunk",
        chunk: {
          pos: meta.pos,
          len: samples.length,
          samples,
          seq: meta.seq,
          gen: meta.gen,
          rms: Math.sqrt(sum / samples.length),
        },
      },
      [samples.buffer],
    );
  }

  private sendNacks() {
    const now = performance.now();
    const seqs: number[] = [];
    for (const [seq, { deadline }] of this.pending) {
      if (now > deadline) {
        // Past this subscriber's budget: stop asking.
        this.pending.delete(seq);
        this.counters.nackGaveUp++;
      } else {
        seqs.push(seq);
      }
    }
    if (seqs.length > 0 && this.options.nack) {
      this.counters.nackSent += seqs.length;
      this.options.nack(seqs);
    }
    // Holes given up above no longer hold back the frames behind them.
    for (const item of this.order.release()) this.decode(item);
  }

  get stats(): PlayerStats {
    const worklet = this.worklet ?? ({} as WorkletStats);
    const playWall =
      (worklet.spurtLastFrame - worklet.spurtFirstFrame) / SAMPLE_RATE;
    return {
      ...worklet,
      ...this.counters,
      generation: this.generation,
      heldFrames: this.order.heldFrames,
      arrivalSpanMs: this.spurtLastArrival - this.spurtStart,
      arrivalMediaMs:
        ((this.spurtLastPos - this.spurtFirstPos) * 1000) / SAMPLE_RATE + 20,
      playbackRate:
        playWall > 0 ? worklet.spurtPlayedSamples / SAMPLE_RATE / playWall : 0,
    };
  }

  close() {
    clearInterval(this.nackTimer);
    this.node.disconnect();
    this.output.disconnect();
    if (this.decoder.state !== "closed") this.decoder.close();
  }
}
