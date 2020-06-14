import { range } from "lodash";
import { SCTP_STATE } from "./const";
import { jspack } from "jspack";
import { random32, uint32Gte, uint32Gt, enumerate, uint16Add } from "./utils";

import {
  Chunk,
  ForwardTsnChunk,
  ReConfigChunk,
  InitChunk,
  parsePacket,
  DataChunk,
  serializePacket,
  SackChunk,
  HeartbeatChunk,
  HeartbeatAckChunk,
  AbortChunk,
  ShutdownChunk,
  ShutdownAckChunk,
  ReconfigChunk,
  InitAckChunk,
  CookieAckChunk,
  ErrorChunk,
  CookieEchoChunk,
} from "./chunk";
import { createHmac, randomBytes } from "crypto";
import { Transport } from "./transport";
import { Subject } from "rxjs";

// # local constants
const COOKIE_LENGTH = 24;
const COOKIE_LIFETIME = 60;
const MAX_STREAMS = 65535;
const USERDATA_MAX_LENGTH = 1200;

// # protocol constants
const SCTP_DATA_LAST_FRAG = 0x01;
const SCTP_DATA_FIRST_FRAG = 0x02;
const SCTP_DATA_UNORDERED = 0x04;
const SCTP_MAX_ASSOCIATION_RETRANS = 10;
const SCTP_MAX_BURST = 4;
const SCTP_MAX_INIT_RETRANS = 8;
const SCTP_RTO_ALPHA = 1 / 8;
const SCTP_RTO_BETA = 1 / 4;
const SCTP_RTO_INITIAL = 3 * 1000;
const SCTP_RTO_MIN = 1;
const SCTP_RTO_MAX = 60;
const SCTP_TSN_MODULO = 2 ** 32;

// # parameters
const SCTP_STATE_COOKIE = 0x0007;
const SCTP_STR_RESET_OUT_REQUEST = 0x000d;
const SCTP_STR_RESET_RESPONSE = 0x0010;
const SCTP_STR_RESET_ADD_OUT_STREAMS = 0x0011;
const SCTP_SUPPORTED_CHUNK_EXT = 0x8008;
const SCTP_PRSCTP_SUPPORTED = 0xc000;

const SCTP_CAUSE_INVALID_STREAM = 0x0001;
const SCTP_CAUSE_STALE_COOKIE = 0x0003;

export class SCTP {
  connected = new Subject();
  associationState = SCTP_STATE.CLOSED;
  started = false;
  state = "new";
  private hmacKey = randomBytes(16);

  private localPartialReliability = true;
  private localPort = this.port;
  private localVerificationTag = random32();

  remotePartialReliability = true;
  private remotePort?: number;
  private remoteVerificationTag = 0;

  // inbound
  private advertisedRwnd = 1024 * 1024; // Receiver Window
  private inboundStreams: { [key: number]: InboundStream } = {};
  private inboundStreamsCount = 0;
  private inboundStreamsMax = MAX_STREAMS;
  private sackNeeded = false;
  private lastReceivedTsn?: number; // Transmission Sequence Number
  private sackDuplicates: number[] = [];
  private sackMisOrdered = new Set<number>();

  // # outbound
  private fastRecoveryExit?: number;
  private fastRecoveryTransmit = false;
  private forwardTsnChunk?: ForwardTsnChunk;
  private flightSize = 0;
  outboundQueue: DataChunk[] = [];
  private outboundStreamSeq: { [key: number]: number } = {};
  private outboundStreamsCount = MAX_STREAMS;
  private localTsn = random32();
  private lastSackedTsn = tsnMinusOne(this.localTsn);
  private advancedPeerAckTsn = tsnMinusOne(this.localTsn); // acknowledgement
  private partialBytesAcked = 0;
  private sentQueue: DataChunk[] = [];

  // timers
  private rto = SCTP_RTO_INITIAL;
  private t1Handle?: any;
  private t1Chunk?: Chunk;
  private t1Failures = 0;
  private t2Handle?: any;
  private t2Chunk?: Chunk;
  private t2Failures = 0;
  private t3Handle?: any;

