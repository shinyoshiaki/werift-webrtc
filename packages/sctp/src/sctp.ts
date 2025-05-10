import { createHmac, randomBytes } from "crypto";
import { jspack } from "@shinyoshiaki/jspack";

import range from "lodash/range.js";
import {
  AbortChunk,
  type Chunk,
  CookieAckChunk,
  CookieEchoChunk,
  DataChunk,
  ErrorChunk,
  ForwardTsnChunk,
  HeartbeatAckChunk,
  HeartbeatChunk,
  InitAckChunk,
  InitChunk,
  ReConfigChunk,
  ReconfigChunk,
  SackChunk,
  ShutdownAckChunk,
  ShutdownChunk,
  ShutdownCompleteChunk,
  parsePacket,
  serializePacket,
} from "./chunk";
import {
  COOKIE_LENGTH,
  COOKIE_LIFETIME,
  MAX_STREAMS,
  RECONFIG_MAX_STREAMS,
  SCTP_DATA_FIRST_FRAG,
  SCTP_DATA_LAST_FRAG,
  SCTP_DATA_UNORDERED,
  SCTP_MAX_ASSOCIATION_RETRANS,
  SCTP_MAX_INIT_RETRANS,
  SCTP_PRSCTP_SUPPORTED,
  SCTP_RTO_ALPHA,
  SCTP_RTO_BETA,
  SCTP_RTO_INITIAL,
  SCTP_RTO_MAX,
  SCTP_RTO_MIN,
  SCTP_STATE,
  SCTP_STATE_COOKIE,
  SCTP_SUPPORTED_CHUNK_EXT,
  SCTP_TSN_MODULO,
  USERDATA_MAX_LENGTH,
} from "./const";
import { type Unpacked, createEventsFromList, enumerate } from "./helper";
import {
  Event,
  debug,
  random32,
  uint16Add,
  uint16Gt,
  uint32Gt,
  uint32Gte,
} from "./imports/common";
import {
  OutgoingSSNResetRequestParam,
  RECONFIG_PARAM_BY_TYPES,
  ReconfigResponseParam,
  StreamAddOutgoingParam,
  type StreamParam,
  reconfigResult,
} from "./param";
import { InboundStream, tsnMinusOne, tsnPlusOne } from "./stream";
import type { Transport } from "./transport";
import { SCTPTimerManager, SCTPTimerType } from "./timer";

const log = debug("werift/sctp/sctp");

// SSN: Stream Sequence Number

const SCTPConnectionStates = [
  "new",
  "closed",
  "connected",
  "connecting",
] as const;
type SCTPConnectionState = Unpacked<typeof SCTPConnectionStates>;

export class SCTP {
  flush = new Event<[void]>();
  readonly stateChanged: {
    [key in SCTPConnectionState]: Event<[]>;
  } = createEventsFromList(SCTPConnectionStates);
  readonly onReconfigStreams = new Event<[number[]]>();
  /**streamId: number, ppId: number, data: Buffer */
  readonly onReceive = new Event<[number, number, Buffer]>();
  onSackReceived: () => Promise<void> = async () => {};

  associationState = SCTP_STATE.CLOSED;
  started = false;
  state: SCTPConnectionState = "new";
  isServer = true;

  private hmacKey = randomBytes(16);
  private localPartialReliability = true;
  private localPort: number;
  private localVerificationTag = random32();

  remoteExtensions: number[] = [];
  remotePartialReliability = true;
  private remotePort?: number;
  private remoteVerificationTag = 0;

  // inbound
  private advertisedRwnd = 1024 * 1024; // Receiver Window
  private inboundStreams: { [key: number]: InboundStream } = {};
  _inboundStreamsCount = 0;
  _inboundStreamsMax = MAX_STREAMS;
  private lastReceivedTsn?: number; // Transmission Sequence Number
  private sackDuplicates: number[] = [];
  private sackMisOrdered = new Set<number>();
  private sackNeeded = false;
  private sackTimeout: NodeJS.Immediate | undefined;

