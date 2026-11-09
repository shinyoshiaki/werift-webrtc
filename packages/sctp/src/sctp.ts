import { createHmac, randomBytes } from "crypto";

import { nextTick } from "process";
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
  parsePacket,
  ReConfigChunk,
  ReconfigChunk,
  SackChunk,
  SCTP_COMMON_HEADER_SIZE,
  SCTP_DATA_CHUNK_HEADER_SIZE,
  SCTP_PADDING_MULTIPLE,
  ShutdownAckChunk,
  ShutdownChunk,
  ShutdownCompleteChunk,
  serializePacket,
} from "./chunk";
import { SCTP_STATE } from "./const";
import { createEventsFromList, enumerate, type Unpacked } from "./helper";
import {
  debug,
  Event,
  FifoQueue,
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
  type ReconfigResult,
  reconfigResult,
  StreamAddOutgoingParam,
  type StreamParam,
} from "./param";
import type { Transport } from "./transport";

const log = debug("werift/sctp/sctp");

// SSN: Stream Sequence Number

// # local constants
const COOKIE_LENGTH = 24;
const COOKIE_LIFETIME = 60;
const MAX_STREAMS = 65535;
export const DEFAULT_SCTP_MTU = 1191;

export interface SCTPOptions {
  /** SCTP packet MTU used for outbound DATA chunk fragmentation. */
  mtu?: number;
}

export function maxPayloadSizeForMtu(
  mtu: number,
  dataChunkHeaderSize = SCTP_DATA_CHUNK_HEADER_SIZE,
): number {
  const headerSize = SCTP_COMMON_HEADER_SIZE + dataChunkHeaderSize;
  if (mtu <= headerSize) return 0;
  const payloadBudget = mtu - headerSize;
  return payloadBudget - (payloadBudget % SCTP_PADDING_MULTIPLE);
}

export function validateSctpMtu(mtu: number): void {
  if (!Number.isSafeInteger(mtu) || mtu <= 0) {
    throw new Error("SCTP MTU must be a positive integer");
  }
  if (maxPayloadSizeForMtu(mtu) === 0) {
    throw new Error("SCTP MTU is too small for a DATA chunk");
  }
}

// # protocol constants
const SCTP_DATA_LAST_FRAG = 0x01;
const SCTP_DATA_FIRST_FRAG = 0x02;
const SCTP_DATA_UNORDERED = 0x04;

const SCTP_MAX_ASSOCIATION_RETRANS = 10;
const SCTP_MAX_INIT_RETRANS = 8;
const SCTP_RTO_ALPHA = 1 / 8;
const SCTP_RTO_BETA = 1 / 4;
// RFC 9260 RTO.Initial/RTO.Min/RTO.Max defaults and bounds are in seconds.
const SCTP_RTO_INITIAL = 3;
const SCTP_RTO_MIN = 1;
const SCTP_RTO_MAX = 60;
const SCTP_TSN_MODULO = 2 ** 32;
// RFC 9260 delayed ACK guidance: send SACK within 200ms at the latest.
// Use a small default delay to keep request/response latency low while still delaying ACKs.
const SCTP_SACK_DELAY_MS = 200;
// RFC 9260 HB.interval recommended default is 30 seconds.
const SCTP_HEARTBEAT_INTERVAL = 30;

const RECONFIG_MAX_STREAMS = 135;

// # parameters
const SCTP_STATE_COOKIE = 0x0007;
const SCTP_SUPPORTED_CHUNK_EXT = 0x8008; //32778
const SCTP_PRSCTP_SUPPORTED = 0xc000; //49152

const SCTPConnectionStates = [
  "new",
  "closed",
  "connected",
  "connecting",
] as const;
type SCTPConnectionState = Unpacked<typeof SCTPConnectionStates>;

/** Shared empty payload of abandoned DATA chunks. */
const EMPTY_PAYLOAD = Buffer.alloc(0);

export class SCTP {
  public transport: Transport;
  public port: number;

  flush = new Event<[void]>();
  readonly stateChanged: {
    [key in SCTPConnectionState]: Event<[]>;
  } = createEventsFromList(SCTPConnectionStates);
  readonly onReconfigStreams = new Event<[number[]]>();
  /**streamId: number, ppId: number, data: Buffer */
  readonly onReceive = new Event<[number, number, Buffer]>();
  onSackReceived: () => Promise<void> = async () => {};

  associationState: SCTP_STATE = SCTP_STATE.CLOSED;
  started = false;
  state: SCTPConnectionState = "new";
  isServer = true;
  private isStopping = false;
  private isClosed = false;
  /** An INIT from the peer was accepted (answered with INIT_ACK). */
  private receivedInit = false;

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
  private peerAdvertisedRwnd = this.advertisedRwnd;
  private get peerRwnd() {
    // RFC 9260 §6.2.1(D-ii): available receiver window = a_rwnd - outstanding DATA.
    return Math.max(0, this.peerAdvertisedRwnd - this.flightSize);
  }
  private inboundStreams: { [key: number]: InboundStream } = {};
  _inboundStreamsCount = 0;
  _inboundStreamsMax = MAX_STREAMS;
  private lastReceivedTsn?: number; // Transmission Sequence Number
  private sackDuplicates: number[] = [];
  private sackMisOrdered = new Set<number>();
  private sackNeeded = false;
  private sackPacketCount = 0;
  private sackHasNewDataInPacket = false;
  private sackImmediate = false;
  private sackTimeout: NodeJS.Timeout | undefined;

  // # outbound
  private cwnd: number; // Congestion Window
  readonly mtu: number;
  private readonly maxPayloadSize: number;
  private fastRecoveryExit?: number;
  private fastRecoveryTransmit = false;
  /** FORWARD-TSN kept until the peer's SACK covers it, so a lost one can be resent. */
  private forwardTsnChunk?: ForwardTsnChunk;
  private forwardTsnPending = false;
  private flightSize = 0;
  /** DATA chunks waiting to be transmitted for the first time. */
  readonly outboundQueue = new FifoQueue<DataChunk>();
  /**
   * Pending send() calls in queue order, each waiting for its last chunk to
   * leave outboundQueue. Resolved head-first, so completion is O(1) per call.
   */
  private sendWaiters = new FifoQueue<{
    chunk: DataChunk;
    resolve: () => void;
    /** Resolved out of order because its message expired in outboundQueue. */
    done?: boolean;
  }>();
  private outboundStreamSeq: { [streamId: number]: number } = {};
  _outboundStreamsCount = MAX_STREAMS;
  /**local transmission sequence number */
  private localTsn = Number(random32());
  private lastSackedTsn = tsnMinusOne(this.localTsn);
  private advancedPeerAckTsn = tsnMinusOne(this.localTsn); // acknowledgement
  private partialBytesAcked = 0;
  private sentQueue = new FifoQueue<DataChunk>();
  private transmitting = false;
  private transmitRequested = false;

  // # reconfiguration

  /**初期TSNと同じ値に初期化される単調に増加する数です. これは、新しいre-configuration requestパラメーターを送信するたびに1ずつ増加します */
  reconfigRequestSeq = this.localTsn;
  /**このフィールドは、incoming要求のre-configuration requestシーケンス番号を保持します. 他の場合では、次に予想されるre-configuration requestシーケンス番号から1を引いた値が保持されます */
  reconfigResponseSeq = 0;
  reconfigRequest?: OutgoingSSNResetRequestParam;
  reconfigQueue: number[] = [];
  /** Result returned for the incoming request reconfigResponseSeq; resent to a retransmitted request. */
  private lastReconfigResult?: ReconfigResult;
  /** The peer answered our outstanding reset request with In progress (RFC 6525 §5.2.7). */
  private reconfigRequestInProgress = false;
  /**
   * RFC 6525 §5.2.2 deferred reset: an incoming Outgoing SSN Reset Request whose
   * Sender's Last Assigned TSN has not been received yet. DATA for the reset
   * streams beyond lastTsn belongs to the new streams and is held until the reset.
   */
  private deferredReset?: {
    request: OutgoingSSNResetRequestParam;
    heldChunks: DataChunk[];
  };

