import { setTimeout } from "timers/promises";

import { uint8Add, uint24 } from "../../imports/common";
import {
  PacketStatus,
  RecvDelta,
  RtcpTransportLayerFeedback,
  RunLengthChunk,
  type StatusVectorChunk,
  TransportWideCC,
  debug,
} from "../../imports/rtp";
import type { RTCDtlsTransport } from "../../transport/dtls";
import { microTime } from "../../utils";

const log = debug("werift:packages/webrtc/media/receiver/receiverTwcc");

const TWCC_SEQ_MOD = 0x10000;

type ExtensionInfo = { tsn: number; timestamp: bigint };

/**
 * Receiver-side TWCC feedback generator.
 *
 * Feedback triggers: every 100ms (periodic) or when >10 packets are buffered.
 * Status chunks cover the full transport-sequence span (including gaps as
 * PacketNotReceived) so wire status count matches recv-delta count.
 */
export class ReceiverTWCC {
  extensionInfo: {
    [tsn: number]: ExtensionInfo;
  } = {};
  /** Periodic 100ms loop runs while true (enabled in constructor). */
  twccRunning = true;
  /** uint8 */
  fbPktCount = 0;
  lastTimestamp?: bigint;

  constructor(
    private dtlsTransport: RTCDtlsTransport,
    private rtcpSsrc: number,
    private mediaSourceSsrc: number,
  ) {
    this.runTWCC();
  }

  handleTWCC(transportSequenceNumber: number) {
    const tsn = transportSequenceNumber & 0xffff;
    this.extensionInfo[tsn] = {
      tsn,
      timestamp: microTime(),
    };

    if (Object.keys(this.extensionInfo).length > 10) {
      this.sendTWCC();
    }
  }

  private async runTWCC() {
    while (this.twccRunning) {
      this.sendTWCC();
      await setTimeout(100);
    }
  }

  private sendTWCC() {
    if (Object.keys(this.extensionInfo).length === 0) return;

    // Wrap-aware base: largest circular gap between unique TSNs → base after gap.
    // (Do not use Object.values numeric key order — that sorts 0 before 65534.)
    const received = Object.values(this.extensionInfo).map((e) => ({
      tsn: e.tsn & 0xffff,
      timestamp: e.timestamp,
    }));
    const unique = [...new Set(received.map((r) => r.tsn))].sort(
      (a, b) => a - b,
    );
    let maxGap = -1;
    let baseSequenceNumber = unique[0];
    for (let i = 0; i < unique.length; i++) {
      const a = unique[i];
      const b = unique[(i + 1) % unique.length];
      const gap = i === unique.length - 1 ? b + TWCC_SEQ_MOD - a : b - a;
      if (gap > maxGap) {
        maxGap = gap;
        baseSequenceNumber = b;
      }
    }
    received.sort(
      (a, b) =>
        ((a.tsn - baseSequenceNumber + TWCC_SEQ_MOD) % TWCC_SEQ_MOD) -
        ((b.tsn - baseSequenceNumber + TWCC_SEQ_MOD) % TWCC_SEQ_MOD),
    );
    const lastTsn = received[received.length - 1].tsn;
    // Inclusive count; never zero for a non-empty received set.
    const packetStatusCount =
      ((lastTsn - baseSequenceNumber + TWCC_SEQ_MOD) % TWCC_SEQ_MOD) + 1;
    if (packetStatusCount > 0x7fff) {
      // Prefer dropping feedback over encoding nearly the full 16-bit space.
      log(
        "TWCC span too large, packetStatusCount=%s base=%s last=%s",
        packetStatusCount,
        baseSequenceNumber,
        lastTsn,
      );
      this.extensionInfo = {};
      return;
    }

    const packetChunks: (RunLengthChunk | StatusVectorChunk)[] = [];
    const recvDeltas: RecvDelta[] = [];
    /** micro sec */
    let referenceTime!: bigint;

    // Build full transport-sequence status series (received + not-received gaps).
    type StatusEntry = {
      received: boolean;
      status: PacketStatus;
    };
    const statuses: StatusEntry[] = [];

    for (let offset = 0; offset < packetStatusCount; offset++) {
      const seq = (baseSequenceNumber + offset) & 0xffff;
      const info = this.extensionInfo[seq];
      if (!info) {
        statuses.push({
          received: false,
          status: PacketStatus.TypeTCCPacketNotReceived,
        });
        continue;
      }

      if (!this.lastTimestamp) {
        this.lastTimestamp = info.timestamp;
      }
      if (!referenceTime) {
        referenceTime = this.lastTimestamp;
      }

      const delta = info.timestamp - this.lastTimestamp;
      this.lastTimestamp = info.timestamp;

      const recvDelta = new RecvDelta({
        delta: Number(delta),
      });
      recvDelta.parseDelta();
      recvDeltas.push(recvDelta);

      statuses.push({
        received: true,
        status: recvDelta.type!,
      });
    }

    if (!referenceTime) {
      return;
    }

    // Compress status series into RunLength chunks (status may mix received types
    // and PacketNotReceived — never skip gaps).
    let runStatus = statuses[0].status;
    let runStart = 0;
    for (let i = 1; i <= statuses.length; i++) {
      const done = i === statuses.length;
      const status = done ? undefined : statuses[i].status;
      if (done || status !== runStatus) {
        packetChunks.push(
          new RunLengthChunk({
            packetStatus: runStatus,
            runLength: i - runStart,
          }),
        );
        if (!done) {
          runStatus = status!;
          runStart = i;
        }
      }
    }

    const packet = new RtcpTransportLayerFeedback({
      feedback: new TransportWideCC({
        senderSsrc: this.rtcpSsrc,
        mediaSourceSsrc: this.mediaSourceSsrc,
        baseSequenceNumber,
        packetStatusCount,
        referenceTime: uint24(Math.floor(Number(referenceTime / 1000n / 64n))),
        fbPktCount: this.fbPktCount,
        recvDeltas,
        packetChunks,
      }),
    });

    this.dtlsTransport.sendRtcp([packet]).catch((err) => {
      log(err);
    });
    this.extensionInfo = {};
    this.fbPktCount = uint8Add(this.fbPktCount, 1);
  }
}
