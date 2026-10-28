// Sender side Encoded Transform: the frames that pass this gate are exactly
// the RTP packets the browser sends (one Opus frame = one packet). The sender
// metadata has no sequence number, but its rtpTimestamp is the one on the
// wire, so the gate reports the true send range by RTP timestamp:
//   start: the first frame's timestamp, as soon as it passes (head losses can
//          be NACKed within the budget, not only at the end)
//   range: first / last timestamp and frame count, when the gate is closed.
// Frames after the close are dropped here, so they never get a sequence number.

export type SendGateMessage =
  | { type: "start"; firstRtpTimestamp: number }
  | {
      type: "range";
      firstRtpTimestamp?: number;
      lastRtpTimestamp?: number;
      frames: number;
    };

export type SendGateOptions = {
  /**
   * Test hook: keep the newest N frames back. On close they are sent
   * `releaseHeldAfterMs` later, so they reach the receiver after the range
   * (the "stop") does, as if delayed in the network.
   */
  holdFrames?: number;
};

export class SendGate {
  private first?: number;
  private last?: number;
  private frames = 0;
  private closed = false;
  private readonly held: any[] = [];
  private controller?: TransformStreamDefaultController<any>;

  constructor(
    private readonly post: (message: SendGateMessage) => void,
    private readonly options: SendGateOptions = {},
  ) {}

  pipe(readable: ReadableStream<any>, writable: WritableStream<any>) {
    return readable
      .pipeThrough(
        new TransformStream({
          transform: (frame, controller) => this.transform(frame, controller),
        }),
      )
      .pipeTo(writable);
  }

  private transform(
    frame: any,
    controller: TransformStreamDefaultController<any>,
  ) {
    if (this.closed) return;
    this.controller = controller;
    const timestamp: number =
      frame.getMetadata().rtpTimestamp ?? frame.timestamp;
    if (this.first === undefined) {
      this.first = timestamp;
      this.post({ type: "start", firstRtpTimestamp: timestamp });
    }
    this.last = timestamp;
    this.frames++;
    const hold = this.options.holdFrames ?? 0;
    if (hold === 0) {
      controller.enqueue(frame);
      return;
    }
    this.held.push(frame);
    while (this.held.length > hold) controller.enqueue(this.held.shift());
  }

  /** Stop sending. Returns the range of every frame sent or still held. */
  close(releaseHeldAfterMs = 0) {
    this.closed = true;
    const range: SendGateMessage = {
      type: "range",
      firstRtpTimestamp: this.first,
      lastRtpTimestamp: this.last,
      frames: this.frames,
    };
    this.post(range);
    const held = this.held.splice(0);
    if (held.length > 0) {
      setTimeout(() => {
        for (const frame of held) this.controller?.enqueue(frame);
      }, releaseHeldAfterMs);
    }
    return range;
  }
}