  // rtt calculation
  private srtt?: number;
  private rttvar?: number;

  // timers
  private rto = SCTP_RTO_INITIAL;
  /**t1 is wait for initAck or cookieAck */
  private timer1Handle?: any;
  private timer1Chunk?: Chunk;
  private timer1Failures = 0;
  /**t2 is wait for shutdown */
  private timer2Handle?: any;
  private timer2Chunk?: Chunk;
  private timer2Failures = 0;
  /**t3 is wait for data sack */
  private timer3Handle?: any;
  /**
   * Fires at the earliest expiry of a message in outboundQueue, so expired
   * messages are abandoned even if nothing else (SACK, window update, send)
   * runs transmit.
   */
  private outboundExpiryHandle?: ReturnType<typeof setTimeout>;
  private outboundExpiryAt?: number;
  /**Re-configuration Timer */
  private timerReconfigHandle?: any;
  private timerReconfigFailures = 0;
  private timerHeartbeatHandle?: any;
  private heartbeatInterval = SCTP_HEARTBEAT_INTERVAL;

  // etc
  private ssthresh?: number; // slow start threshold

  constructor(transport: Transport, port = 5000, options: SCTPOptions = {}) {
    this.transport = transport;
    this.port = port;
    this.mtu = options.mtu ?? DEFAULT_SCTP_MTU;
    validateSctpMtu(this.mtu);
    this.maxPayloadSize = maxPayloadSizeForMtu(this.mtu);
    this.cwnd = 3 * this.maxPayloadSize;
    this.localPort = this.port;
    this.transport.onData = (buf) => {
      this.handleData(buf);
    };
  }

  private get isStopped() {
    return this.isStopping || this.isClosed;
  }

  get maxChannels() {
    if (this._inboundStreamsCount > 0) {
      return Math.min(this._inboundStreamsCount, this._outboundStreamsCount);
    }
    return undefined;
  }

  static client(transport: Transport, port = 5000, options: SCTPOptions = {}) {
    const sctp = new SCTP(transport, port, options);
    sctp.isServer = false;
    return sctp;
  }

  static server(transport: Transport, port = 5000, options: SCTPOptions = {}) {
    const sctp = new SCTP(transport, port, options);
    sctp.isServer = true;
    return sctp;
  }

  // call from dtls transport
  private async handleData(data: Buffer) {
    if (this.isStopped) return;
    let expectedTag: number;

    const [, , verificationTag, chunks] = parsePacket(data);
    const initChunk = chunks.filter((v) => v.type === InitChunk.type).length;
    if (initChunk > 0) {
      if (chunks.length != 1) {
        throw new Error();
      }
      // RFC 9260 §8.5.1 (A): an INIT carries verification tag 0. An older
      // werift (<= 0.26) that answered our INIT before its own start() then
      // sends its INIT with the tag it learned from ours; only a peer that
      // received our INIT knows that tag, so accept it as well.
      expectedTag =
        verificationTag === this.localVerificationTag
          ? this.localVerificationTag
          : 0;
    } else {
      expectedTag = this.localVerificationTag;
    }

    if (verificationTag !== expectedTag) {
      return;
    }

    this.sackHasNewDataInPacket = false;
    for (const chunk of chunks) {
      await this.receiveChunk(chunk);
    }
    // Messages of this packet are delivered by now, so the last message before
    // the reset boundary reaches onReceive before onReconfigStreams.
    await this.maybePerformDeferredReset();

    if (this.sackNeeded) {
      // RFC 9260 delayed ACK guidance is per packet ("every second packet").
      if (this.sackHasNewDataInPacket) {
        this.sackPacketCount++;
      }
      if (this.sackPacketCount >= 2) {
        this.sackImmediate = true;
      }
      await this.scheduleSack();
    }
  }

  private async scheduleSack() {
    if (this.isStopped) return;
    if (!this.sackNeeded) return;
    if (this.sackImmediate) {
      if (this.sackTimeout) {
        clearTimeout(this.sackTimeout);
        this.sackTimeout = undefined;
      }
      await this.sendSack();
      return;
    }
    if (this.sackTimeout) return;

    // RFC 9260 delayed ACK path: defer SACK, but never beyond 200ms.
    this.sackTimeout = setTimeout(() => {
      this.sackTimeout = undefined;
      this.sendSack().catch((err: Error) => {
        log("send delayed sack failed", err.message);
      });
    }, SCTP_SACK_DELAY_MS);
  }

  private async sendSack() {
    if (this.isStopped) return;
    if (!this.sackNeeded) return;

    const gaps: [number, number][] = [];
    let gapNext: number;
    sortTsns(this.sackMisOrdered, this.lastReceivedTsn!).forEach((tsn) => {
      const pos = tsnDistance(this.lastReceivedTsn!, tsn);
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
    this.sackPacketCount = 0;
    this.sackImmediate = false;
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
          // RFC 9260 §5.2.1: an initiator that receives the peer's INIT in
          // COOKIE-WAIT / COOKIE-ECHOED (both sides sent INIT) answers it
          // with an INIT_ACK.
          if (!this.isServer && !this.isInitiating) return;
          const init = chunk as InitChunk;
          this.receivedInit = true;

          log("receive init", init);
          // Take the peer's initial TSN only before the handshake got past
          // it (CLOSED / COOKIE-WAIT). In COOKIE-ECHOED our INIT_ACK handling
          // already took it, and once ESTABLISHED a delayed duplicate INIT
          // must not rewind the cumulative TSN of DATA received since.
          // A different initiate tag is a restarted peer: start its TSNs over.
          if (
            this.associationState === SCTP_STATE.CLOSED ||
            this.associationState === SCTP_STATE.COOKIE_WAIT ||
            init.initiateTag !== this.remoteVerificationTag
          ) {
            this.lastReceivedTsn = tsnMinusOne(init.initialTsn);
            this.reconfigResponseSeq = tsnMinusOne(init.initialTsn);
            // Reset requests of the previous TSN space no longer apply.
            this.lastReconfigResult = undefined;
            this.deferredReset = undefined;
          }
          this.remoteVerificationTag = init.initiateTag;
          this.ssthresh = init.advertisedRwnd;
          this.peerAdvertisedRwnd = init.advertisedRwnd;
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

          // cookie timestamp は秒単位の整数 (小数を混入させない)
          const time = Math.floor(Date.now() / 1000);
          const cookieTime = Buffer.allocUnsafe(4);
          cookieTime.writeUInt32BE(time, 0);
          let cookie = cookieTime;
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
          this.timer1Cancel();
          this.lastReceivedTsn = tsnMinusOne(initAck.initialTsn);
          this.reconfigResponseSeq = tsnMinusOne(initAck.initialTsn);
          this.remoteVerificationTag = initAck.initiateTag;
          this.ssthresh = initAck.advertisedRwnd;
          this.peerAdvertisedRwnd = initAck.advertisedRwnd;
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
          // Enter COOKIE_ECHOED and arm T1 before handing the chunk off: a
          // duplicate INIT_ACK or an early COOKIE_ACK during the send must see
          // the new state, and a failed send is packet loss that T1 recovers.
          this.timer1Start(echo);
          this.setState(SCTP_STATE.COOKIE_ECHOED);
          await this.sendChunk(echo).catch((err: Error) => {
            log("send echo failed; T1 retransmits", err.message);
          });
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
          this.timer2Cancel();
          this.setState(SCTP_STATE.SHUTDOWN_RECEIVED);
          const ack = new ShutdownAckChunk();
          await this.sendChunk(ack).catch((err: Error) => {
            log("send shutdown ack failed", err.message);
          });
          this.t2Start(ack);
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
          // An initiator accepts the COOKIE_ECHO that follows its INIT_ACK
          // to a colliding INIT (RFC 9260 §5.2.1).
          if (
            !this.isServer &&
            !(
              this.receivedInit &&
              (this.isInitiating ||
                this.associationState === SCTP_STATE.ESTABLISHED)
            )
          ) {
            return;
          }
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
          const now = Math.floor(Date.now() / 1000);
          const stamp = cookie.readUInt32BE(0);
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
          // Our own INIT / COOKIE_ECHO (collision) is superseded by the
          // association the peer's cookie established.
          this.timer1Cancel();
          // RFC 9260 §5.1 (D): move to ESTABLISHED when replying. Hand off the
          // COOKIE_ACK first so it precedes DATA flushed by the connected
          // event. A failed send is packet loss: the initiator retransmits
          // COOKIE_ECHO and this association (same cookie key) answers again.
          const sending = this.sendChunk(ack).catch((err: Error) => {
            log("send cookieAck failed; peer retransmits", err.message);
          });
          if (this.associationState !== SCTP_STATE.ESTABLISHED) {
            this.setState(SCTP_STATE.ESTABLISHED);
          }
          await sending;
        }
        break;
      case CookieAckChunk.type:
        {
          if (this.associationState != SCTP_STATE.COOKIE_ECHOED) return;
          this.timer1Cancel();
          this.setState(SCTP_STATE.ESTABLISHED);
        }
        break;
      case ShutdownCompleteChunk.type:
        {
          if (this.associationState != SCTP_STATE.SHUTDOWN_ACK_SENT) return;
          this.timer2Cancel();
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
          await this.receiveOutgoingSSNResetRequest(
            param as OutgoingSSNResetRequestParam,
          );
        }
        break;
      case ReconfigResponseParam.type:
        {
          const reset = param as ReconfigResponseParam;
          const isCurrentRequest =
            reset.responseSequence === this.reconfigRequest?.requestSequence;
          if (reset.result === reconfigResult.InProgress) {
            if (isCurrentRequest) {
              // The peer deferred the reset (RFC 6525 §5.2.2). Keep the request so the
              // Re-configuration timer retransmits it; the peer answered, so this is
              // not a reachability failure.
              log("OutgoingSSNResetRequestParam in progress");
              this.reconfigRequestInProgress = true;
              // RFC 6525 §5.2.7 H2: restart the timer for this request.
              this.timerReconfigCancel();
              this.timerReconfigHandleStart();
            }
          } else if (
            reset.result !== reconfigResult.ReconfigResultSuccessPerformed
          ) {
            log(
              "OutgoingSSNResetRequestParam failed",
              Object.keys(reconfigResult).find(
                (key) => reconfigResult[key as never] === reset.result,
              ),
            );
          } else if (isCurrentRequest) {
            await this.completeOutgoingReset();
          }
        }
        break;
      case StreamAddOutgoingParam.type:
        {
          const add = param as StreamAddOutgoingParam;
          this._inboundStreamsCount += add.newStreams;
          const res = new ReconfigResponseParam(
            add.requestSequence,
            reconfigResult.ReconfigResultSuccessPerformed,
          );
          this.reconfigResponseSeq = add.requestSequence;
          this.lastReconfigResult = res.result;
          await this.sendReconfigParam(res);
        }
        break;
    }
  }

