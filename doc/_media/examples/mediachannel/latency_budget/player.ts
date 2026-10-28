// Main-thread half of the custom player: decodes the encoded frames taken out
// by Encoded Transform with WebCodecs, finds holes by RTP sequence number,
// sends application-layer NACKs within the budget and handles generations.
import type { EncodedAudioFrameMessage } from "./encodedFrames";

const SAMPLE_RATE = 48000;
const NACK_INTERVAL_MS = 40;

export type PlayerOptions = {
  /** Buffered before playback starts (jitter absorption). */
  minDelayMs: number;
  /** Latency budget: later frames are concealed / dropped. */
  maxDelayMs: number;
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
  };

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
    if (options.nack) {
      this.nackTimer = setInterval(() => this.sendNacks(), NACK_INTERVAL_MS);
    }
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
  interrupt(generation = this.generation + 1) {
    if (generation <= this.generation) return;
    this.generation = generation;
    this.node.port.postMessage({ type: "flush", generation });
    this.pending.clear();
    this.lastSeq = undefined;
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
    const gen = frame.contributingSources[0] ?? 0;
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

    // Monotonic fake timestamps: late (out-of-order) frames are decoded too.
    const timestamp = this.decodeIndex++ * 20_000;
    this.metas.push({ pos, seq: seq ?? -1, gen });
    this.decoder.decode(
      new EncodedAudioChunk({ type: "key", timestamp, data: frame.data }),
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
    if (seqs.length > 0) {
      this.counters.nackSent += seqs.length;
      this.options.nack?.(seqs);
    }
  }

  get stats(): PlayerStats {
    const worklet = this.worklet ?? ({} as WorkletStats);
    const playWall =
      (worklet.spurtLastFrame - worklet.spurtFirstFrame) / SAMPLE_RATE;
    return {
      ...worklet,
      ...this.counters,
      generation: this.generation,
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
