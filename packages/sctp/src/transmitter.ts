import { range } from "lodash";
import {
  type Chunk,
  DataChunk,
  ForwardTsnChunk,
  type InitAckChunk,
  type InitChunk,
  type SackChunk,
  serializePacket,
} from "./chunk";
import {
  SCTP_DATA_LAST_FRAG,
  SCTP_DATA_UNORDERED,
  SCTP_RTO_ALPHA,
  SCTP_RTO_BETA,
  SCTP_RTO_INITIAL,
  SCTP_RTO_MAX,
  SCTP_RTO_MIN,
  SCTP_TSN_MODULO,
  USERDATA_MAX_LENGTH,
} from "./const";
import type { Unpacked } from "./helper";
import { Event, debug, uint32Gt, uint32Gte } from "./imports/common";
import { tsnMinusOne } from "./stream";
import { type SCTPTimerManager, SCTPTimerType } from "./timer";
import type { Transport } from "./transport";

const log = debug("packages/sctp/src/transmitter.ts");

export class SCTPTransmitter {
  private localPort: number;
  private remotePort?: number;
  private remoteVerificationTag = 0;
  state: SCTPConnectionState = "new";
  onStateChanged = new Event<[SCTPConnectionState]>();
  flush = new Event<[void]>();
  outboundQueue: DataChunk[] = [];
  sentQueue: DataChunk[] = [];
  private forwardTsnChunk?: ForwardTsnChunk;
  private fastRecoveryExit?: number;
  private flightSize = 0;
  private cwnd = 3 * USERDATA_MAX_LENGTH; // Congestion Window
  private fastRecoveryTransmit = false;
  private lastSackedTsn: number;
  private srtt?: number;
  private rttvar?: number;
  private partialBytesAcked = 0;
  private ssthresh?: number; // slow start threshold
  private advancedPeerAckTsn: number;
  onSackReceived: () => Promise<void> = async () => {};

  constructor(
    public transport: Transport,
    private timerManager: SCTPTimerManager,
    public localTsn: number,
    public port = 5000,
  ) {
    this.localPort = port;
    this.lastSackedTsn = tsnMinusOne(this.localTsn);
    this.advancedPeerAckTsn = tsnMinusOne(this.localTsn); // acknowledgement
  }

  onT3Expired() {
    for (const chunk of this.sentQueue) {
      if (!this.maybeAbandon(chunk)) {
        chunk.retransmit = true;
      }
    }
    this.updateAdvancedPeerAckPoint();

    // # adjust congestion window
    this.fastRecoveryExit = undefined;
    this.flightSize = 0;
    this.partialBytesAcked = 0;

    this.ssthresh = Math.max(
      Math.floor(this.cwnd / 2),
      4 * USERDATA_MAX_LENGTH,
    );
    this.cwnd = USERDATA_MAX_LENGTH;

    this.transmit();
  }

  setRemotePort(port: number) {
    this.remotePort = port;
  }

  handleInitChunk(init: InitChunk | InitAckChunk) {
    this.remoteVerificationTag = init.initiateTag;
    this.ssthresh = init.advertisedRwnd;
  }

  async sendChunk(chunk: Chunk) {
    if (this.state === "closed") return;
    if (this.remotePort === undefined) {
      throw new Error("invalid remote port");
    }

    const packet = serializePacket(
      this.localPort,
      this.remotePort,
      this.remoteVerificationTag,
      chunk,
    );
    await this.transport.send(packet);
  }

  setConnectionState(state: SCTPConnectionState) {
    this.state = state;
    log("setConnectionState", state);
    this.onStateChanged.execute(state);
  }

