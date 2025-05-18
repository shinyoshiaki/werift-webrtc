import { createHmac, randomBytes } from "crypto";
import { jspack } from "@shinyoshiaki/jspack";

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
} from "./chunk";
import {
  COOKIE_LENGTH,
  COOKIE_LIFETIME,
  SCTP_MAX_ASSOCIATION_RETRANS,
  SCTP_PRSCTP_SUPPORTED,
  SCTP_STATE,
  SCTP_STATE_COOKIE,
  SCTP_SUPPORTED_CHUNK_EXT,
  SCTP_TSN_MODULO,
} from "./const";
import { createEventsFromList } from "./helper";
import {
  Event,
  EventDisposer,
  debug,
  random32,
  uint32Gt,
  uint32Gte,
} from "./imports/common";
import {
  OutgoingSSNResetRequestParam,
  RECONFIG_PARAM_BY_TYPES,
  ReconfigResponseParam,
  StreamAddOutgoingParam,
  type StreamParam,
} from "./param";
import { SctpReconfig } from "./reconfig";
import { StreamManager } from "./stream";
import { SCTPTimerManager } from "./timer";
import {
  type SCTPConnectionState,
  SCTPConnectionStates,
  SCTPTransmitter,
} from "./transmitter";
import type { Transport } from "./transport";
import { tsnMinusOne, tsnPlusOne } from "./util";

const log = debug("werift/sctp/sctp");

// SSN: Stream Sequence Number

export class SCTP {
  associationState = SCTP_STATE.CLOSED;
  started = false;
  isServer = true;

  private readonly hmacKey = randomBytes(16);
  private readonly localPartialReliability = true;
  private readonly localVerificationTag = random32();

  remoteExtensions: number[] = [];
  remotePartialReliability = true;

  private lastReceivedTsn?: number; // Transmission Sequence Number
  private sackDuplicates: number[] = [];
  private sackMisOrdered = new Set<number>();
  private sackNeeded = false;
  private sackTimeout: NodeJS.Immediate | undefined;

  readonly transmitter: SCTPTransmitter;
  readonly timerManager: SCTPTimerManager;
  readonly reconfig: SctpReconfig;
  readonly stream = new StreamManager();

  readonly stateChanged: {
    [key in SCTPConnectionState]: Event<[]>;
  } = createEventsFromList(SCTPConnectionStates);
  readonly onReconfigStreams = new Event<[number[]]>();
  /**streamId: number, ppId: number, data: Buffer */
  readonly onReceive = new Event<[number, number, Buffer]>();
  onSackReceived: () => Promise<void> = async () => {};
  private disposer = new EventDisposer();

  constructor(
    public transport: Transport,
    public port = 5000,
  ) {
    this.transport.onData = (buf) => {
      this.handleData(buf);
    };
    this.timerManager = new SCTPTimerManager({
      sendChunk: async (chunk) => {
        await this.transmitter.sendChunk(chunk);
      },
    });
    this.transmitter = new SCTPTransmitter(transport, this.timerManager, port);
    this.reconfig = new SctpReconfig(this.transmitter, this.timerManager);

    this.timerManager.onT1Expired.subscribe(() => {
      this.setState(SCTP_STATE.CLOSED);
    });
    this.timerManager.onT2Expired.subscribe(() => {
      this.setState(SCTP_STATE.CLOSED);
    });
    this.timerManager.onReconfigExpired.subscribe(async (reconfigFailures) => {
      if (reconfigFailures > SCTP_MAX_ASSOCIATION_RETRANS) {
        log("timerReconfigFailures", reconfigFailures);
        this.setState(SCTP_STATE.CLOSED);
      }
    });

    this.transmitter.onStateChanged
      .subscribe((state) => {
        this.stateChanged[state]?.execute?.();
      })
      .disposer(this.disposer);
    this.transmitter.onSackReceived = async () => {
      await this.onSackReceived?.();
    };

    this.reconfig.onReconfigStreams.pipe(this.onReconfigStreams);

    this.stream.onReceive.pipe(this.onReceive);
  }

  get maxChannels() {
    return this.stream.maxChannels;
  }