  /** The peer answered our outstanding reset request with Success - Performed. */
  private async completeOutgoingReset() {
    const streamIds = this.reconfigRequest!.streams.map((streamId) => {
      delete this.outboundStreamSeq[streamId];
      return streamId;
    });

    this.onReconfigStreams.execute(streamIds);

    this.reconfigRequest = undefined;
    this.reconfigRequestInProgress = false;
    this.timerReconfigCancel();
    // Reset RTO backoff on successful reconfiguration
    this.rto = SCTP_RTO_INITIAL;
    this.timerReconfigFailures = 0;
    if (this.reconfigQueue.length > 0) {
      await this.transmitReconfigRequest();
    }
  }

  /** RFC 6525 §4.1: an empty stream list means every stream. */
  private resetTargetStreams(request: OutgoingSSNResetRequestParam) {
    if (request.streams.length > 0) return request.streams;
    return [
      ...new Set([
        ...Object.keys(this.inboundStreams).map(Number),
        ...Object.keys(this.outboundStreamSeq).map(Number),
      ]),
    ];
  }

  /** RFC 6525 §5.2.1 sequence check, then §5.2.2 immediate or deferred reset. */
  private async receiveOutgoingSSNResetRequest(
    request: OutgoingSSNResetRequestParam,
  ) {
    const respond = (result: ReconfigResult) =>
      this.sendReconfigParam(
        new ReconfigResponseParam(request.requestSequence, result),
      );

    if (request.requestSequence === this.reconfigResponseSeq) {
      // Retransmission of an already processed request: resend the same result.
      await respond(
        this.lastReconfigResult ?? reconfigResult.BadSequenceNumber,
      );
      return;
    }

    // Only one request is deferred at a time, so it is the expected one.
    const pending = this.deferredReset;
    const expected = pending
      ? pending.request.requestSequence
      : tsnPlusOne(this.reconfigResponseSeq);
    if (request.requestSequence !== expected) {
      await respond(reconfigResult.BadSequenceNumber);
      return;
    }

    // RFC 6525 §5.2.2 E1: the peer has received our outstanding request. The
    // reset itself completes only with the peer's response, and that response
    // may be lost, so keep retransmitting the request (the peer answers a
    // retransmission with the same result) instead of stopping the timer. The
    // peer is reachable, so like In progress the expiries are not failures.
    if (
      this.reconfigRequest &&
      request.responseSequence === this.reconfigRequest.requestSequence
    ) {
      this.reconfigRequestInProgress = true;
      this.timerReconfigCancel();
      this.timerReconfigHandleStart();
    }

    const target = pending?.request ?? request;
    if (!this.reachedResetBoundary(target)) {
      // Some DATA up to Sender's Last Assigned TSN is still missing. A
      // retransmitted request is evaluated again, so reconfigResponseSeq stays.
      this.deferredReset ??= { request: target, heldChunks: [] };
      await respond(reconfigResult.InProgress);
      return;
    }

    const { transmitReverseReset } = this.performIncomingStreamReset(target);
    await respond(reconfigResult.ReconfigResultSuccessPerformed);
    await transmitReverseReset();
  }

  private reachedResetBoundary(request: OutgoingSSNResetRequestParam) {
    return (
      this.lastReceivedTsn !== undefined &&
      uint32Gte(this.lastReceivedTsn, request.lastTsn)
    );
  }

  private async maybePerformDeferredReset() {
    const pending = this.deferredReset;
    if (!pending || !this.reachedResetBoundary(pending.request)) return;
    // RFC 6525 §5.2.2: answer Success - Performed once the deferred reset is done.
    const { transmitReverseReset } = this.performIncomingStreamReset(
      pending.request,
    );
    await this.sendReconfigParam(
      new ReconfigResponseParam(
        pending.request.requestSequence,
        reconfigResult.ReconfigResultSuccessPerformed,
      ),
    );
    await transmitReverseReset();
  }

  /**
   * Resets the inbound streams of `request` synchronously, so no DATA received
   * while awaiting can reach the old streams. Returns the asynchronous part,
   * the reset of our own outgoing streams.
   */
  private performIncomingStreamReset(request: OutgoingSSNResetRequestParam) {
    const heldChunks =
      this.deferredReset?.request === request
        ? this.deferredReset.heldChunks
        : [];
    this.deferredReset = undefined;
    this.reconfigResponseSeq = request.requestSequence;
    this.lastReconfigResult = reconfigResult.ReconfigResultSuccessPerformed;

    const resetStreams = this.resetTargetStreams(request);
    for (const streamId of resetStreams) {
      const inboundStream = this.inboundStreams[streamId];
      if (inboundStream) {
        // Incomplete messages of the old stream are discarded.
        for (const chunk of inboundStream.reassembly) {
          this.advertisedRwnd += chunk.userData.length;
        }
        delete this.inboundStreams[streamId];
      }
      if (this.outboundStreamSeq[streamId]) {
        // Only add to reconfigQueue if not already present
        if (!this.reconfigQueue.includes(streamId)) {
          this.reconfigQueue.push(streamId);
        }
      }
    }

    // # close data channel
    this.onReconfigStreams.execute(resetStreams);

    // DATA beyond the boundary belongs to the reset streams (SSN starts at 0).
    const streamIds = new Set<number>();
    for (const chunk of heldChunks) {
      this.getInboundStream(chunk.streamId).addChunk(chunk);
      streamIds.add(chunk.streamId);
    }
    for (const streamId of streamIds) {
      this.deliverMessages(this.getInboundStream(streamId));
    }

    return { transmitReverseReset: () => this.transmitReconfigRequest() };
  }