  async transmit() {
    // """
    // Transmit outbound data.
    // """

    // # send FORWARD TSN
    if (this.forwardTsnChunk) {
      await this.sendChunk(this.forwardTsnChunk).catch((err: Error) => {
        log("send forwardTsn failed", err.message);
      });
      this.forwardTsnChunk = undefined;

      if (!this.timerManager.isRunning(SCTPTimerType.T3)) {
        this.timerManager.startT3();
      }
    }

    const burstSize =
      this.fastRecoveryExit != undefined
        ? 2 * USERDATA_MAX_LENGTH
        : 4 * USERDATA_MAX_LENGTH;

    const cwnd = Math.min(this.flightSize + burstSize, this.cwnd);

    let retransmitEarliest = true;
    for (const dataChunk of this.sentQueue) {
      if (dataChunk.retransmit) {
        if (this.fastRecoveryTransmit) {
          this.fastRecoveryTransmit = false;
        } else if (this.flightSize >= cwnd) {
          return;
        }
        this.flightSizeIncrease(dataChunk);

        dataChunk.misses = 0;
        dataChunk.retransmit = false;
        dataChunk.sentCount++;
        await this.sendChunk(dataChunk).catch((err: Error) => {
          log("send data failed", err.message);
        });

        if (retransmitEarliest) {
          this.timerManager.restartT3();
        }
      }
      retransmitEarliest = false;
    }

    // for performance todo fix
    while (this.outboundQueue.length > 0) {
      const chunk = this.outboundQueue.shift();
      if (!chunk) return;

      this.sentQueue.push(chunk);
      this.flightSizeIncrease(chunk);

      // # update counters
      chunk.sentCount++;
      chunk.sentTime = Date.now() / 1000;

      await this.sendChunk(chunk).catch((err: Error) => {
        log("send data outboundQueue failed", err.message);
      });
      if (!this.timerManager.isRunning(SCTPTimerType.T3)) {
        this.timerManager.startT3();
      }
    }
    // Resetting the queue to empty array mitigates this.
    this.outboundQueue = [];
    this.flush.execute();
  }

  flightSizeIncrease(chunk: DataChunk) {
    this.flightSize += chunk.bookSize;
  }

  flightSizeDecrease(chunk: DataChunk) {
    this.flightSize = Math.max(0, this.flightSize - chunk.bookSize);
  }

  maybeAbandon(chunk: DataChunk): boolean {
    if (chunk.abandoned) return true;
    const abandon =
      (!!chunk.maxRetransmits && chunk.maxRetransmits < chunk.sentCount!) ||
      (!!chunk.expiry && chunk.expiry < Date.now() / 1000);
    if (!abandon) return false;

    const chunkPos = this.sentQueue.findIndex((v) => v.type === chunk.type);
    for (const pos of range(chunkPos, -1, -1)) {
      const oChunk = this.sentQueue[pos];
      oChunk.abandoned = true;
      oChunk.retransmit = false;
      if (oChunk.flags & SCTP_DATA_LAST_FRAG) {
        break;
      }
    }

    for (const pos of range(chunkPos, this.sentQueue.length)) {
      const oChunk = this.sentQueue[pos];
      oChunk.abandoned = true;
      oChunk.retransmit = false;
      if (oChunk.flags & SCTP_DATA_LAST_FRAG) {
        break;
      }
    }

    return true;
  }

  // https://github.com/pion/sctp/pull/44/files
  async sendResetRequest(streamId: number) {
    log("sendResetRequest", streamId);
    const chunk = new DataChunk(0, undefined);
    chunk.streamId = streamId;
    this.outboundQueue.push(chunk);
    if (!this.timerManager.isRunning(SCTPTimerType.T3)) {
      await this.transmit();
    }
  }

