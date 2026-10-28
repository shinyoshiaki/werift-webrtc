// AudioWorklet half of the custom player: a playout buffer keyed by the RTP
// timestamp, which takes over the parts of NetEQ the example bypasses.
//
// - Frames are placed at their media position, not at their arrival time.
// - A missing frame (placeholder) stalls playback while the delay is within
//   maxDelay, waiting for a retransmission; past maxDelay it is concealed.
// - Anything whose time is more than maxDelay ago is skipped (budget).
// - The delay shrinks back toward minDelay by skipping silent frames (a very
//   small "time-stretch" that also absorbs clock drift).

const FADE = 48;
const SILENCE_RMS = 0.01;
const RESPURT_GAP = 0.2; // seconds of RTP gap treated as a new talk spurt

class BudgetPlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { minDelayMs, maxDelayMs } = options.processorOptions;
    this.setDelay(minDelayMs, maxDelayMs);
    this.chunks = []; // sorted by pos: { pos, len, samples?, seq, gen, rms }
    this.state = "idle";
    this.pos = 0;
    this.anchorFrame = 0;
    this.anchorPos = 0;
    this.lastGap = true;
    this.flushGeneration = 0;
    this.stats = {
      playedFrames: 0,
      concealedFrames: 0,
      lateDiscardedFrames: 0,
      recoveredFrames: 0,
      skippedSilentFrames: 0,
      flushedFrames: 0,
      oldGenerationPlayed: 0,
      stalledMs: 0,
      delayMs: 0,
      // delay when playback first started: where minDelay shows up
      startDelayMs: 0,
      maxDelayMs: 0,
      spurts: 0,
      spurtPlayedSamples: 0,
      spurtFirstFrame: 0,
      spurtLastFrame: 0,
    };
    this.port.onmessage = (event) => this.onMessage(event.data);
    this.lastReport = 0;
  }

  setDelay(minDelayMs, maxDelayMs) {
    this.minDelay = (minDelayMs * sampleRate) / 1000;
    this.maxDelay = (maxDelayMs * sampleRate) / 1000;
  }

  nowMedia() {
    return currentFrame - this.anchorFrame + this.anchorPos;
  }

  delay() {
    return this.nowMedia() - this.pos;
  }

  insert(chunk) {
    let i = this.chunks.length;
    while (i > 0 && this.chunks[i - 1].pos > chunk.pos) i--;
    const prev = this.chunks[i - 1];
    if (prev && prev.pos === chunk.pos) {
      if (!prev.samples && chunk.samples) {
        // A retransmission filled the hole in time.
        this.chunks[i - 1] = chunk;
        this.stats.recoveredFrames++;
      }
      return;
    }
    this.chunks.splice(i, 0, chunk);
  }

  onMessage(message) {
    switch (message.type) {
      case "chunk":
      case "missing": {
        const chunk = message.chunk;
        if (this.state !== "idle" && chunk.pos + chunk.len <= this.pos) {
          if (message.type === "chunk") this.stats.lateDiscardedFrames++;
          return;
        }
        if (chunk.gen < this.flushGeneration) return;
        this.insert(chunk);
        break;
      }
      case "flush":
        // A new generation (barge-in): drop everything buffered right away.
        this.stats.flushedFrames += this.chunks.filter((c) => c.samples).length;
        this.chunks = [];
        this.flushGeneration = message.generation;
        this.state = "idle";
        break;
      case "config":
        this.setDelay(message.minDelayMs, message.maxDelayMs);
        break;
    }
  }

  anchor(pos) {
    this.state = "buffering";
    this.anchorFrame = currentFrame;
    this.anchorPos = pos;
    this.pos = pos;
    this.lastGap = true;
    this.stats.spurts++;
    this.stats.spurtPlayedSamples = 0;
    this.stats.spurtFirstFrame = 0;
    this.stats.spurtLastFrame = 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const n = out.length;
    out.fill(0);

    if (this.state === "idle" && this.chunks.length > 0) {
      this.anchor(this.chunks[0].pos);
    }
    if (this.state === "buffering" && this.delay() >= this.minDelay) {
      this.state = "playing";
      if (this.stats.startDelayMs === 0) {
        this.stats.startDelayMs = (this.delay() * 1000) / sampleRate;
      }
    }
    if (this.state === "playing") {
      this.render(out, n);
    }
    for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(out);

    if (currentFrame - this.lastReport >= sampleRate / 10) {
      this.lastReport = currentFrame;
      this.port.postMessage({ type: "stats", stats: this.stats });
    }
    return true;
  }

  render(out, n) {
    let i = 0;
    while (i < n) {
      const delay = this.delay() + i;
      while (
        this.chunks.length &&
        this.chunks[0].pos + this.chunks[0].len <= this.pos
      ) {
        this.chunks.shift();
      }
      const c = this.chunks[0];
      if (!c) {
        // Underrun: nothing to play yet, wait (the delay grows).
        this.stats.stalledMs += ((n - i) * 1000) / sampleRate;
        this.lastGap = true;
        break;
      }
      if (c.pos > this.pos) {
        const gap = c.pos - this.pos;
        if (gap > RESPURT_GAP * sampleRate) {
          this.anchor(c.pos);
          break;
        }
        if (delay > this.maxDelay) {
          this.pos = c.pos;
          continue;
        }
        const k = Math.min(n - i, gap);
        this.pos += k;
        i += k;
        this.lastGap = true;
        continue;
      }
      if (delay > this.maxDelay) {
        // Past the budget: conceal holes, drop frames that are too old.
        if (c.samples) this.stats.lateDiscardedFrames++;
        else this.stats.concealedFrames++;
        this.pos = c.pos + c.len;
        this.chunks.shift();
        this.lastGap = true;
        continue;
      }
      if (!c.samples) {
        // Hole within the budget: stall and wait for the retransmission.
        this.stats.stalledMs += ((n - i) * 1000) / sampleRate;
        this.lastGap = true;
        break;
      }
      if (
        this.pos === c.pos &&
        delay - this.minDelay > 2 * c.len &&
        c.rms < SILENCE_RMS
      ) {
        // Catch up toward minDelay through silence.
        this.stats.skippedSilentFrames++;
        this.pos = c.pos + c.len;
        this.chunks.shift();
        continue;
      }
      const offset = this.pos - c.pos;
      const k = Math.min(n - i, c.len - offset);
      for (let j = 0; j < k; j++) {
        let v = c.samples[offset + j];
        if (this.lastGap && offset + j < FADE) v *= (offset + j) / FADE;
        out[i + j] = v;
      }
      if (c.gen < this.flushGeneration) this.stats.oldGenerationPlayed++;
      if (!this.stats.spurtFirstFrame)
        this.stats.spurtFirstFrame = currentFrame + i;
      this.stats.spurtLastFrame = currentFrame + i + k;
      this.stats.spurtPlayedSamples += k;
      this.lastGap = false;
      this.pos += k;
      i += k;
      if (this.pos >= c.pos + c.len) {
        this.chunks.shift();
        this.stats.playedFrames++;
      }
      this.stats.delayMs = (delay * 1000) / sampleRate;
      this.stats.maxDelayMs = Math.max(
        this.stats.maxDelayMs,
        this.stats.delayMs,
      );
    }
  }
}

registerProcessor("budget-player", BudgetPlayerProcessor);