  // etc
  private ssthresh?: number; // slow start threshold
  private cwnd = 3 * USERDATA_MAX_LENGTH; // Congestion Window

  // # reconfiguration

  reconfig_request_seq = this.localTsn;
  reconfig_response_seq = 0;

  constructor(public transport: Transport, public port = 5000) {
    this.transport.onData = (buf) => {
      this.handleData(buf);
    };
  }

  isServer = true;
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
  async handleData(data: Buffer) {
    let expectedTag;

    const [, , verificationTag, chunks] = parsePacket(data);
    const initChunk = chunks.filter((v) => v.type === InitChunk.type).length;
    if (initChunk > 0) {
      if (chunks.length != 1) throw new Error();
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

    await this.sendChunk(sack);

    this.sackDuplicates = [];
    this.sackNeeded = false;
  }

  private async receiveChunk(chunk: Chunk) {
    switch (chunk.type) {
      case DataChunk.type:
        await this.receiveDataChunk(chunk as DataChunk);
        break;
      case SackChunk.type:
        await this.receiveSackChunk(chunk as SackChunk);
        break;
      case ForwardTsnChunk.type:
        await this.receiveForwardTsnChunk(chunk as ForwardTsnChunk);
        break;
      case HeartbeatChunk.type:
        {
          const ack = new HeartbeatAckChunk(0, undefined);
          ack.params = (chunk as HeartbeatChunk).params;
          await this.sendChunk(ack);
        }
        break;
      case AbortChunk.type:
        console.log("AbortChunk");
        this.setState(SCTP_STATE.CLOSED);
        break;
      case ShutdownChunk.type:
        {
          this.t2Cancel();
          this.setState(SCTP_STATE.SHUTDOWN_RECEIVED);
          const ack = new ShutdownAckChunk();
          await this.sendChunk(ack);
          this.t2Start(ack);
          this.setState(SCTP_STATE.SHUTDOWN_SENT);
        }
        break;
      // todo
      // case "ShutdownCompleteChunk"
      case ReconfigChunk.type:
        // todo
        break;
      case InitChunk.type:
        const initChunk = chunk as InitChunk;
        if (this.isServer) {
          this.lastReceivedTsn = tsnMinusOne(initChunk.initialTsn);
          this.reconfig_response_seq = tsnMinusOne(initChunk.initialTsn);
          this.remoteVerificationTag = initChunk.initiateTag;
          this.ssthresh = initChunk.advertisedRwnd;
          this.getExtensions(initChunk.params);

          this.inboundStreamsCount = Math.min(
            initChunk.outboundStreams,
            this.inboundStreamsMax
          );
          this.outboundStreamsCount = Math.min(
            this.outboundStreamsCount,
            initChunk.inboundStreams
          );

          const ack = new InitAckChunk();
          ack.initiateTag = this.localVerificationTag;
          ack.advertisedRwnd = this.advertisedRwnd;
          ack.outboundStreams = this.outboundStreamsCount;
          ack.inboundStreams = this.inboundStreamsCount;
          ack.initialTsn = this.localTsn;
          this.setExtensions(ack.params);

          const time = Date.now() / 1000;
          let cookie = Buffer.from(jspack.Pack("!L", [time]));
          cookie = Buffer.concat([
            cookie,
            createHmac("sha1", this.hmacKey).update(cookie).digest(),
          ]);
          ack.params.push([SCTP_STATE_COOKIE, cookie]);
          await this.sendChunk(ack);
        }
        break;
      case CookieEchoChunk.type:
        const data = chunk as CookieEchoChunk;
        if (this.isServer) {
          const cookie = data.body!;
          const digest = createHmac("sha1", this.hmacKey)
            .update(cookie.slice(0, 4))
            .digest();
          if (
            cookie?.length != COOKIE_LENGTH ||
            !cookie.slice(4).equals(digest)
          ) {
            console.log("x State cookie is invalid");
            return;
          }

          const now = Date.now() / 1000;
          const stamp = jspack.Unpack("!L", cookie)[0];
          if (stamp < now - COOKIE_LIFETIME || stamp > now) {
            const error = new ErrorChunk(0, undefined);
            error.params.push([
              SCTP_CAUSE_STALE_COOKIE,
              Buffer.concat([...Array(8)].map(() => Buffer.from("\x00"))),
            ]);
            await this.sendChunk(error);
            return;
          }

          const ack = new CookieAckChunk();
          await this.sendChunk(ack);
          this.setState(SCTP_STATE.ESTABLISHED);
        }
        break;
      case InitAckChunk.type:
        if (this.associationState === SCTP_STATE.COOKIE_WAIT) {
          const data = chunk as InitAckChunk;
          this.t1Cancel();
          this.lastReceivedTsn = tsnMinusOne(data.initialTsn);
          this.reconfig_request_seq = tsnMinusOne(data.initialTsn);
          this.remoteVerificationTag = data.initiateTag;
          this.ssthresh = data.advertisedRwnd;
          this.getExtensions(data.params);

          this.inboundStreamsCount = Math.min(
            data.outboundStreams,
            this.inboundStreamsMax
          );
          this.outboundStreamsCount = Math.min(
            this.outboundStreamsCount,
            data.inboundStreams
          );

          const echo = new CookieEchoChunk();
          for (const [k, v] of data.params) {
            if (k === SCTP_STATE_COOKIE) {
              echo.body = v;
              break;
            }
          }
          await this.sendChunk(echo);

          this.t1Start(echo);
          this.setState(SCTP_STATE.COOKIE_ECHOED);
        }
        break;
      case CookieAckChunk.type:
        if (this.associationState === SCTP_STATE.COOKIE_ECHOED) {
          this.t1Cancel();
          this.setState(SCTP_STATE.ESTABLISHED);
        }
        break;
      case ErrorChunk.type:
        if (
          [SCTP_STATE.COOKIE_WAIT, SCTP_STATE.COOKIE_ECHOED].indexOf(
            this.associationState
          )
        ) {
          console.log("ErrorChunk");
          this.t1Cancel();
          this.setState(SCTP_STATE.CLOSED);
        }
        break;
    }
  }

  private getExtensions(params: [number, Buffer][]) {
    for (const [k] of params) {
      if (k === SCTP_PRSCTP_SUPPORTED) {
        this.remotePartialReliability = true;
      } else if (SCTP_SUPPORTED_CHUNK_EXT) {
        // todo
        // this.reomtee
      }
    }
  }

  private async receiveDataChunk(chunk: DataChunk) {
    this.sackNeeded = true;

    if (this.markReceived(chunk.tsn)) return;

    const inboundStream = this.getInboundStream(chunk.streamId);

    inboundStream.addChunk(chunk);
    this.advertisedRwnd -= chunk.userData.length;
    for (const message of inboundStream.popMessages()) {
      this.advertisedRwnd += message[2].length;
      await this.receive(...message);
    }
  }

  private async receiveSackChunk(chunk: SackChunk) {
    // """
    // Handle a SACK chunk.
    // """

    if (uint32Gt(this.lastSackedTsn, chunk.cumulativeTsn)) return;

    const receivedTime = Date.now() / 1000;
    this.lastSackedTsn = chunk.cumulativeTsn;
    const cwndFullyUtilized = this.flightSize >= this.cwnd!;
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
        doneBytes += sChunk.bookSize!;
        this.flightSizeDecrease(sChunk);
      }

      if (done === 1 && sChunk.sentCount === 1) {
        this.updateRto(receivedTime - sChunk.sentTime!);
      }
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
        })
      );

      let highestNewlyAcked = chunk.cumulativeTsn;
      for (const sChunk of this.sentQueue) {
        if (uint32Gt(sChunk.tsn, highestSeenTsn!)) {
          break;
        }
        if (seen.has(sChunk.tsn) && !sChunk.acked) {
          doneBytes += sChunk.bookSize!;
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
          sChunk.misses! += 1;
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
        if (this.cwnd! <= this.ssthresh!) {
          this.cwnd! += Math.min(doneBytes, USERDATA_MAX_LENGTH);
        } else {
          this.partialBytesAcked += doneBytes;
          if (this.partialBytesAcked >= this.cwnd!) {
            this.partialBytesAcked -= this.cwnd!;
            this.cwnd! += USERDATA_MAX_LENGTH;
          }
        }
      }
      if (loss) {
        this.ssthresh = Math.max(
          Math.floor(this.cwnd! / 2),
          4 * USERDATA_MAX_LENGTH
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
      this.t3Cancel();
    } else if (done) {
      this.t3Restart();
    }

    this.updateAdvancedPeerAckPoint();
    await this.transmit();
  }

  async receiveForwardTsnChunk(chunk: ForwardTsnChunk) {
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
    for (const [streamId, streamSeq] of chunk.streams) {
      const inboundStream = this.getInboundStream(streamId);

      // # advance sequence number and perform delivery
      inboundStream.sequenceNumber = uint16Add(streamSeq, 1);
      for (const message of inboundStream.popMessages()) {
        this.advertisedRwnd += message[2].length;
        await this.receive(...message);
      }
    }

    // # prune obsolete chunks
    Object.values(this.inboundStreams).forEach((inboundStream) => {
      this.advertisedRwnd += inboundStream.pruneChunks(this.lastReceivedTsn!);
    });
  }

  private srtt?: number;
  private rttvar?: number;
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
      Math.min(this.srtt + 4 * this.rttvar, SCTP_RTO_MAX)
    );
  }

  onRecieve?: (streamId: number, ppId: number, data: Buffer) => void;
  private async receive(streamId: number, ppId: number, data: Buffer) {
    if (this.onRecieve) this.onRecieve(streamId, ppId, data);
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
      } else {
        break;
      }
    }

    const isObsolete = (x: number) => uint32Gt(x, this.lastReceivedTsn!);

    this.sackDuplicates = this.sackDuplicates.filter(isObsolete);
    this.sackMisOrdered = new Set([...this.sackMisOrdered].filter(isObsolete));

    return false;
  }

  async send(
    streamId: number,
    ppId: number,
    userData: Buffer,
    expiry: number | undefined = undefined,
    maxRetransmits: number | undefined = undefined,
    ordered = true
  ) {
    const streamSeq = ordered ? this.outboundStreamSeq[streamId] || 0 : 0;

    const fragments = Math.ceil(userData.length / USERDATA_MAX_LENGTH);
    let pos = 0;

    for (const fragment of range(0, fragments)) {
      const chunk = new DataChunk(0, undefined);
      chunk.flags = 0;
      if (!ordered) {
        chunk.flags = SCTP_DATA_UNORDERED;
      } else {
        if (fragments === 1) {
          chunk.flags = 0x03;
        } else if (fragment === 0) {
          chunk.flags = SCTP_DATA_FIRST_FRAG;
        } else if (fragment === fragments - 1) {
          chunk.flags = SCTP_DATA_LAST_FRAG;
        }
      }

      chunk.tsn = this.localTsn;
      chunk.streamId = streamId;
      chunk.streamSeq = streamSeq;
      chunk.protocol = ppId;
      chunk.userData = userData.slice(pos, pos + USERDATA_MAX_LENGTH);

      chunk.abandoned = false;
      chunk.acked = false;
      chunk.bookSize = chunk.userData.length;
      chunk.expiry = expiry;
      chunk.maxRetransmits = maxRetransmits;
      chunk.misses = 0;
      chunk.retransmit = false;
      chunk.sentCount = 0;
      chunk.sentTime = undefined;

      pos += USERDATA_MAX_LENGTH;
      this.localTsn = tsnPlusOne(this.localTsn);
      this.outboundQueue.push(chunk);
    }

    if (ordered) {
      this.outboundStreamSeq[streamId] = uint16Add(streamSeq, 1);
    }

    if (!this.t3Handle) {
      await this.transmit();
    }
  }

  private async transmit() {
    // """
    // Transmit outbound data.
    // """

    // # send FORWARD TSN
    if (this.forwardTsnChunk) {
      await this.sendChunk(this.forwardTsnChunk);
      this.forwardTsnChunk = undefined;

      if (!this.t3Handle) {
        this.t3Start();
      }
    }

    const burstSize =
      this.fastRecoveryExit != undefined
        ? 2 * USERDATA_MAX_LENGTH
        : 4 * USERDATA_MAX_LENGTH;

    const cwnd = Math.min(this.flightSize + burstSize, this.cwnd);

    let retransmitEarliest = true;
    for (const chunk of this.sentQueue) {
      if (chunk.retransmit) {
        if (this.fastRecoveryTransmit) {
          this.fastRecoveryTransmit = false;
        } else if (this.flightSize >= cwnd) {
          return;
        }
        this.flightSizeIncrease(chunk);

        chunk.misses = 0;
        chunk.retransmit = false;
        chunk.sentCount!++;
        await this.sendChunk(chunk);

        if (retransmitEarliest) {
          this.t3Restart();
        }
      }
      retransmitEarliest = false;
    }

    while (this.outboundQueue.length > 0 && this.flightSize < cwnd) {
      const chunk = this.outboundQueue.shift()!;
      this.sentQueue.push(chunk);
      this.flightSizeIncrease(chunk);

      // # update counters
      chunk.sentCount!++;
      chunk.sentTime = Date.now();

      await this.sendChunk(chunk);
      if (!this.t3Handle) {
        this.t3Start();
      }
    }
  }

  private flightSizeIncrease(chunk: DataChunk) {
    this.flightSize += chunk.bookSize!;
  }

  private flightSizeDecrease(chunk: DataChunk) {
    this.flightSize = Math.max(0, this.flightSize - chunk.bookSize!);
  }

  // # timers

  private t1Cancel() {
    if (this.t1Handle) {
      clearTimeout(this.t1Handle);
      this.t1Handle = undefined;
      this.t1Chunk = undefined;
    }
  }

  private t1Expired = async () => {
    this.t1Failures++;
    this.t1Handle = undefined;
    if (this.t1Failures > SCTP_MAX_INIT_RETRANS) {
      console.log("t1Expired");
      this.setState(SCTP_STATE.CLOSED);
    } else {
      this.sendChunk(this.t1Chunk!);
      this.t1Handle = setTimeout(this.t1Expired, this.rto);
    }
  };

  private t1Start(chunk: Chunk) {
    if (this.t1Handle) throw new Error();
    this.t1Chunk = chunk;
    this.t1Failures = 0;
    this.t1Handle = setTimeout(this.t1Expired, this.rto);
  }

  private t2Cancel() {
    if (this.t2Handle) {
      clearTimeout(this.t2Handle);
      this.t2Handle = undefined;
      this.t2Chunk = undefined;
    }
  }

  private t2Expired = () => {
    this.t2Failures++;
    this.t2Handle = undefined;
    if (this.t2Failures > SCTP_MAX_ASSOCIATION_RETRANS) {
      console.log("t2Expired");
      this.setState(SCTP_STATE.CLOSED);
    } else {
      this.sendChunk(this.t2Chunk!);
      this.t2Handle = setTimeout(this.t2Expired, this.rto);
    }
  };

  private t2Start(chunk: Chunk) {
    if (this.t2Handle) throw new Error();
    this.t2Chunk = chunk;
    this.t2Failures = 0;
    this.t2Handle = setTimeout(this.t2Expired, this.rto);
  }

  private t3Expired = () => {
    this.t3Handle = undefined;

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
      Math.floor(this.cwnd! / 2),
      4 * USERDATA_MAX_LENGTH
    );
    this.cwnd = USERDATA_MAX_LENGTH;

    this.transmit();
  };

  private t3Restart() {
    if (this.t3Handle) {
      clearTimeout(this.t3Handle);
      this.t3Handle = undefined;
    }
    this.t3Handle = setTimeout(this.t3Expired, this.rto);
  }

  private t3Start() {
    if (this.t3Handle) throw new Error();
    this.t3Handle = setTimeout(this.t3Expired, this.rto);
  }

  private t3Cancel() {
    if (this.t3Handle) {
      clearTimeout(this.t3Handle);
      this.t3Handle = undefined;
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
        streams[chunk.streamId] = chunk.streamSeq;
      }
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

  private maybeAbandon(chunk: DataChunk) {
    if (chunk.abandoned) return true;
    const abandon =
      (chunk.maxRetransmits && chunk.sentCount! > chunk.maxRetransmits) ||
      (chunk.expiry && chunk.expiry < Date.now());

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

  async start(remotePort: number) {
    if (!this.started) {
      this.started = true;
      this.state = "connecting";
      this.remotePort = remotePort;

      if (!this.isServer) {
        await this.init();
      }
    }
  }

  private async init() {
    const chunk = new InitChunk();
    chunk.initiateTag = this.localVerificationTag;
    chunk.advertisedRwnd = this.advertisedRwnd;
    chunk.outboundStreams = this.outboundStreamsCount;
    chunk.inboundStreams = this.inboundStreamsMax;
    chunk.initialTsn = this.localTsn;
    this.setExtensions(chunk.params);
    await this.sendChunk(chunk);

    // # start T1 timer and enter COOKIE-WAIT state
    this.t1Start(chunk);
    this.setState(SCTP_STATE.COOKIE_WAIT);
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

  private async sendChunk(chunk: Chunk) {
    if (this.remotePort === undefined) throw new Error("invalid remote port");
    this.transport.send(
      serializePacket(
        this.localPort,
        this.remotePort,
        this.remoteVerificationTag,
        chunk
      )
    );
  }

  private setState(state: SCTP_STATE) {
    if (state != this.associationState) {
      this.associationState = state;
    }
    if (state === SCTP_STATE.ESTABLISHED) {
      this.state = "connected";
      this.connected.next();
    } else if (state === SCTP_STATE.CLOSED) {
      console.log("sctp closed");
      // todo
      // this.t1Cancel();
      // this.t2Cancel();
      // this.t3Cancel();
      // this.state = "closed";
    }
  }
}

export class InboundStream {
  reassembly: DataChunk[] = [];
  sequenceNumber = 0;

  addChunk(chunk: DataChunk) {
    if (
      this.reassembly.length === 0 ||
      uint32Gt(chunk.tsn, this.reassembly[this.reassembly.length - 1].tsn)
    ) {
      this.reassembly.push(chunk);
      return;
    }

    for (const { i, v } of enumerate(this.reassembly)) {
      if (v.tsn === chunk.tsn) throw new Error("duplicate chunk in reassembly");

      if (uint32Gt(v.tsn, chunk.tsn)) {
        this.reassembly.splice(i, 0, chunk);
        break;
      }
    }
  }

  *popMessages(): Generator<[number, number, Buffer]> {
    let pos = 0;
    let startPos;
    let expectedTsn: number;
    let ordered: boolean | undefined;
    while (pos < this.reassembly.length) {
      const chunk = this.reassembly[pos];
      if (!startPos) {
        ordered = !(chunk.flags && SCTP_DATA_UNORDERED);
        if (!(chunk.flags & SCTP_DATA_FIRST_FRAG)) {
          if (ordered) {
            break;
          } else {
            pos++;
            continue;
          }
        }
        if (ordered && uint32Gt(chunk.streamSeq, this.sequenceNumber)) {
          break;
        }
        expectedTsn = chunk.tsn;
        startPos = pos;
      } else if (chunk.tsn !== expectedTsn!) {
        if (ordered!) {
          break;
        } else {
          startPos = undefined;
          pos++;
          continue;
        }
      }

      if (chunk.flags && SCTP_DATA_LAST_FRAG) {
        const userData = Buffer.from(
          this.reassembly
            .slice(startPos, pos + 1)
            .map((c) => c.userData)
            .join("")
        );
        this.reassembly = [
          ...this.reassembly.slice(0, startPos),
          ...this.reassembly.slice(pos + 1),
        ];
        if (ordered && chunk.streamSeq === this.sequenceNumber) {
          this.sequenceNumber = uint16Add(this.sequenceNumber, 1);
        }
        pos = startPos;
        yield [chunk.streamId, chunk.protocol, userData];
      } else {
        pos++;
      }
      expectedTsn = tsnPlusOne(expectedTsn);
    }
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
  constructor(public maxMessageSize: number) {}
}

function tsnMinusOne(a: number) {
  return (a - 1) % SCTP_TSN_MODULO;
}

function tsnPlusOne(a: number) {
  return (a + 1) % SCTP_TSN_MODULO;
}