  get state() {
    return this.transmitter.state;
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
    let gapNext: number | undefined;
    for (const tsn of [...this.sackMisOrdered].sort()) {
      const pos = (tsn - this.lastReceivedTsn!) % SCTP_TSN_MODULO;
      if (tsn === gapNext) {
        gaps[gaps.length - 1][1] = pos;
      } else {
        gaps.push([pos, pos]);
      }
      gapNext = tsnPlusOne(tsn);
    }

    const sack = new SackChunk(0, undefined);
    sack.cumulativeTsn = this.lastReceivedTsn!;
    sack.advertisedRwnd = Math.max(0, this.stream.advertisedRwnd);
    sack.duplicates = [...this.sackDuplicates];
    sack.gaps = gaps;

    await this.transmitter.sendChunk(sack).catch((err: Error) => {
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
          this.reconfig.updateReconfigResponseSeq(tsnMinusOne(init.initialTsn));
          this.transmitter.handleInitChunk(init);
          this.getExtensions(init.params);

          this.stream.updateStreamsCount(init);

          const ack = new InitAckChunk();
          ack.initiateTag = this.localVerificationTag;
          ack.advertisedRwnd = this.stream.advertisedRwnd;
          ack.outboundStreams = this.stream._outboundStreamsCount;
          ack.inboundStreams = this.stream._inboundStreamsCount;
          ack.initialTsn = this.transmitter.localTsn;
          this.setExtensions(ack.params);

          const time = Date.now() / 1000;
          let cookie = Buffer.from(jspack.Pack("!L", [time]));
          cookie = Buffer.concat([
            cookie,
            createHmac("sha1", this.hmacKey).update(cookie).digest(),
          ]);
          ack.params.push([SCTP_STATE_COOKIE, cookie]);
          log("send initAck", ack);
          await this.transmitter.sendChunk(ack).catch((err: Error) => {
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
          this.reconfig.updateReconfigResponseSeq(
            tsnMinusOne(initAck.initialTsn),
          );
          this.transmitter.handleInitChunk(initAck);
          this.getExtensions(initAck.params);

          this.stream.updateStreamsCount(initAck);

          const echo = new CookieEchoChunk();
          for (const [k, v] of initAck.params) {
            if (k === SCTP_STATE_COOKIE) {
              echo.body = v;
              break;
            }
          }
          await this.transmitter.sendChunk(echo).catch((err: Error) => {
            log("send echo failed", err.message);
          });

          this.timerManager.startT1(echo);
          this.setState(SCTP_STATE.COOKIE_ECHOED);
        }
        break;
      case SackChunk.type:
        {
          await this.transmitter.receiveSackChunk(chunk as SackChunk);
        }
        break;
      case HeartbeatChunk.type:
        {
          const ack = new HeartbeatAckChunk();
          ack.params = (chunk as HeartbeatChunk).params;
          await this.transmitter.sendChunk(ack).catch((err: Error) => {
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
          await this.transmitter.sendChunk(ack).catch((err: Error) => {
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

          const res = handleCookieEchoChunk(
            chunk as CookieEchoChunk,
            this.hmacKey,
          );

          if (res instanceof ErrorChunk) {
            await this.transmitter.sendChunk(res).catch((err: Error) => {
              log("send errorChunk failed", err.message);
            });
          } else if (res instanceof CookieAckChunk) {
            await this.transmitter.sendChunk(res).catch((err: Error) => {
              log("send cookieAck failed", err.message);
            });
          }

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
          const streams = await this.reconfig.handleOutgoingSSNResetRequest(
            param as OutgoingSSNResetRequestParam,
            this.stream.outboundStreamSeq,
            this.associationState,
          );
          for (const streamId of streams) {
            this.stream.removeInboundStream(streamId);
          }
        }
        break;
      case ReconfigResponseParam.type:
        {
          const streams = await this.reconfig.handleReconfigResponse(
            param as ReconfigResponseParam,
            this.associationState,
          );
          for (const streamId of streams ?? []) {
            this.stream.removeOutboundStreamSeq(streamId);
          }
        }
        break;
      case StreamAddOutgoingParam.type:
        {
          const add = param as StreamAddOutgoingParam;
          this.stream.increaseInboundStreamCount(add.newStreams);
          await this.reconfig.handleStreamAddOutgoing(add);
        }
        break;
    }
  }

  private receiveDataChunk(chunk: DataChunk) {
    this.sackNeeded = true;

    if (this.markReceived(chunk.tsn)) return;

    this.stream.handleData(chunk);
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

    this.stream.handleForwardTsn(chunk, this.lastReceivedTsn!);
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
    const streamSeqNum = this.stream.incrementOutboundStreamSeq(
      streamId,
      ordered,
    );
    await this.transmitter.send(streamId, ppId, userData, streamSeqNum, {
      expiry,
      maxRetransmits,
      ordered,
    });
  };

  static getCapabilities() {
    return new RTCSctpCapabilities(65536);
  }

  setRemotePort(port: number) {
    this.transmitter.setRemotePort(port);
  }

  async start(remotePort: number = 5000) {
    if (!this.started) {
      this.started = true;
      this.transmitter.setConnectionState("connecting");

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
    init.advertisedRwnd = this.stream.advertisedRwnd;
    init.outboundStreams = this.stream._outboundStreamsCount;
    init.inboundStreams = this.stream._inboundStreamsMax;
    init.initialTsn = this.transmitter.localTsn;
    this.setExtensions(init.params);
    log("send init", init);

    try {
      await this.transmitter.sendChunk(init);

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

  setState(state: SCTP_STATE) {
    if (state != this.associationState) {
      this.associationState = state;
    }
    if (state === SCTP_STATE.ESTABLISHED) {
      this.transmitter.setConnectionState("connected");
    } else if (state === SCTP_STATE.CLOSED) {
      this.timerManager.cancelAllTimers();
      this.transmitter.setConnectionState("closed");
      this.removeAllListeners();
    }
  }

  async stop() {
    if (this.associationState !== SCTP_STATE.CLOSED) {
      await this.abort();
    }
    this.setState(SCTP_STATE.CLOSED);
    this.timerManager.cancelAllTimers();
    this.transport.close();
    this.disposer.dispose();
  }

  async abort() {
    const abort = new AbortChunk();
    await this.transmitter.sendChunk(abort).catch((err: Error) => {
      log("send abort failed", err.message);
    });
  }

  private removeAllListeners() {
    for (const s of Object.values(this.stateChanged)) {
      s.allUnsubscribe();
    }
  }

  get isOutboundQueueEmpty() {
    return this.transmitter.outboundQueue.length === 0;
  }

  dataChannelClose(channelId: number) {
    this.reconfig.reconfigQueue.push(channelId);
    if (this.reconfig.reconfigQueue.length === 1) {
      this.reconfig.transmitReconfigRequest(this.associationState);
    }
  }
}

export class RTCSctpCapabilities {
  constructor(public maxMessageSize: number) {}
}

function handleCookieEchoChunk(data: CookieEchoChunk, hmacKey: Buffer) {
  const cookie = data.body!;
  const digest = createHmac("sha1", hmacKey)
    .update(cookie.subarray(0, 4))
    .digest();
  if (cookie?.length != COOKIE_LENGTH || !cookie.subarray(4).equals(digest)) {
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

    return error;
  }
  const ack = new CookieAckChunk();
  return ack;
}