  private deliverMessages(inboundStream: InboundStream) {
    for (const message of inboundStream.popMessages()) {
      this.advertisedRwnd += message[2].length;
      this.receive(...message);
    }
  }

  private receiveDataChunk(chunk: DataChunk) {
    this.sackNeeded = true;

    if (this.markReceived(chunk.tsn)) {
      this.sackImmediate = true;
      return;
    }
    this.sackHasNewDataInPacket = true;
    // RFC 9260 delayed ACK is optional; prefer immediate DATA ACK to keep ACK-clock responsive.
    this.sackImmediate = true;
    if ((chunk.flags & SCTP_DATA_LAST_FRAG) === 0) {
      // Keep fragmented-message feedback prompt to avoid long tail-loss recovery.
      this.sackImmediate = true;
    }
    if (this.sackMisOrdered.size > 0) {
      // RFC 9260 permits immediate SACK on gap/loss indicators.
      this.sackImmediate = true;
    }

    this.advertisedRwnd -= chunk.userData.length;

    const pending = this.deferredReset;
    if (
      pending &&
      (pending.request.streams.length === 0 ||
        pending.request.streams.includes(chunk.streamId)) &&
      uint32Gt(chunk.tsn, pending.request.lastTsn)
    ) {
      // RFC 6525 §5.2.2: hold DATA for the new stream until the reset is performed.
      pending.heldChunks.push(chunk);
      return;
    }

    const inboundStream = this.getInboundStream(chunk.streamId);
    inboundStream.addChunk(chunk);
    this.deliverMessages(inboundStream);
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
      uint32Gte(this.lastSackedTsn, this.sentQueue.peek()!.tsn)
    ) {
      const sChunk = this.sentQueue.shift()!;
      done++;
      if (!sChunk.acked) {
        doneBytes += sChunk.bookSize;
      }
      this.flightSizeDecrease(sChunk);

      if (done === 1 && sChunk.sentCount === 1) {
        this.updateRto(receivedTime - sChunk.sentTime!);
      }
    }
    // # handle gap blocks
    let loss = false;
    const seen = new Set<number>();
    let highestNewlyAcked = chunk.cumulativeTsn;
    if (chunk.gaps.length > 0) {
      let highestSeenTsn: number;
      chunk.gaps.forEach((gap) => {
        for (let pos = gap[0]; pos < gap[1] + 1; pos++) {
          highestSeenTsn = (chunk.cumulativeTsn + pos) % SCTP_TSN_MODULO;
          seen.add(highestSeenTsn);
        }
      });

      for (const sChunk of this.sentQueue) {
        if (uint32Gt(sChunk.tsn, highestSeenTsn!)) {
          break;
        }
        if (seen.has(sChunk.tsn) && !sChunk.acked) {
          doneBytes += sChunk.bookSize;
          sChunk.acked = true;
          sChunk.reneged = false;
          // A pending retransmission is moot once the peer holds the chunk.
          sChunk.retransmit = false;
          this.flightSizeDecrease(sChunk);
          highestNewlyAcked = sChunk.tsn;
        }
      }
    }

    // # detect reneging (RFC 9260 6.2.1 D-iii)
    // A chunk gap-acked before but missing from this SACK was dropped by the
    // peer: it is outstanding again, and every SACK still missing it counts one
    // miss indication towards Fast Retransmit. Chunks up to HTNA are struck by
    // the loop below, so only the ones beyond it are struck here.
    let reneged = false;
    for (const sChunk of this.sentQueue) {
      // Abandoned chunks are never retransmitted nor counted in flight again.
      if (seen.has(sChunk.tsn) || sChunk.abandoned) continue;
      if (sChunk.acked) {
        sChunk.acked = false;
        sChunk.reneged = true;
        // Outstanding again, so it is counted in flight until resent or acked.
        this.flightSizeIncrease(sChunk);
      }
      if (!sChunk.reneged) continue;
      reneged = true;
      if (
        !sChunk.retransmit &&
        (chunk.gaps.length === 0 || uint32Gt(sChunk.tsn, highestNewlyAcked))
      ) {
        loss = this.strikeChunk(sChunk) || loss;
      }
    }

    // # strike missing chunks prior to HTNA
    if (chunk.gaps.length > 0) {
      for (const sChunk of this.sentQueue) {
        if (uint32Gt(sChunk.tsn, highestNewlyAcked)) {
          break;
        }
        if (!seen.has(sChunk.tsn)) {
          loss = this.strikeChunk(sChunk) || loss;
        }
      }
    }

    // # adjust congestion window
    if (this.fastRecoveryExit === undefined) {
      if (done && cwndFullyUtilized) {
        if (this.cwnd <= this.ssthresh!) {
          this.cwnd += Math.min(doneBytes, this.maxPayloadSize);
        } else {
          this.partialBytesAcked += doneBytes;
          if (this.partialBytesAcked >= this.cwnd) {
            this.partialBytesAcked -= this.cwnd;
            this.cwnd += this.maxPayloadSize;
          }
        }
      }
      if (loss) {
        this.ssthresh = Math.max(
          Math.floor(this.cwnd / 2),
          4 * this.maxPayloadSize,
        );
        this.cwnd = this.ssthresh;
        this.partialBytesAcked = 0;
        this.fastRecoveryExit = this.sentQueue.last()!.tsn;
        this.fastRecoveryTransmit = true;
      }
    } else if (uint32Gte(chunk.cumulativeTsn, this.fastRecoveryExit)) {
      this.fastRecoveryExit = undefined;
    }

    if (this.sentQueue.length === 0) {
      this.timer3Cancel();
    } else if (done > 0) {
      this.timer3Restart();
    } else if (reneged && !this.timer3Handle) {
      this.timer3Start();
    }

    // RFC 9260 §6.2.1(D-ii): keep latest peer a_rwnd; available window is derived via flightSize.
    this.peerAdvertisedRwnd = chunk.advertisedRwnd;

