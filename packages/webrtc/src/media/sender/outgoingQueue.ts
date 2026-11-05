import type { Kind } from "../../types/domain";
import { milliTime } from "../../utils";

/** Per-sender send FIFO caps. Video drops stale frames; audio is looser on count. */
const kOutgoingQueueMaxPacketsVideo = 48;
const kOutgoingQueueMaxPacketsAudio = 250;
const kOutgoingQueueMaxBytesVideo = 512 * 1024;
const kOutgoingQueueMaxBytesAudio = 64 * 1024;
const kOutgoingQueueMaxDurationMsVideo = 500;
const kOutgoingQueueMaxDurationMsAudio = 200;

export type OutgoingKind = "media" | "rtx" | "padding";

export type OutgoingMeta = {
  kind: OutgoingKind;
  bytes: number;
  /** Source epoch of a queued media packet; undefined for padding / RTX. */
  sourceEpoch?: number;
};

type OutgoingQueued = OutgoingMeta & {
  enqueuedAtMs: number;
  start: () => void;
  drop: () => void;
};

/**
 * GCC send FIFO of one {@link RTCRtpSender}: reservation → pacing wait →
 * seq / TSN assignment → DTLS write run one task at a time.
 *
 * Idle calls start the task in the same turn so `Event.execute()` observers
 * see the DTLS write. Concurrent callers wait in order. A dropped task settles
 * with `undefined` instead of running.
 */
export class OutgoingQueue {
  private _running = false;
  private queue: OutgoingQueued[] = [];

  /**
   * @param kind Media kind of the sender (selects the queue caps).
   * @param isBounded Whether the caps apply now. Only a pacing estimator (GCC)
   *   can stall the FIFO; with lightweight / disabled, dropping queued media left
   *   over from a previous pacing estimator would corrupt frames without any
   *   congestion signal.
   */
  constructor(
    private readonly kind: Kind,
    private readonly isBounded: () => boolean,
  ) {}

  /** True while a task runs (queued tasks keep it true until drained). */
  get running() {
    return this._running;
  }

  enqueue<T>(
    task: () => Promise<T>,
    meta: OutgoingMeta,
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false;
      const settleOk = (value: T | undefined) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const settleErr = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const start = () => {
        const done = Promise.resolve(task());
        done.then(settleOk, settleErr).finally(() => {
          const next = this.queue.shift();
          if (next) {
            next.start();
            return;
          }
          this._running = false;
        });
      };
      const item: OutgoingQueued = {
        kind: meta.kind,
        bytes: meta.bytes,
        enqueuedAtMs: milliTime(),
        start,
        drop: () => settleOk(undefined),
        sourceEpoch: meta.sourceEpoch,
      };
      if (this._running) {
        this.queue.push(item);
        this.trim();
        return;
      }
      this._running = true;
      start();
    });
  }

  /** Drop queued media accepted under a source epoch other than `sourceEpoch`. */
  dropStaleSource(sourceEpoch: number) {
    const stale = this.queue.filter(
      (queued) =>
        queued.sourceEpoch !== undefined && queued.sourceEpoch !== sourceEpoch,
    );
    this.queue = this.queue.filter((queued) => !stale.includes(queued));
    for (const queued of stale) {
      queued.drop();
    }
  }

  /** Media or RTX is waiting (padding yields to it). */
  hasQueuedRealtimeMedia(): boolean {
    return this.queue.some(
      (queued) => queued.kind === "media" || queued.kind === "rtx",
    );
  }

  private limits() {
    if (this.kind === "audio") {
      return {
        maxPackets: kOutgoingQueueMaxPacketsAudio,
        maxBytes: kOutgoingQueueMaxBytesAudio,
        maxDurationMs: kOutgoingQueueMaxDurationMsAudio,
      };
    }
    return {
      maxPackets: kOutgoingQueueMaxPacketsVideo,
      maxBytes: kOutgoingQueueMaxBytesVideo,
      maxDurationMs: kOutgoingQueueMaxDurationMsVideo,
    };
  }

  /** Over a cap: drop queued padding first, then the oldest packet. */
  private trim() {
    if (!this.isBounded()) {
      return;
    }
    const { maxPackets, maxBytes, maxDurationMs } = this.limits();
    const now = milliTime();
    const queueBytes = () =>
      this.queue.reduce((sum, queued) => sum + queued.bytes, 0);
    const overLimit = () => {
      if (this.queue.length === 0) return false;
      const oldest = this.queue[0];
      const stale = now - oldest.enqueuedAtMs > maxDurationMs;
      return stale || this.queue.length > maxPackets || queueBytes() > maxBytes;
    };
    while (overLimit()) {
      const paddingIdx = this.queue.findIndex(
        (queued) => queued.kind === "padding",
      );
      const idx = paddingIdx >= 0 ? paddingIdx : 0;
      const [dropped] = this.queue.splice(idx, 1);
      dropped.drop();
    }
  }
}