  // # outbound
  private cwnd = 3 * USERDATA_MAX_LENGTH; // Congestion Window
  private fastRecoveryExit?: number;
  private fastRecoveryTransmit = false;
  private forwardTsnChunk?: ForwardTsnChunk;
  private flightSize = 0;
  outboundQueue: DataChunk[] = [];
  private outboundStreamSeq: { [streamId: number]: number } = {};
  _outboundStreamsCount = MAX_STREAMS;
  /**local transmission sequence number */
  private localTsn = Number(random32());
  private lastSackedTsn = tsnMinusOne(this.localTsn);
  private advancedPeerAckTsn = tsnMinusOne(this.localTsn); // acknowledgement
  private partialBytesAcked = 0;
  private sentQueue: DataChunk[] = [];

  // # reconfiguration

  /**初期TSNと同じ値に初期化される単調に増加する数です. これは、新しいre-configuration requestパラメーターを送信するたびに1ずつ増加します */
  reconfigRequestSeq = this.localTsn;
  /**このフィールドは、incoming要求のre-configuration requestシーケンス番号を保持します. 他の場合では、次に予想されるre-configuration requestシーケンス番号から1を引いた値が保持されます */
  reconfigResponseSeq = 0;
  reconfigRequest?: OutgoingSSNResetRequestParam;
  reconfigQueue: number[] = [];

  // rtt calculation
  private srtt?: number;
  private rttvar?: number;

  // timers
  private rto = SCTP_RTO_INITIAL;
  /**t1 is wait for initAck or cookieAck */

  /**Re-configuration Timer */
  private timerManager: SCTPTimerManager;
  private timerReconfigHandle?: any;
  private timerReconfigFailures = 0;

  // etc
  private ssthresh?: number; // slow start threshold

  constructor(
    public transport: Transport,
    public port = 5000,
  ) {
    this.localPort = this.port;
    this.transport.onData = (buf) => {
      this.handleData(buf);
    };
    this.timerManager = new SCTPTimerManager({
      rto: this.rto,
      onT1Expired: (failures) => {
        this.setState(SCTP_STATE.CLOSED);
      },
      onT2Expired: (failures) => {
        this.setState(SCTP_STATE.CLOSED);
      },
      onT3Expired: () => {
        // # mark retransmit or abandoned chunks
        this.sentQueue.forEach((chunk) => {
          if (!this.maybeAbandon(chunk)) {
            chunk.retransmit = true;
          }
        });
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
      },
      onReconfigExpired: () => {},
      sendChunk: async (chunk) => {},
      maxInitRetrans: SCTP_MAX_INIT_RETRANS,
      maxAssociationRetrans: SCTP_MAX_ASSOCIATION_RETRANS,
    });
  }

  get maxChannels() {
    if (this._inboundStreamsCount > 0) {
      return Math.min(this._inboundStreamsCount, this._outboundStreamsCount);
    }
    return undefined;
  }

  static client(transport: Transport, port = 5000) {
    const sctp = new SCTP(transport, port);
    sctp.isServer = false;
    return sctp;
  }

  static server(transport: Transport, port = 5000) {
    const sctp = new SCTP(transport, port);
    sctp.isServer = true;
    return sctp;
  }

  // call from dtls transport
  private async handleData(data: Buffer) {
    let expectedTag: number;

    const [, , verificationTag, chunks] = parsePacket(data);
    const initChunk = chunks.filter((v) => v.type === InitChunk.type).length;
    if (initChunk > 0) {
      if (chunks.length != 1) {
        throw new Error();
      }
      expectedTag = 0;
    } else {
      expectedTag = this.localVerificationTag;
    }

    if (verificationTag !== expectedTag) {
      return;
    }

    for (const chunk of chunks) {
      await this.receiveChunk(chunk);
    }

    if (this.sackNeeded) {
      await this.sendSack();
    }
  }

  private async sendSack() {
    if (this.sackTimeout) return;
    await new Promise((r) => (this.sackTimeout = setImmediate(r)));
    this.sackTimeout = undefined;
    if (!this.sackNeeded) return;

    const gaps: [number, number][] = [];
    let gapNext: number;
    [...this.sackMisOrdered].sort().forEach((tsn) => {
      const pos = (tsn - this.lastReceivedTsn!) % SCTP_TSN_MODULO;
      if (tsn === gapNext) {
        gaps[gaps.length - 1][1] = pos;
      } else {
        gaps.push([pos, pos]);
      }
      gapNext = tsnPlusOne(tsn);
    });
    const sack = new SackChunk(0, undefined);
    sack.cumulativeTsn = this.lastReceivedTsn!;
    sack.advertisedRwnd = Math.max(0, this.advertisedRwnd);
    sack.duplicates = [...this.sackDuplicates];
    sack.gaps = gaps;

    await this.sendChunk(sack).catch((err: Error) => {
      log("send sack failed", err.message);
    });

    this.sackDuplicates = [];
    this.sackNeeded = false;
  }

