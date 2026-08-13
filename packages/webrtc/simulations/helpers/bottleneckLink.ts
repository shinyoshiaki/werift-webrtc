/**
 * 仮想ボトルネックリンク。
 * 2 peer の ICE `send` を横取りし、上限帯域・遅延・キュー溢れによるロスを再現する。
 */

export type BottleneckDirection = "a2b" | "b2a";

export type BottleneckOptions = {
  /** 方向ごとの上限帯域 (bps)。0 以下は無制限。 */
  capacityBps: number;
  /** 片道のベース遅延 (ms)。 */
  baseDelayMs: number;
  /** キュー上限 (bytes)。超過分はドロップ。 */
  maxQueueBytes: number;
};

export type BottleneckStats = {
  enqueued: number;
  forwarded: number;
  dropped: number;
  bytesEnqueued: number;
  bytesForwarded: number;
  bytesDropped: number;
  peakQueueBytes: number;
};

type Queued = {
  data: Buffer;
  deliverAtMs: number;
  originalSend: (data: Buffer) => Promise<void>;
};

type DirState = {
  queue: Queued[];
  queueBytes: number;
  tokens: number;
  lastRefillMs: number;
  timer?: ReturnType<typeof setTimeout>;
  stats: BottleneckStats;
};

function emptyStats(): BottleneckStats {
  return {
    enqueued: 0,
    forwarded: 0,
    dropped: 0,
    bytesEnqueued: 0,
    bytesForwarded: 0,
    bytesDropped: 0,
    peakQueueBytes: 0,
  };
}

/**
 * トークンバケツ + 遅延キューによる片方向ボトルネック。
 * ICE 接続完了後に `connection.send` をラップして取り付ける。
 */
export class BottleneckLink {
  private readonly opts: BottleneckOptions;
  private readonly dirs: Record<BottleneckDirection, DirState> = {
    a2b: {
      queue: [],
      queueBytes: 0,
      tokens: 0,
      lastRefillMs: Date.now(),
      stats: emptyStats(),
    },
    b2a: {
      queue: [],
      queueBytes: 0,
      tokens: 0,
      lastRefillMs: Date.now(),
      stats: emptyStats(),
    },
  };
  private closed = false;
  private readonly dropAll: Record<BottleneckDirection, boolean> = {
    a2b: false,
    b2a: false,
  };

  constructor(opts: Partial<BottleneckOptions> = {}) {
    this.opts = {
      capacityBps: opts.capacityBps ?? 250_000,
      baseDelayMs: opts.baseDelayMs ?? 30,
      maxQueueBytes: opts.maxQueueBytes ?? 40_000,
    };
    // 初期バースト: 容量の 50ms 分
    const burst = (this.opts.capacityBps / 8) * 0.05;
    this.dirs.a2b.tokens = burst;
    this.dirs.b2a.tokens = burst;
  }

  get capacityBps() {
    return this.opts.capacityBps;
  }

  /** Change token-bucket capacity at runtime (recovery / step tests). */
  setCapacityBps(bps: number) {
    this.opts.capacityBps = Number.isFinite(bps) ? bps : this.opts.capacityBps;
  }

  /**
   * Drop every packet on a direction (TWCC feedback stall when `b2a` is true).
   */
  setDropAll(direction: BottleneckDirection, drop: boolean) {
    this.dropAll[direction] = drop;
  }

  stats(dir: BottleneckDirection): BottleneckStats {
    return { ...this.dirs[dir].stats };
  }

  totalStats(): BottleneckStats {
    const a = this.dirs.a2b.stats;
    const b = this.dirs.b2a.stats;
    return {
      enqueued: a.enqueued + b.enqueued,
      forwarded: a.forwarded + b.forwarded,
      dropped: a.dropped + b.dropped,
      bytesEnqueued: a.bytesEnqueued + b.bytesEnqueued,
      bytesForwarded: a.bytesForwarded + b.bytesForwarded,
      bytesDropped: a.bytesDropped + b.bytesDropped,
      peakQueueBytes: Math.max(a.peakQueueBytes, b.peakQueueBytes),
    };
  }