  async receiveSackChunk(chunk: SackChunk) {
    // """
    // Handle a SACK chunk.
    // """

    if (uint32Gt(this.lastSackedTsn, chunk.cumulativeTsn)) return;

    const receivedTime = Date.now() / 1000;
    this.lastSackedTsn = chunk.cumulativeTsn;
    const cwndFullyUtilized = this.flightSize >= this.cwnd;
    let done = 0,
      doneBytes = 0;

    // # handle acknowledged data
    while (
      this.sentQueue.length > 0 &&
      uint32Gte(this.lastSackedTsn, this.sentQueue[0].tsn)
    ) {
      const sChunk = this.sentQueue.shift()!;
      done++;
      if (!sChunk?.acked) {
        doneBytes += sChunk.bookSize;
        this.flightSizeDecrease(sChunk);
      }

      if (done === 1 && sChunk.sentCount === 1) {
        this.updateRto(receivedTime - sChunk.sentTime!);
      }
    }
    // Furthermore, this exposed an issue I've seen in v8 in other projects: using an array as a queue seems to result in long calls to shift (it does an array copy under the hood?). The problem seems to get worse the more times it shifts. Resetting the queue to empty array mitigates this.
    if (!this.sentQueue.length) {
      this.sentQueue = [];
    }

    // # handle gap blocks
    let loss = false;
    if (chunk.gaps.length > 0) {
      const seen = new Set();
      let highestSeenTsn: number;
      chunk.gaps.forEach((gap) =>
        range(gap[0], gap[1] + 1).forEach((pos) => {
          highestSeenTsn = (chunk.cumulativeTsn + pos) % SCTP_TSN_MODULO;
          seen.add(highestSeenTsn);
        }),
      );

      let highestNewlyAcked = chunk.cumulativeTsn;
      for (const sChunk of this.sentQueue) {
        if (uint32Gt(sChunk.tsn, highestSeenTsn!)) {
          break;
        }
        if (seen.has(sChunk.tsn) && !sChunk.acked) {
          doneBytes += sChunk.bookSize;
          sChunk.acked = true;
          this.flightSizeDecrease(sChunk);
          highestNewlyAcked = sChunk.tsn;
        }
      }

      // # strike missing chunks prior to HTNA
      for (const sChunk of this.sentQueue) {
        if (uint32Gt(sChunk.tsn, highestNewlyAcked)) {
          break;
        }
        if (!seen.has(sChunk.tsn)) {
          sChunk.misses++;
          if (sChunk.misses === 3) {
            sChunk.misses = 0;
            if (!this.maybeAbandon(sChunk)) {
              sChunk.retransmit = true;
            }
            sChunk.acked = false;
            this.flightSizeDecrease(sChunk);
            loss = true;
          }
        }
      }
    }

    // # adjust congestion window
    if (this.fastRecoveryExit === undefined) {
      if (done && cwndFullyUtilized) {
        if (this.cwnd <= this.ssthresh!) {
          this.cwnd += Math.min(doneBytes, USERDATA_MAX_LENGTH);
        } else {
          this.partialBytesAcked += doneBytes;
          if (this.partialBytesAcked >= this.cwnd) {
            this.partialBytesAcked -= this.cwnd;
            this.cwnd += USERDATA_MAX_LENGTH;
          }
        }
      }
      if (loss) {
        this.ssthresh = Math.max(
          Math.floor(this.cwnd / 2),
          4 * USERDATA_MAX_LENGTH,
        );
        this.cwnd = this.ssthresh;
        this.partialBytesAcked = 0;
        this.fastRecoveryExit = this.sentQueue[this.sentQueue.length - 1].tsn;
        this.fastRecoveryTransmit = true;
      }
    } else if (uint32Gte(chunk.cumulativeTsn, this.fastRecoveryExit)) {
      this.fastRecoveryExit = undefined;
    }

    if (this.sentQueue.length === 0) {
      this.timerManager.cancelT3();
    } else if (done > 0) {
      this.timerManager.restartT3();
    }

    this.updateAdvancedPeerAckPoint();
    await this.onSackReceived();
    await this.transmit();
  }

  updateAdvancedPeerAckPoint() {
    if (uint32Gt(this.lastSackedTsn, this.advancedPeerAckTsn)) {
      this.advancedPeerAckTsn = this.lastSackedTsn;
    }

    let done = 0;
    const streams: { [key: number]: number } = {};
    while (this.sentQueue.length > 0 && this.sentQueue[0].abandoned) {
      const chunk = this.sentQueue.shift()!;
      this.advancedPeerAckTsn = chunk.tsn;
      done++;
      if (!(chunk.flags & SCTP_DATA_UNORDERED)) {
        streams[chunk.streamId] = chunk.streamSeqNum;
      }
    }
    // Resetting the queue to empty array mitigates this.
    if (!this.sentQueue.length) {
      this.sentQueue = [];
    }

    if (done) {
      this.forwardTsnChunk = new ForwardTsnChunk(0, undefined);
      this.forwardTsnChunk.cumulativeTsn = this.advancedPeerAckTsn;
      this.forwardTsnChunk.streams = Object.entries(streams).map(([k, v]) => [
        Number(k),
        v,
      ]);
    }
  }

  private updateRto(R: number) {
    if (!this.srtt) {
      this.rttvar = R / 2;
      this.srtt = R;
    } else {
      this.rttvar =
        (1 - SCTP_RTO_BETA) * this.rttvar! +
        SCTP_RTO_BETA * Math.abs(this.srtt - R);
      this.srtt = (1 - SCTP_RTO_ALPHA) * this.srtt + SCTP_RTO_ALPHA * R;
    }
    this.timerManager.rto = Math.max(
      SCTP_RTO_MIN,
      Math.min(this.srtt + 4 * this.rttvar, SCTP_RTO_MAX),
    );
  }
}
export const SCTPConnectionStates = [
  "new",
  "closed",
  "connected",
  "connecting",
] as const;
export type SCTPConnectionState = Unpacked<typeof SCTPConnectionStates>;