  private async receiveChunk(chunk: Chunk) {
    switch (chunk.type) {
      case DataChunk.type:
        {
          this.receiveDataChunk(chunk as DataChunk);
        }
        break;
      case InitChunk.type:
        {
          if (!this.isServer) return;
          const init = chunk as InitChunk;

          log("receive init", init);
          this.lastReceivedTsn = tsnMinusOne(init.initialTsn);
          this.reconfigResponseSeq = tsnMinusOne(init.initialTsn);
          this.remoteVerificationTag = init.initiateTag;
          this.ssthresh = init.advertisedRwnd;
          this.getExtensions(init.params);

          this._inboundStreamsCount = Math.min(
            init.outboundStreams,
            this._inboundStreamsMax,
          );
          this._outboundStreamsCount = Math.min(
            this._outboundStreamsCount,
            init.inboundStreams,
          );

          const ack = new InitAckChunk();
          ack.initiateTag = this.localVerificationTag;
          ack.advertisedRwnd = this.advertisedRwnd;
          ack.outboundStreams = this._outboundStreamsCount;
          ack.inboundStreams = this._inboundStreamsCount;
          ack.initialTsn = this.localTsn;
          this.setExtensions(ack.params);

          const time = Date.now() / 1000;
          let cookie = Buffer.from(jspack.Pack("!L", [time]));
          cookie = Buffer.concat([
            cookie,
            createHmac("sha1", this.hmacKey).update(cookie).digest(),
          ]);
          ack.params.push([SCTP_STATE_COOKIE, cookie]);
          log("send initAck", ack);
          await this.sendChunk(ack).catch((err: Error) => {
            log("send initAck failed", err.message);
          });
        }
        break;
      case InitAckChunk.type:
        {
          if (this.associationState != SCTP_STATE.COOKIE_WAIT) return;

          const initAck = chunk as InitAckChunk;
          this.timerManager.cancelT1();
          this.lastReceivedTsn = tsnMinusOne(initAck.initialTsn);
          this.reconfigResponseSeq = tsnMinusOne(initAck.initialTsn);
          this.remoteVerificationTag = initAck.initiateTag;
          this.ssthresh = initAck.advertisedRwnd;
          this.getExtensions(initAck.params);

          this._inboundStreamsCount = Math.min(
            initAck.outboundStreams,
            this._inboundStreamsMax,
          );
          this._outboundStreamsCount = Math.min(
            this._outboundStreamsCount,
            initAck.inboundStreams,
          );

          const echo = new CookieEchoChunk();
          for (const [k, v] of initAck.params) {
            if (k === SCTP_STATE_COOKIE) {
              echo.body = v;
              break;
            }
          }
          await this.sendChunk(echo).catch((err: Error) => {
            log("send echo failed", err.message);
          });

          this.timerManager.startT1(echo);
          this.setState(SCTP_STATE.COOKIE_ECHOED);
        }
        break;
      case SackChunk.type:
        {
          await this.receiveSackChunk(chunk as SackChunk);
        }
        break;
      case HeartbeatChunk.type:
        {
          const ack = new HeartbeatAckChunk();
          ack.params = (chunk as HeartbeatChunk).params;
          await this.sendChunk(ack).catch((err: Error) => {
            log("send heartbeat ack failed", err.message);
          });
        }
        break;
      case AbortChunk.type:
        {
          this.setState(SCTP_STATE.CLOSED);
        }
        break;
      case ShutdownChunk.type:
        {
          this.timerManager.cancelT2();
          this.setState(SCTP_STATE.SHUTDOWN_RECEIVED);
          const ack = new ShutdownAckChunk();
          await this.sendChunk(ack).catch((err: Error) => {
            log("send shutdown ack failed", err.message);
          });
          this.timerManager.startT2(ack);
          this.setState(SCTP_STATE.SHUTDOWN_SENT);
        }
        break;
      case ErrorChunk.type:
        {
          // 3.3.10.  Operation Error (ERROR) (9)
          // An Operation Error is not considered fatal in and of itself, but may be
          // used with an ABORT chunk to report a fatal condition.  It has the
          // following parameters:
          log("ErrorChunk", (chunk as ErrorChunk).descriptions);
        }
        break;
      case CookieEchoChunk.type:
        {
          if (!this.isServer) return;
          const data = chunk as CookieEchoChunk;
          const cookie = data.body!;
          const digest = createHmac("sha1", this.hmacKey)
            .update(cookie.slice(0, 4))
            .digest();
          if (
            cookie?.length != COOKIE_LENGTH ||
            !cookie.slice(4).equals(digest)
          ) {
            log("x State cookie is invalid");
            return;
          }
          const now = Date.now() / 1000;
          const stamp = jspack.Unpack("!L", cookie)[0];
          if (stamp < now - COOKIE_LIFETIME || stamp > now) {
            const error = new ErrorChunk(0, undefined);
            error.params.push([
              ErrorChunk.CODE.StaleCookieError,
              Buffer.concat([...Array(8)].map(() => Buffer.from("\x00"))),
            ]);
            await this.sendChunk(error).catch((err: Error) => {
              log("send errorChunk failed", err.message);
            });
            return;
          }
          const ack = new CookieAckChunk();
          await this.sendChunk(ack).catch((err: Error) => {
            log("send cookieAck failed", err.message);
          });
          this.setState(SCTP_STATE.ESTABLISHED);
        }
        break;
      case CookieAckChunk.type:
        {
          if (this.associationState != SCTP_STATE.COOKIE_ECHOED) return;
          this.timerManager.cancelT1();
          this.setState(SCTP_STATE.ESTABLISHED);
        }
        break;
      case ShutdownCompleteChunk.type:
        {
          if (this.associationState != SCTP_STATE.SHUTDOWN_ACK_SENT) return;
          this.timerManager.cancelT2();
          this.setState(SCTP_STATE.CLOSED);
        }
        break;
      // extensions
      case ReconfigChunk.type:
        {
          if (this.associationState != SCTP_STATE.ESTABLISHED) return;
          const reconfig = chunk as ReConfigChunk;
          for (const [type, body] of reconfig.params) {
            const target = RECONFIG_PARAM_BY_TYPES[type];
            if (target) {
              await this.receiveReconfigParam(target.parse(body));
            }
          }
        }
        break;
      case ForwardTsnChunk.type:
        {
          this.receiveForwardTsnChunk(chunk as ForwardTsnChunk);
        }
        break;
    }
  }