  queueBytes(dir: BottleneckDirection) {
    return this.dirs[dir].queueBytes;
  }

  /**
   * ICE 接続の send をボトルネック経由に差し替える。
   * `connection` は `RTCIceTransport.connection`（IceConnection）を想定。
   */
  install(
    connection: { send: (data: Buffer) => Promise<void> },
    direction: BottleneckDirection,
  ) {
    const originalSend = connection.send.bind(connection);
    connection.send = async (data: Buffer) => {
      await this.enqueue(direction, data, originalSend);
    };
  }

  close() {
    this.closed = true;
    for (const dir of Object.values(this.dirs)) {
      if (dir.timer) clearTimeout(dir.timer);
      dir.timer = undefined;
      dir.queue.length = 0;
      dir.queueBytes = 0;
    }
  }

  private async enqueue(
    direction: BottleneckDirection,
    data: Buffer,
    originalSend: (data: Buffer) => Promise<void>,
  ) {
    if (this.closed) return;
    const state = this.dirs[direction];
    const size = data.length;
    state.stats.enqueued++;
    state.stats.bytesEnqueued += size;

    if (this.dropAll[direction]) {
      state.stats.dropped++;
      state.stats.bytesDropped += size;
      return;
    }

    // キュー上限超過 → ロス（輻輳）
    if (state.queueBytes + size > this.opts.maxQueueBytes) {
      state.stats.dropped++;
      state.stats.bytesDropped += size;
      return;
    }

    const now = Date.now();
    state.queue.push({
      data: Buffer.from(data),
      deliverAtMs: now + this.opts.baseDelayMs,
      originalSend,
    });
    state.queueBytes += size;
    if (state.queueBytes > state.stats.peakQueueBytes) {
      state.stats.peakQueueBytes = state.queueBytes;
    }
    this.schedule(direction);
  }

  private refill(state: DirState, nowMs: number) {
    if (this.opts.capacityBps <= 0) {
      state.tokens = Number.POSITIVE_INFINITY;
      state.lastRefillMs = nowMs;
      return;
    }
    const elapsed = Math.max(0, nowMs - state.lastRefillMs) / 1000;
    state.tokens += elapsed * (this.opts.capacityBps / 8);
    // 最大 100ms 分まで蓄積
    const cap = (this.opts.capacityBps / 8) * 0.1;
    if (state.tokens > cap) state.tokens = cap;
    state.lastRefillMs = nowMs;
  }

  private schedule(direction: BottleneckDirection) {
    const state = this.dirs[direction];
    if (state.timer || this.closed) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.pump(direction);
    }, 1);
  }

  private async pump(direction: BottleneckDirection) {
    if (this.closed) return;
    const state = this.dirs[direction];
    const now = Date.now();
    this.refill(state, now);

    while (state.queue.length > 0) {
      const head = state.queue[0];
      if (head.deliverAtMs > now) {
        // ベース遅延待ち
        state.timer = setTimeout(() => {
          state.timer = undefined;
          void this.pump(direction);
        }, head.deliverAtMs - now);
        return;
      }
      if (state.tokens < head.data.length && this.opts.capacityBps > 0) {
        // トークン不足: 必要量分だけ待つ
        const need = head.data.length - state.tokens;
        const waitMs = Math.max(
          1,
          Math.ceil((need * 8 * 1000) / this.opts.capacityBps),
        );
        state.timer = setTimeout(
          () => {
            state.timer = undefined;
            void this.pump(direction);
          },
          Math.min(waitMs, 20),
        );
        return;
      }

      state.queue.shift();
      state.queueBytes -= head.data.length;
      if (this.opts.capacityBps > 0) {
        state.tokens -= head.data.length;
      }
      state.stats.forwarded++;
      state.stats.bytesForwarded += head.data.length;
      try {
        await head.originalSend(head.data);
      } catch {
        // 切断後などは無視
      }
    }
  }
}
