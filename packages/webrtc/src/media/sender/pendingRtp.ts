import { RtpPacket } from "../../imports/rtp";

const DEFAULT_PENDING_RTP_MAX_LENGTH = 256;

export type PendingRtpOptions = {
  /** Queue RTP until DTLS is connected and a codec is set. Default true when this object is passed. */
  enabled?: boolean;
  /** Max queued packets when enabled. Oldest packets are dropped. Default 256. */
  maxLength?: number;
};

type PendingRtpItem = {
  packet: RtpPacket;
  sourceEpoch: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/** `RTCRtpSenderOptions.pendingRtp` → effective settings. Disabled by default. */
export function resolvePendingRtpOptions(
  pendingRtp: boolean | PendingRtpOptions | undefined,
): { enabled: boolean; maxLength: number } {
  if (pendingRtp === true) {
    return { enabled: true, maxLength: DEFAULT_PENDING_RTP_MAX_LENGTH };
  }
  if (pendingRtp == undefined || pendingRtp === false) {
    return { enabled: false, maxLength: DEFAULT_PENDING_RTP_MAX_LENGTH };
  }
  const maxLength =
    typeof pendingRtp.maxLength === "number" &&
    Number.isFinite(pendingRtp.maxLength) &&
    pendingRtp.maxLength >= 1
      ? Math.floor(pendingRtp.maxLength)
      : DEFAULT_PENDING_RTP_MAX_LENGTH;
  return { enabled: pendingRtp.enabled ?? true, maxLength };
}

/**
 * RTP accepted before the sender can send (DTLS not connected, no codec yet),
 * held up to a length cap. Each packet's `sendRtp` promise settles when it is
 * sent, dropped (oldest first over the cap, stale source, discard), or fails.
 */
export class PendingRtpQueue {
  private readonly maxLength: number;
  private items: PendingRtpItem[] = [];
  private draining = false;

  constructor(maxLength: number) {
    this.maxLength = maxLength;
  }

  get length() {
    return this.items.length;
  }

  /** Own a copy of `rtp` (shared tracks hand every sender the same packet). */
  enqueue(
    rtp: Buffer | RtpPacket,
    sourceEpoch: number,
    resolve: () => void,
    reject: (error: unknown) => void,
  ) {
    const packet = Buffer.isBuffer(rtp)
      ? RtpPacket.deSerialize(rtp)
      : rtp.clone();
    this.items.push({ packet, resolve, reject, sourceEpoch });
    while (this.items.length > this.maxLength) {
      const dropped = this.items.shift();
      if (dropped) {
        settle(dropped);
      }
    }
  }

  /** Drop every held packet. */
  discard() {
    for (const item of this.items.splice(0)) {
      settle(item);
    }
  }

  /** Drop packets accepted under a source epoch other than `sourceEpoch`. */
  dropStaleSource(sourceEpoch: number) {
    const stale = this.items.filter((item) => item.sourceEpoch !== sourceEpoch);
    this.items = this.items.filter((item) => item.sourceEpoch === sourceEpoch);
    for (const item of stale) {
      settle(item);
    }
  }

  /**
   * Send held packets in order while `canSend()`. Re-entrant calls return
   * at once; packets added during a drain are sent by it.
   */
  async drain(
    canSend: () => boolean,
    dispatch: (packet: RtpPacket, sourceEpoch: number) => Promise<unknown>,
  ): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.items.length > 0 && canSend()) {
        const item = this.items.shift()!;
        if (!canSend()) {
          settle(item);
          continue;
        }
        try {
          await dispatch(item.packet, item.sourceEpoch);
          settle(item);
        } catch (error) {
          settle(item, error);
        }
      }
    } finally {
      this.draining = false;
    }
    if (this.items.length > 0 && canSend()) {
      await this.drain(canSend, dispatch);
    }
  }
}

function settle(item: PendingRtpItem, error?: unknown) {
  if (error == undefined) {
    item.resolve();
    return;
  }
  item.reject(error);
}