  private getExtensions(params: [number, Buffer][]) {
    for (const [k, v] of params) {
      if (k === SCTP_PRSCTP_SUPPORTED) {
        this.remotePartialReliability = true;
      } else if (k === SCTP_SUPPORTED_CHUNK_EXT) {
        this.remoteExtensions = [...v];
      }
    }
  }

  private async receiveReconfigParam(param: StreamParam) {
    log("receiveReconfigParam", RECONFIG_PARAM_BY_TYPES[param.type]);
    switch (param.type) {
      case OutgoingSSNResetRequestParam.type:
        {
          const p = param as OutgoingSSNResetRequestParam;

          // # send response
          const response = new ReconfigResponseParam(
            p.requestSequence,
            reconfigResult.ReconfigResultSuccessPerformed,
          );
          this.reconfigResponseSeq = p.requestSequence;
          await this.sendReconfigParam(response);

          // # mark closed inbound streams
          await Promise.all(
            p.streams.map(async (streamId) => {
              delete this.inboundStreams[streamId];
              if (this.outboundStreamSeq[streamId]) {
                this.reconfigQueue.push(streamId);
                // await this.sendResetRequest(streamId);
              }
            }),
          );
          await this.transmitReconfigRequest();
          // # close data channel
          this.onReconfigStreams.execute(p.streams);
        }
        break;
      case ReconfigResponseParam.type:
        {
          const reset = param as ReconfigResponseParam;
          if (reset.result !== reconfigResult.ReconfigResultSuccessPerformed) {
            log(
              "OutgoingSSNResetRequestParam failed",
              Object.keys(reconfigResult).find(
                (key) => reconfigResult[key as never] === reset.result,
              ),
            );
          } else if (
            reset.responseSequence === this.reconfigRequest?.requestSequence
          ) {
            const streamIds = this.reconfigRequest.streams.map((streamId) => {
              delete this.outboundStreamSeq[streamId];
              return streamId;
            });

            this.onReconfigStreams.execute(streamIds);

            this.reconfigRequest = undefined;
            this.timerReconfigCancel();
            if (this.reconfigQueue.length > 0) {
              await this.transmitReconfigRequest();
            }
          }
        }
        break;
      case StreamAddOutgoingParam.type:
        {
          const add = param as StreamAddOutgoingParam;
          this._inboundStreamsCount += add.newStreams;
          const res = new ReconfigResponseParam(add.requestSequence, 1);
          this.reconfigResponseSeq = add.requestSequence;
          await this.sendReconfigParam(res);
        }
        break;
    }
  }