    this.updateAdvancedPeerAckPoint();
    this.settleForwardTsn(chunk.cumulativeTsn);
    await this.onSackReceived();
    await this.transmit();
  }

  receiveForwardTsnChunk(chunk: ForwardTsnChunk) {
    this.sackNeeded = true;
    this.sackImmediate = true;

    if (uint32Gte(this.lastReceivedTsn!, chunk.cumulativeTsn)) {
      return;
    }

    const isObsolete = (x: number) => uint32Gt(x, this.lastReceivedTsn!);

    // # advance cumulative TSN
    this.lastReceivedTsn = chunk.cumulativeTsn;
    this.sackMisOrdered = new Set([...this.sackMisOrdered].filter(isObsolete));
    for (const tsn of sortTsns(this.sackMisOrdered, this.lastReceivedTsn)) {
      if (tsn === tsnPlusOne(this.lastReceivedTsn)) {
        this.lastReceivedTsn = tsn;
      } else {
        break;
      }
    }

    // # filter out obsolete entries
    this.sackDuplicates = this.sackDuplicates.filter(isObsolete);
    this.sackMisOrdered = new Set([...this.sackMisOrdered].filter(isObsolete));

    // # update reassembly (RFC 3758 3.6)
    for (const [streamId, streamSeqNum] of chunk.streams) {
      const inboundStream = this.getInboundStream(streamId);

      // # deliver stranded complete messages, drop broken ones, then advance
      const { messages, prunedSize } =
        inboundStream.forwardSequenceNumber(streamSeqNum);
      this.advertisedRwnd += prunedSize;
      for (const message of [...messages, ...inboundStream.popMessages()]) {
        this.advertisedRwnd += message[2].length;
        this.receive(...message);
      }
    }

    // # unordered chunks covered by the cumulative TSN will never complete
    for (const inboundStream of Object.values(this.inboundStreams)) {
      this.advertisedRwnd += inboundStream.pruneUnorderedChunks(
        chunk.cumulativeTsn,
      );
    }
    const pending = this.deferredReset;
    if (pending) {
      pending.heldChunks = pending.heldChunks.filter((held) => {
        // Only DATA the FORWARD-TSN skipped is dropped; later received DATA stays.
        if (uint32Gt(held.tsn, chunk.cumulativeTsn)) return true;
        this.advertisedRwnd += held.userData.length;
        return false;
      });
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
    for (const tsn of sortTsns(this.sackMisOrdered, this.lastReceivedTsn!)) {
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
      /**
       * Absolute time in `Date.now()` epoch milliseconds after which the
       * message is abandoned (PR-SCTP, RFC 3758) if it is still unacknowledged.
       */
      expiry?: number | undefined;
      maxRetransmits?: number | undefined;
      ordered?: boolean;
    } = { expiry: undefined, maxRetransmits: undefined, ordered: true },
  ) => {
    const streamSeqNum = ordered ? this.outboundStreamSeq[streamId] || 0 : 0;

    const fragments = Math.ceil(userData.length / this.maxPayloadSize);
    let pos = 0;
    const chunks: DataChunk[] = [];
    for (let fragment = 0; fragment < fragments; fragment++) {
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
      chunk.userData = userData.slice(pos, pos + this.maxPayloadSize);
      chunk.bookSize = chunk.userData.length;
      chunk.expiry = expiry;
      chunk.maxRetransmits = maxRetransmits;

      pos += this.maxPayloadSize;
      this.localTsn = tsnPlusOne(this.localTsn);
      chunks.push(chunk);
    }

    for (const chunk of chunks) {
      this.outboundQueue.push(chunk);
    }
    if (expiry !== undefined) this.armOutboundExpiry(expiry);

    if (ordered) {
      this.outboundStreamSeq[streamId] = uint16Add(streamSeqNum, 1);
    }

    // Resolves once this call's last chunk is handed to the network (moved to
    // sentQueue), not when the whole outboundQueue drains, so N queued sends
    // do not wake N waiters on every transmit.
    const lastChunk = chunks[chunks.length - 1];
    const sent =
      lastChunk && !this.isStopped
        ? new Promise<void>((resolve) => {
            this.sendWaiters.push({ chunk: lastChunk, resolve });
          })
        : undefined;

    await this.transmit();
    await sent;
  };

  private resolveSendWaiters(sentChunk: DataChunk) {
    this.dropDoneSendWaiters();
    if (this.sendWaiters.peek()?.chunk === sentChunk) {
      this.sendWaiters.shift()!.resolve();
      this.dropDoneSendWaiters();
    }
  }

  private dropDoneSendWaiters() {
    while (this.sendWaiters.peek()?.done) this.sendWaiters.shift();
  }

  /** Resolves the send() of an expired queued message ahead of earlier ones (rare, O(n)). */
  private resolveSendWaiterOutOfOrder(chunk: DataChunk) {
    for (const waiter of this.sendWaiters) {
      if (waiter.chunk === chunk && !waiter.done) {
        waiter.done = true;
        waiter.resolve();
        return;
      }
    }
  }

  /** Settles every pending send() so no caller is left waiting after close. */
  private releaseSendWaiters() {
    const waiters = this.sendWaiters;
    this.sendWaiters = new FifoQueue();
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private async transmit() {
    if (this.isStopped) return;
    if (this.transmitting) {
      this.transmitRequested = true;
      return;
    }

    this.transmitting = true;
    try {
      do {
        this.transmitRequested = false;
        await this.transmitOnce();
      } while (this.transmitRequested);
    } finally {
      this.transmitting = false;
    }
  }

  private async transmitOnce() {
    if (this.isStopped) return;
    // """
    // Transmit outbound data.
    // """

    // # send FORWARD TSN
    if (this.forwardTsnChunk && this.forwardTsnPending) {
      this.forwardTsnPending = false;
      await this.sendChunk(this.forwardTsnChunk).catch((err: Error) => {
        log("send forwardTsn failed", err.message);
      });

      if (!this.timer3Handle) {
        this.timer3Start();
      }
    }

    const burstSize =
      this.fastRecoveryExit != undefined
        ? 2 * this.maxPayloadSize
        : 4 * this.maxPayloadSize;
    const cwnd = Math.min(this.flightSize + burstSize, this.cwnd);

    // Set when expired data is abandoned here, so the FORWARD-TSN goes out.
    let abandoned = false;
    let retransmitEarliest = true;
    for (const dataChunk of this.sentQueue) {
      if (dataChunk.retransmit && (dataChunk.acked || dataChunk.abandoned)) {
        // Acked or abandoned after being marked; nothing to resend.
        dataChunk.retransmit = false;
      }
      if (dataChunk.retransmit) {
        // The lifetime may have run out while the chunk waited for cwnd.
        if (this.isExpired(dataChunk) && this.maybeAbandon(dataChunk)) {
          abandoned = true;
          continue;
        }
        if (this.fastRecoveryTransmit) {
          this.fastRecoveryTransmit = false;
        } else if (this.flightSize >= cwnd) {
          break;
        }
        this.flightSizeIncrease(dataChunk);

        dataChunk.misses = 0;
        dataChunk.retransmit = false;
        dataChunk.reneged = false;
        dataChunk.sentCount++;
        await this.sendChunk(dataChunk).catch((err: Error) => {
          log("send data failed", err.message);
        });

        if (retransmitEarliest) {
          this.timer3Restart();
        }
      }
      retransmitEarliest = false;
    }

    // Drain queued outbound DATA; retransmission pacing is controlled by RTO/T3.
    while (this.outboundQueue.length > 0) {
      const chunk = this.outboundQueue.peek()!;
      // A message that expired while waiting for cwnd/rwnd is never sent; its
      // TSNs are already assigned, so it is abandoned and skipped by FORWARD-TSN.
      // A message the expiry timer already abandoned in place goes the same way.
      if (chunk.abandoned || this.isExpired(chunk)) {
        this.outboundQueue.shift();
        this.sentQueue.push(chunk);
        this.resolveSendWaiters(chunk);
        this.abandonMessage(this.sentQueue.length - 1);
        abandoned = true;
        continue;
      }
      if (this.flightSize >= cwnd || this.peerRwnd <= 0) {
        break;
      }
      if (chunk.bookSize > this.peerRwnd && this.flightSize > 0) {
        break;
      }
      this.outboundQueue.shift();

      this.sentQueue.push(chunk);
      this.resolveSendWaiters(chunk);
      this.flightSizeIncrease(chunk);

      // # update counters
      chunk.sentCount++;
      chunk.sentTime = Date.now() / 1000;

      await this.sendChunk(chunk).catch((err: Error) => {
        log("send data outboundQueue failed", err.message);
      });
      if (!this.timer3Handle) {
        this.timer3Start();
      }
    }
    if (abandoned) {
      this.updateAdvancedPeerAckPoint();
      // Send the FORWARD-TSN in the next round of transmit().
      if (this.forwardTsnPending) this.transmitRequested = true;
    }
    if (this.outboundQueue.length === 0) this.outboundExpiryCancel();
    this.flush.execute();
  }

  async transmitReconfigRequest() {
    if (
      this.reconfigQueue.length > 0 &&
      this.associationState === SCTP_STATE.ESTABLISHED &&
      !this.reconfigRequest
    ) {
      // Remove duplicate stream IDs from reconfigQueue
      const uniqueStreams = [...new Set(this.reconfigQueue)];
      const streams = uniqueStreams.slice(0, RECONFIG_MAX_STREAMS);

      this.reconfigQueue = uniqueStreams.slice(RECONFIG_MAX_STREAMS);
      const param = new OutgoingSSNResetRequestParam(
        this.reconfigRequestSeq,
        this.reconfigResponseSeq,
        tsnMinusOne(this.localTsn),
        streams,
      );
      this.reconfigRequestSeq = tsnPlusOne(this.reconfigRequestSeq);

      this.reconfigRequest = param;
      this.reconfigRequestInProgress = false;
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
    if (!this.timer3Handle) {
      await this.transmit();
    }
  }

  // flightSize always equals the bookSize sum of inFlight chunks in sentQueue,
  // so both helpers are idempotent per chunk.
  private flightSizeIncrease(chunk: DataChunk) {
    if (chunk.inFlight) return;
    chunk.inFlight = true;
    this.flightSize += chunk.bookSize;
  }

  /** No-op for chunks not counted in flightSize, so every exit path can call it. */
  private flightSizeDecrease(chunk: DataChunk) {
    if (!chunk.inFlight) return;
    chunk.inFlight = false;
    this.flightSize -= chunk.bookSize;
  }

  // # timers

  /**t1 is wait for initAck or cookieAck */
  private timer1Start(chunk: Chunk) {
    if (this.timer1Handle) throw new Error();
    this.timer1Chunk = chunk;
    this.timer1Failures = 0;
    this.timer1Handle = setTimeout(this.timer1Expired, this.rto * 1000);
  }

  private timer1Expired = () => {
    if (this.isStopped) return;
    this.timer1Failures++;
    this.timer1Handle = undefined;
    if (this.timer1Failures > SCTP_MAX_INIT_RETRANS) {
      this.setState(SCTP_STATE.CLOSED);
    } else {
      setImmediate(() => {
        if (this.isStopped) return;
        this.sendChunk(this.timer1Chunk!).catch((err: Error) => {
          log("send timer1 chunk failed", err.message);
        });
      });
      if (this.isStopped) return;
      this.timer1Handle = setTimeout(this.timer1Expired, this.rto * 1000);
    }
  };

  private timer1Cancel() {
    if (this.timer1Handle) {
      clearTimeout(this.timer1Handle);
      this.timer1Handle = undefined;
      this.timer1Chunk = undefined;
    }
  }

  /**t2 is wait for shutdown */
  private t2Start(chunk: Chunk) {
    if (this.timer2Handle) throw new Error();
    this.timer2Chunk = chunk;
    this.timer2Failures = 0;
    this.timer2Handle = setTimeout(this.timer2Expired, this.rto * 1000);
  }

  private timer2Expired = () => {
    if (this.isStopped) return;
    this.timer2Failures++;
    this.timer2Handle = undefined;
    if (this.timer2Failures > SCTP_MAX_ASSOCIATION_RETRANS) {
      this.setState(SCTP_STATE.CLOSED);
    } else {
      setImmediate(() => {
        if (this.isStopped) return;
        this.sendChunk(this.timer2Chunk!).catch((err: Error) => {
          log("send timer2Chunk failed", err.message);
        });
      });
      if (this.isStopped) return;
      this.timer2Handle = setTimeout(this.timer2Expired, this.rto * 1000);
    }
  };

  private timer2Cancel() {
    if (this.timer2Handle) {
      clearTimeout(this.timer2Handle);
      this.timer2Handle = undefined;
      this.timer2Chunk = undefined;
    }
  }

  /**t3 is wait for data sack */
  private timer3Start() {
    if (this.isStopped) return;
    if (this.timer3Handle) throw new Error();
    // RFC 9260 T3-rtx runs on current RTO; rto is stored in seconds.
    this.timer3Handle = setTimeout(this.timer3Expired, this.rto * 1000);
  }

  private timer3Restart() {
    if (this.isStopped) return;
    this.timer3Cancel();
    // RFC 9260 requires restarting T3-rtx with current RTO (seconds -> JS ms).
    this.timer3Handle = setTimeout(this.timer3Expired, this.rto * 1000);
  }

  private timer3Expired = () => {
    if (this.isStopped) return;
    this.timer3Handle = undefined;

    // # mark retransmit or abandoned chunks
    // RFC 9260 §6.3.3 (E3): only outstanding chunks; gap-acked ones are kept
    // for reneging but not retransmitted.
    this.sentQueue.forEach((chunk) => {
      if (chunk.acked || chunk.abandoned) return;
      if (!this.maybeAbandon(chunk)) {
        chunk.retransmit = true;
      }
      this.flightSizeDecrease(chunk);
    });
    this.updateAdvancedPeerAckPoint();
    // An unacknowledged FORWARD-TSN may have been lost; resend it.
    if (this.forwardTsnChunk) {
      this.forwardTsnPending = true;
    }

    // # adjust congestion window
    this.fastRecoveryExit = undefined;
    this.partialBytesAcked = 0;

    this.ssthresh = Math.max(
      Math.floor(this.cwnd / 2),
      4 * this.maxPayloadSize,
    );
    this.cwnd = this.maxPayloadSize;

    this.transmit();
  };

  /** Arms the outbound expiry timer for `expiry` unless an earlier one is armed. */
  private armOutboundExpiry(expiry: number) {
    if (this.isStopped) return;
    if (this.outboundExpiryHandle && this.outboundExpiryAt! <= expiry) return;
    this.outboundExpiryCancel();
    this.outboundExpiryAt = expiry;
    this.outboundExpiryHandle = setTimeout(
      this.outboundExpiryExpired,
      // setTimeout overflows above 2^31 - 1 ms; a later expiry re-arms on fire.
      Math.min(Math.max(0, expiry - Date.now()), 0x7fffffff),
    );
  }

  /**
   * Abandons every expired message still in outboundQueue, wherever it is.
   * Chunks stay in place so TSN order is kept: transmit() moves them to
   * sentQueue unsent when they reach the head, and FORWARD-TSN skips them.
   * Their send() resolves now, without waiting for earlier messages.
   */
  private outboundExpiryExpired = () => {
    this.outboundExpiryHandle = undefined;
    this.outboundExpiryAt = undefined;
    if (this.isStopped) return;
    let nextExpiry: number | undefined;
    for (const chunk of this.outboundQueue) {
      if (chunk.abandoned || chunk.expiry === undefined) continue;
      if (this.isExpired(chunk)) {
        this.markAbandoned(chunk);
        this.resolveSendWaiterOutOfOrder(chunk);
      } else if (nextExpiry === undefined || chunk.expiry < nextExpiry) {
        nextExpiry = chunk.expiry;
      }
    }
    if (nextExpiry !== undefined) this.armOutboundExpiry(nextExpiry);
    this.transmit().catch((err: Error) => {
      log("transmit on outbound expiry failed", err.message);
    });
  };

  private outboundExpiryCancel() {
    if (this.outboundExpiryHandle) {
      clearTimeout(this.outboundExpiryHandle);
      this.outboundExpiryHandle = undefined;
    }
    this.outboundExpiryAt = undefined;
  }

  private timer3Cancel() {
    if (this.timer3Handle) {
      clearTimeout(this.timer3Handle);
      this.timer3Handle = undefined;
    }
  }

  /**Re-configuration Timer */
  private timerReconfigHandleStart() {
    if (this.isStopped) return;
    if (this.timerReconfigHandle) return;
    log("timerReconfigHandleStart", { rto: this.rto });
    this.timerReconfigFailures = 0;
    this.timerReconfigHandle = setTimeout(
      this.timerReconfigHandleExpired,
      this.rto * 1000,
    );
  }

  private timerReconfigHandleExpired = async () => {
    if (this.isStopped) return;
    // RFC 6525 §5.2.7: no error count while the peer reports In progress.
    if (this.reconfigRequestInProgress) this.timerReconfigFailures = 0;
    else this.timerReconfigFailures++;
    // back off
    this.rto = Math.min(Math.ceil(this.rto * 1.5), SCTP_RTO_MAX);

    if (this.timerReconfigFailures > SCTP_MAX_ASSOCIATION_RETRANS) {
      log("timerReconfigFailures", this.timerReconfigFailures);
      this.setState(SCTP_STATE.CLOSED);

      this.timerReconfigHandle = undefined;
    } else if (this.reconfigRequest) {
      log("timerReconfigHandleExpired", this.timerReconfigFailures, this.rto);
      await this.sendReconfigParam(this.reconfigRequest);
      if (this.isStopped) return;

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
      // Reset failures counter when timer is successfully cancelled
      this.timerReconfigFailures = 0;
    }
  }

  private heartbeatStart() {
    if (
      this.timerHeartbeatHandle ||
      this.associationState !== SCTP_STATE.ESTABLISHED
    ) {
      return;
    }
    // RFC 9260 heartbeat timer is based on RTO + HB.interval for idle paths.
    this.timerHeartbeatHandle = setTimeout(
      this.timerHeartbeatExpired,
      (this.rto + this.heartbeatInterval) * 1000,
    );
  }

  private heartbeatRestart() {
    this.heartbeatCancel();
    this.heartbeatStart();
  }

  private heartbeatCancel() {
    if (this.timerHeartbeatHandle) {
      clearTimeout(this.timerHeartbeatHandle);
      this.timerHeartbeatHandle = undefined;
    }
  }

  private timerHeartbeatExpired = async () => {
    this.timerHeartbeatHandle = undefined;
    if (this.associationState !== SCTP_STATE.ESTABLISHED) return;

    if (this.flightSize === 0 && this.outboundQueue.length === 0) {
      const heartbeat = new HeartbeatChunk();
      const heartbeatTime = Buffer.allocUnsafe(4);
      heartbeatTime.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
      heartbeat.params.push([1, heartbeatTime]);
      await this.sendChunk(heartbeat).catch((err: Error) => {
        log("send heartbeat failed", err.message);
      });
    }
    this.heartbeatStart();
  };

  setHeartbeatInterval(interval: number) {
    if (interval <= 0) {
      throw new Error("heartbeat interval must be > 0");
    }
    this.heartbeatInterval = interval;
    this.heartbeatRestart();
  }

  /** Drops the FORWARD-TSN once acknowledged; otherwise keeps T3 running to resend it. */
  private settleForwardTsn(sackedTsn: number) {
    if (!this.forwardTsnChunk) return;
    if (uint32Gte(sackedTsn, this.forwardTsnChunk.cumulativeTsn)) {
      this.forwardTsnChunk = undefined;
      this.forwardTsnPending = false;
      if (this.sentQueue.length === 0) this.timer3Cancel();
    } else if (!this.timer3Handle) {
      this.timer3Start();
    }
  }

  private updateAdvancedPeerAckPoint() {
    if (uint32Gt(this.lastSackedTsn, this.advancedPeerAckTsn)) {
      this.advancedPeerAckTsn = this.lastSackedTsn;
    }

    let done = 0;
    // Carry over streams of an unacknowledged FORWARD-TSN that this one replaces.
    const streams: { [key: number]: number } = Object.fromEntries(
      this.forwardTsnChunk?.streams ?? [],
    );
    while (this.sentQueue.length > 0 && this.sentQueue.peek()!.abandoned) {
      const chunk = this.sentQueue.shift()!;
      this.flightSizeDecrease(chunk);
      this.advancedPeerAckTsn = chunk.tsn;
      done++;
      if (!(chunk.flags & SCTP_DATA_UNORDERED)) {
        streams[chunk.streamId] = chunk.streamSeqNum;
      }
    }
    if (done) {
      this.forwardTsnPending = true;
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
    // The peer already holds an acked chunk (gap SACK); abandoning it would
    // make the FORWARD-TSN discard data the receiver could deliver.
    if (chunk.acked) return false;
    const abandon =
      (!!chunk.maxRetransmits && chunk.maxRetransmits < chunk.sentCount!) ||
      this.isExpired(chunk);
    if (!abandon) return false;

    const chunkPos = this.sentQueue.findIndex((v) => v === chunk);
    if (chunkPos < 0) return false;
    this.abandonMessage(chunkPos);
    return true;
  }

  /** Counts a miss indication; on the third, marks the chunk for Fast Retransmit (or abandons it). */
  private strikeChunk(chunk: DataChunk) {
    chunk.misses++;
    if (chunk.misses < 3) return false;
    chunk.misses = 0;
    if (!this.maybeAbandon(chunk)) {
      chunk.retransmit = true;
    }
    chunk.acked = false;
    this.flightSizeDecrease(chunk);
    return true;
  }

  private isExpired(chunk: DataChunk) {
    return chunk.expiry !== undefined && chunk.expiry <= Date.now();
  }

  /**
   * An abandoned chunk is never sent or retransmitted again, so its payload is
   * released; bookSize and the TSN / stream metadata FORWARD-TSN needs stay.
   */
  private markAbandoned(chunk: DataChunk) {
    chunk.abandoned = true;
    chunk.retransmit = false;
    chunk.userData = EMPTY_PAYLOAD;
  }

  /** Marks every fragment of the message at sentQueue[chunkPos] abandoned. */
  private abandonMessage(chunkPos: number) {
    // Abandon the whole message: walk back to its first fragment and forward
    // to its last fragment (RFC 3758 3.5 A3).
    for (let pos = chunkPos; pos >= 0; pos--) {
      const oChunk = this.sentQueue.at(pos)!;
      this.markAbandoned(oChunk);
      this.flightSizeDecrease(oChunk);
      if (oChunk.flags & SCTP_DATA_FIRST_FRAG) {
        break;
      }
    }

    let lastFragReached = false;
    for (let pos = chunkPos; pos < this.sentQueue.length; pos++) {
      const oChunk = this.sentQueue.at(pos)!;
      this.markAbandoned(oChunk);
      this.flightSizeDecrease(oChunk);
      if (oChunk.flags & SCTP_DATA_LAST_FRAG) {
        lastFragReached = true;
        break;
      }
    }

    // The remaining fragments may still be waiting in outboundQueue (cwnd/rwnd
    // limited). Sending them would leave the receiver with a headless message,
    // so move them to sentQueue as abandoned without transmitting; they are then
    // covered by the FORWARD-TSN like the rest of the message.
    while (!lastFragReached && this.outboundQueue.length > 0) {
      const oChunk = this.outboundQueue.shift()!;
      this.markAbandoned(oChunk);
      this.sentQueue.push(oChunk);
      this.resolveSendWaiters(oChunk);
      if (oChunk.flags & SCTP_DATA_LAST_FRAG) {
        lastFragReached = true;
      }
    }
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
      // Keep "connected" when the peer's INIT already established it.
      if (this.associationState !== SCTP_STATE.ESTABLISHED) {
        this.setConnectionState("connecting");
      }

      if (remotePort) {
        this.setRemotePort(remotePort);
      }

      // The peer's INIT may already have established the association
      // before start(); a new INIT would reset it.
      if (!this.isServer && this.associationState === SCTP_STATE.CLOSED) {
        await this.init();
      }
    }
  }

  /** Waiting for INIT_ACK / COOKIE_ACK of our own INIT. */
  private get isInitiating() {
    return (
      this.associationState === SCTP_STATE.COOKIE_WAIT ||
      this.associationState === SCTP_STATE.COOKIE_ECHOED
    );
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

    // # start T1 timer and enter COOKIE-WAIT state
    // Before handing INIT off, so an INIT_ACK that arrives while the send is
    // still pending is not dropped by the COOKIE_WAIT guard, and a failed
    // send is packet loss that T1 retransmits (or closes after max retries).
    this.timer1Start(init);
    this.setState(SCTP_STATE.COOKIE_WAIT);
    try {
      await this.sendChunk(init);
    } catch (error: any) {
      log("send init failed; T1 retransmits", error?.message);
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
      // RFC 9260 §8.5.1: INIT is always sent with verification tag 0, also
      // when an INIT answered before start() taught us the peer's tag.
      chunk.type === InitChunk.type ? 0 : this.remoteVerificationTag,
      chunk,
    );
    await this.transport.send(packet);
  }

  setState(state: SCTP_STATE) {
    if (state != this.associationState) {
      this.associationState = state;
    }
    if (state === SCTP_STATE.ESTABLISHED) {
      this.isStopping = false;
      this.isClosed = false;
      this.setConnectionState("connected");
      this.heartbeatStart();
    } else if (state === SCTP_STATE.CLOSED) {
      this.isClosed = true;
      this.timer1Cancel();
      this.timer2Cancel();
      this.timer3Cancel();
      this.timerReconfigCancel();
      this.heartbeatCancel();
      this.outboundExpiryCancel();
      if (this.sackTimeout) {
        clearTimeout(this.sackTimeout);
        this.sackTimeout = undefined;
      }
      // Drop a deferred incoming stream reset and the DATA held for it.
      this.deferredReset = undefined;
      this.setConnectionState("closed");
      this.removeAllListeners();
      this.releaseSendWaiters();
    }
  }

  setConnectionState(state: SCTPConnectionState) {
    this.state = state;
    log("setConnectionState", state);
    this.stateChanged[state].execute();
  }

  async stop() {
    if (this.isStopped) {
      this.setState(SCTP_STATE.CLOSED);
      return;
    }
    this.isStopping = true;
    this.transport.onData = undefined;
    if (this.sackTimeout) {
      clearTimeout(this.sackTimeout);
      this.sackTimeout = undefined;
    }
    if (this.associationState !== SCTP_STATE.CLOSED) {
      await this.abort();
    }
    this.setState(SCTP_STATE.CLOSED);
    clearTimeout(this.timer1Handle);
    clearTimeout(this.timer2Handle);
    clearTimeout(this.timer3Handle);
    this.outboundExpiryCancel();
    clearTimeout(this.timerReconfigHandle);
    clearTimeout(this.timerHeartbeatHandle);
    clearTimeout(this.sackTimeout);
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

export class InboundStream {
  reassembly: DataChunk[] = [];
  streamSequenceNumber = 0; // SSN

  constructor() {}

  addChunk(chunk: DataChunk) {
    if (
      this.reassembly.length === 0 ||
      uint32Gt(chunk.tsn, this.reassembly[this.reassembly.length - 1].tsn)
    ) {
      this.reassembly.push(chunk);
      return;
    }

    for (const [i, v] of enumerate(this.reassembly)) {
      if (v.tsn === chunk.tsn) throw new Error("duplicate chunk in reassembly");

      if (uint32Gt(v.tsn, chunk.tsn)) {
        this.reassembly.splice(i, 0, chunk);
        break;
      }
    }
  }

  *popMessages(): Generator<[number, number, Buffer]> {
    let pos = 0;
    let startPos: number | undefined;
    let expectedTsn: number;
    let ordered: boolean | undefined;
    while (pos < this.reassembly.length) {
      const chunk = this.reassembly[pos];
      if (startPos === undefined) {
        ordered = !(chunk.flags & SCTP_DATA_UNORDERED);
        if (!(chunk.flags & SCTP_DATA_FIRST_FRAG)) {
          if (ordered) {
            break;
          } else {
            pos++;
            continue;
          }
        }
        if (
          ordered &&
          uint16Gt(chunk.streamSeqNum, this.streamSequenceNumber)
        ) {
          break;
        }
        expectedTsn = chunk.tsn;
        startPos = pos;
      } else if (chunk.tsn !== expectedTsn!) {
        if (ordered!) {
          break;
        } else {
          // The partial message is broken; this chunk may start the next one.
          startPos = undefined;
          continue;
        }
      }

      if (chunk.flags & SCTP_DATA_LAST_FRAG) {
        const arr = this.reassembly
          .slice(startPos, pos + 1)
          .map((c) => c.userData)
          .reduce((acc, cur) => {
            acc.push(cur);
            acc.push(Buffer.from(""));
            return acc;
          }, [] as Buffer[]);
        arr.pop();
        const userData = Buffer.concat(arr);

        this.reassembly = [
          ...this.reassembly.slice(0, startPos),
          ...this.reassembly.slice(pos + 1),
        ];
        if (ordered && chunk.streamSeqNum === this.streamSequenceNumber) {
          this.streamSequenceNumber = uint16Add(this.streamSequenceNumber, 1);
        }
        // The next message starts at the removed one's position and need not
        // be TSN-contiguous with it, so restart the search there.
        pos = startPos;
        startPos = undefined;
        yield [chunk.streamId, chunk.protocol, userData];
        continue;
      } else {
        pos++;
      }
      expectedTsn = tsnPlusOne(expectedTsn);
    }
  }

  /**
   * Applies a FORWARD-TSN entry (RFC 3758 3.6): ordered messages with SSN up to
   * `ssn` are no longer waited for. Complete ones are returned for delivery in
   * order, incomplete ones are dropped, and the expected SSN moves past `ssn`
   * (never backwards, so a stale/duplicated entry is harmless).
   */
  forwardSequenceNumber(ssn: number) {
    const messages: [number, number, Buffer][] = [];
    let prunedSize = 0;
    let fragments: DataChunk[] = [];
    const dropFragments = () => {
      for (const c of fragments) prunedSize += c.userData.length;
      fragments = [];
    };

    this.reassembly = this.reassembly.filter((chunk) => {
      if (
        chunk.flags & SCTP_DATA_UNORDERED ||
        uint16Gt(chunk.streamSeqNum, ssn)
      ) {
        return true;
      }
      const prev = fragments[fragments.length - 1];
      if (chunk.flags & SCTP_DATA_FIRST_FRAG) {
        dropFragments();
      } else if (
        !prev ||
        chunk.tsn !== tsnPlusOne(prev.tsn) ||
        chunk.streamSeqNum !== prev.streamSeqNum
      ) {
        dropFragments();
        prunedSize += chunk.userData.length;
        return false;
      }
      fragments.push(chunk);
      if (chunk.flags & SCTP_DATA_LAST_FRAG) {
        messages.push([
          chunk.streamId,
          chunk.protocol,
          Buffer.concat(fragments.map((c) => c.userData)),
        ]);
        fragments = [];
      }
      return false;
    });
    dropFragments();

    const nextSsn = uint16Add(ssn, 1);
    if (uint16Gt(nextSsn, this.streamSequenceNumber)) {
      this.streamSequenceNumber = nextSsn;
    }
    return { messages, prunedSize };
  }

  /** Removes unordered chunks with TSN up to `tsn`. */
  pruneUnorderedChunks(tsn: number) {
    let size = 0;
    this.reassembly = this.reassembly.filter((chunk) => {
      if (chunk.flags & SCTP_DATA_UNORDERED && uint32Gte(tsn, chunk.tsn)) {
        size += chunk.userData.length;
        return false;
      }
      return true;
    });
    return size;
  }

  pruneChunks(tsn: number) {
    // """
    // Prune chunks up to the given TSN.
    // """

    let pos = -1,
      size = 0;

    for (const [i, chunk] of this.reassembly.entries()) {
      if (uint32Gte(tsn, chunk.tsn)) {
        pos = i;
        size += chunk.userData.length;
      } else {
        break;
      }
    }

    this.reassembly = this.reassembly.slice(pos + 1);
    return size;
  }
}

export class RTCSctpCapabilities {
  public maxMessageSize: number;

  constructor(maxMessageSize: number) {
    this.maxMessageSize = maxMessageSize;
  }
}

function tsnMinusOne(a: number) {
  return (a - 1 + SCTP_TSN_MODULO) % SCTP_TSN_MODULO;
}

/** Serial-number distance from `base` to `tsn` (RFC 1982), 0..2^32-1. */
function tsnDistance(base: number, tsn: number) {
  return (tsn - base + SCTP_TSN_MODULO) % SCTP_TSN_MODULO;
}

/** Sorts TSNs in serial-number order after `base`, so the order holds across a wrap. */
function sortTsns(tsns: Iterable<number>, base: number) {
  return [...tsns].sort((a, b) => tsnDistance(base, a) - tsnDistance(base, b));
}

function tsnPlusOne(a: number) {
  return (a + 1) % SCTP_TSN_MODULO;
}