  private receiveDataChunk(chunk: DataChunk) {
    this.sackNeeded = true;

    if (this.markReceived(chunk.tsn)) return;

    const inboundStream = this.getInboundStream(chunk.streamId);

    inboundStream.addChunk(chunk);
    this.advertisedRwnd -= chunk.userData.length;
    for (const message of inboundStream.popMessages()) {
      this.advertisedRwnd += message[2].length;
      this.receive(...message);
    }
  }

  private async receiveSackChunk(chunk: SackChunk) {
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

  receiveForwardTsnChunk(chunk: ForwardTsnChunk) {
    this.sackNeeded = true;

    if (uint32Gte(this.lastReceivedTsn!, chunk.cumulativeTsn)) {
      return;
    }

    const isObsolete = (x: number) => uint32Gt(x, this.lastReceivedTsn!);

    // # advance cumulative TSN
    this.lastReceivedTsn = chunk.cumulativeTsn;
    this.sackMisOrdered = new Set([...this.sackMisOrdered].filter(isObsolete));
    for (const tsn of [...this.sackMisOrdered].sort()) {
      if (tsn === tsnPlusOne(this.lastReceivedTsn)) {
        this.lastReceivedTsn = tsn;
      } else {
        break;
      }
    }

    // # filter out obsolete entries
    this.sackDuplicates = this.sackDuplicates.filter(isObsolete);
    this.sackMisOrdered = new Set([...this.sackMisOrdered].filter(isObsolete));

    // # update reassembly
    for (const [streamId, streamSeqNum] of chunk.streams) {
      const inboundStream = this.getInboundStream(streamId);

      // # advance sequence number and perform delivery
      inboundStream.streamSequenceNumber = uint16Add(streamSeqNum, 1);
      for (const message of inboundStream.popMessages()) {
        this.advertisedRwnd += message[2].length;
        this.receive(...message);
      }
    }

    // # prune obsolete chunks
    Object.values(this.inboundStreams).forEach((inboundStream) => {
      this.advertisedRwnd += inboundStream.pruneChunks(this.lastReceivedTsn!);
    });
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
    this.rto = Math.max(
      SCTP_RTO_MIN,
      Math.min(this.srtt + 4 * this.rttvar, SCTP_RTO_MAX),
    );
  }

  private receive(streamId: number, ppId: number, data: Buffer) {
    this.onReceive.execute(streamId, ppId, data);
  }

  private getInboundStream(streamId: number) {
    if (!this.inboundStreams[streamId]) {
      this.inboundStreams[streamId] = new InboundStream();
    }
    return this.inboundStreams[streamId];
  }

  private markReceived(tsn: number) {
    if (uint32Gte(this.lastReceivedTsn!, tsn) || this.sackMisOrdered.has(tsn)) {
      this.sackDuplicates.push(tsn);
      return true;
    }

    this.sackMisOrdered.add(tsn);
    for (const tsn of [...this.sackMisOrdered].sort()) {
      if (tsn === tsnPlusOne(this.lastReceivedTsn!)) {
        this.lastReceivedTsn = tsn;
      } else {
        break;
      }
    }

    const isObsolete = (x: number) => uint32Gt(x, this.lastReceivedTsn!);

    this.sackDuplicates = this.sackDuplicates.filter(isObsolete);
    this.sackMisOrdered = new Set([...this.sackMisOrdered].filter(isObsolete));

    return false;
  }

  send = async (
    streamId: number,
    ppId: number,
    userData: Buffer,
    {
      expiry,
      maxRetransmits,
      ordered,
    }: {
      expiry?: number | undefined;
      maxRetransmits?: number | undefined;
      ordered?: boolean;
    } = { expiry: undefined, maxRetransmits: undefined, ordered: true },
  ) => {
    const streamSeqNum = ordered ? this.outboundStreamSeq[streamId] || 0 : 0;

    const fragments = Math.ceil(userData.length / USERDATA_MAX_LENGTH);
    let pos = 0;
    const chunks: DataChunk[] = [];
    for (const fragment of range(0, fragments)) {
      const chunk = new DataChunk(0, undefined);
      chunk.flags = 0;
      if (!ordered) {
        chunk.flags = SCTP_DATA_UNORDERED;
      }
      if (fragment === 0) {
        chunk.flags |= SCTP_DATA_FIRST_FRAG;
      }
      if (fragment === fragments - 1) {
        chunk.flags |= SCTP_DATA_LAST_FRAG;
      }
      chunk.tsn = this.localTsn;
      chunk.streamId = streamId;
      chunk.streamSeqNum = streamSeqNum;
      chunk.protocol = ppId;
      chunk.userData = userData.slice(pos, pos + USERDATA_MAX_LENGTH);
      chunk.bookSize = chunk.userData.length;
      chunk.expiry = expiry;
      chunk.maxRetransmits = maxRetransmits;

      pos += USERDATA_MAX_LENGTH;
      this.localTsn = tsnPlusOne(this.localTsn);
      chunks.push(chunk);
    }

    chunks.forEach((chunk) => {
      this.outboundQueue.push(chunk);
    });

    if (ordered) {
      this.outboundStreamSeq[streamId] = uint16Add(streamSeqNum, 1);
    }

    if (!this.timerManager.isRunning(SCTPTimerType.T3)) {
      await this.transmit();
    } else {
      if (this.outboundQueue.length) {
        await this.flush.asPromise();
      } else {
        // unreachable?
        await new Promise((r) => setImmediate(r));
      }
    }
  };

  private async transmit() {
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

  async transmitReconfigRequest() {
    if (
      this.reconfigQueue.length > 0 &&
      this.associationState === SCTP_STATE.ESTABLISHED &&
      !this.reconfigRequest
    ) {
      const streams = this.reconfigQueue.slice(0, RECONFIG_MAX_STREAMS);

      this.reconfigQueue = this.reconfigQueue.slice(RECONFIG_MAX_STREAMS);
      const param = new OutgoingSSNResetRequestParam(
        this.reconfigRequestSeq,
        this.reconfigResponseSeq,
        tsnMinusOne(this.localTsn),
        streams,
      );
      this.reconfigRequestSeq = tsnPlusOne(this.reconfigRequestSeq);

      this.reconfigRequest = param;
      await this.sendReconfigParam(param);
      this.timerReconfigHandleStart();
    }
  }

  async sendReconfigParam(param: StreamParam) {
    log("sendReconfigParam", param);
    const chunk = new ReconfigChunk();
    chunk.params.push([param.type, param.bytes]);
    await this.sendChunk(chunk).catch((err: Error) => {
      log("send reconfig failed", err.message);
    });
  }

  // https://github.com/pion/sctp/pull/44/files
  private async sendResetRequest(streamId: number) {
    log("sendResetRequest", streamId);
    const chunk = new DataChunk(0, undefined);
    chunk.streamId = streamId;
    this.outboundQueue.push(chunk);
    if (!this.timerManager.isRunning(SCTPTimerType.T3)) {
      await this.transmit();
    }
  }

  private flightSizeIncrease(chunk: DataChunk) {
    this.flightSize += chunk.bookSize;
  }

  private flightSizeDecrease(chunk: DataChunk) {
    this.flightSize = Math.max(0, this.flightSize - chunk.bookSize);
  }

  /**Re-configuration Timer */
  private timerReconfigHandleStart() {
    if (this.timerReconfigHandle) return;
    log("timerReconfigHandleStart", { rto: this.rto });
    this.timerReconfigFailures = 0;
    this.timerReconfigHandle = setTimeout(
      this.timerReconfigHandleExpired,
      this.rto * 1000,
    );
  }

  private timerReconfigHandleExpired = async () => {
    this.timerReconfigFailures++;
    // back off
    this.rto = Math.ceil(this.rto * 1.5);

    if (this.timerReconfigFailures > SCTP_MAX_ASSOCIATION_RETRANS) {
      log("timerReconfigFailures", this.timerReconfigFailures);
      this.setState(SCTP_STATE.CLOSED);

      this.timerReconfigHandle = undefined;
    } else if (this.reconfigRequest) {
      log("timerReconfigHandleExpired", this.timerReconfigFailures, this.rto);
      await this.sendReconfigParam(this.reconfigRequest);

      this.timerReconfigHandle = setTimeout(
        this.timerReconfigHandleExpired,
        this.rto * 1000,
      );
    }
  };

  private timerReconfigCancel() {
    if (this.timerReconfigHandle) {
      log("timerReconfigCancel");
      clearTimeout(this.timerReconfigHandle);
      this.timerReconfigHandle = undefined;
    }
  }

  private updateAdvancedPeerAckPoint() {
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

  private maybeAbandon(chunk: DataChunk): boolean {
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

  static getCapabilities() {
    return new RTCSctpCapabilities(65536);
  }

  setRemotePort(port: number) {
    this.remotePort = port;
  }

  async start(remotePort?: number) {
    if (!this.started) {
      this.started = true;
      this.setConnectionState("connecting");

      if (remotePort) {
        this.setRemotePort(remotePort);
      }

      if (!this.isServer) {
        await this.init();
      }
    }
  }

  private async init() {
    const init = new InitChunk();
    init.initiateTag = this.localVerificationTag;
    init.advertisedRwnd = this.advertisedRwnd;
    init.outboundStreams = this._outboundStreamsCount;
    init.inboundStreams = this._inboundStreamsMax;
    init.initialTsn = this.localTsn;
    this.setExtensions(init.params);
    log("send init", init);

    try {
      await this.sendChunk(init);

      // # start T1 timer and enter COOKIE-WAIT state
      this.timerManager.startT1(init);
      this.setState(SCTP_STATE.COOKIE_WAIT);
    } catch (error: any) {
      log("send init failed", error.message);
    }
  }

  private setExtensions(params: [number, Buffer][]) {
    const extensions: number[] = [];
    if (this.localPartialReliability) {
      params.push([SCTP_PRSCTP_SUPPORTED, Buffer.from("")]);
      extensions.push(ForwardTsnChunk.type);
    }

    extensions.push(ReConfigChunk.type);
    params.push([SCTP_SUPPORTED_CHUNK_EXT, Buffer.from(extensions)]);
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

  setState(state: SCTP_STATE) {
    if (state != this.associationState) {
      this.associationState = state;
    }
    if (state === SCTP_STATE.ESTABLISHED) {
      this.setConnectionState("connected");
    } else if (state === SCTP_STATE.CLOSED) {
      this.timerManager.cancelAllTimers();
      this.timerReconfigCancel();
      this.setConnectionState("closed");
      this.removeAllListeners();
    }
  }

  setConnectionState(state: SCTPConnectionState) {
    this.state = state;
    log("setConnectionState", state);
    this.stateChanged[state].execute();
  }

  async stop() {
    if (this.associationState !== SCTP_STATE.CLOSED) {
      await this.abort();
    }
    this.setState(SCTP_STATE.CLOSED);
    this.timerManager.cancelAllTimers();
    clearTimeout(this.timerReconfigHandle);
    this.transport.close();
  }

  async abort() {
    const abort = new AbortChunk();
    await this.sendChunk(abort).catch((err: Error) => {
      log("send abort failed", err.message);
    });
  }

  private removeAllListeners() {
    Object.values(this.stateChanged).forEach((v) => v.allUnsubscribe());
  }
}

export class RTCSctpCapabilities {
  constructor(public maxMessageSize: number) {}
}
