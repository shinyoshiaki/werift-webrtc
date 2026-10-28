// Reproduces the points of https://moq.dev/blog/webrtc-is-still-the-problem/
// with plain WebRTC: werift side of the latency budget example.
// open http://localhost:<vite port>/ (see README.md)
import { readFile } from "node:fs/promises";
import { setImmediate, setTimeout } from "node:timers/promises";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import {
  type BurstPacketLoss,
  type DebugRtpHeader,
  MediaStreamTrack,
  RTCPeerConnection,
  type RTCRtpReceiver,
  type RTCRtpSender,
  RtpHeader,
  RtpPacket,
  uint16Gt,
  useNACK,
  useOPUS,
} from "../../../packages/webrtc/src";
import { MediaRecorder } from "../../../packages/webrtc/src/nonstandard";
import { LiveEdge } from "./liveEdge";
import { type Accounting, SendAccounting, type SendRange } from "./sendRange";
import { SubscriptionStart } from "./subscriptionStart";
import { Unwrapper } from "./unwrap";
import { countSavedInOrder, readWebmFrames } from "./webmFrames";

const port = 8888;
/** NACK retry interval used with a latency budget */
const NACK_RETRY_INTERVAL_MS = 20;
/** Recent sequence numbers kept to spot duplicates (far below 32768) */
const RECENT_SEQS = 4096;
/** 20ms Opus: 10s of send history covers the 5s budget with room to spare */
const RTP_HISTORY_SIZE = 512;
/** Lost packets tracked per 20ms Opus frame of budget, plus some slack */
const NACK_MS_PER_PACKET = 20;
const NACK_MAX_LOST_SLACK = 50;
const NACK_MAX_LOST_MIN = 150;
/** Packets kept from the last publisher, replayed as the "AI answer" */
const RECORDING_MAX_PACKETS = 50 * 15;

type JoinMessage = {
  type: "join";
  role: "publisher" | "subscriber" | "tts";
  /** publisher: upstream NACK budget. subscriber: max latency it declares */
  budgetMs?: number;
  /** Periodic burst loss werift applies (publisher: inbound, subscriber: outbound) */
  loss?: BurstPacketLoss;
  /** publisher: record the received audio to a .webm file */
  record?: boolean;
  /** publisher: drop the first transmission of the first N packets */
  headLossPackets?: number;
  /** publisher: drop the first transmission of `count` packets of every `every` */
  periodicLoss?: PeriodicPacketLoss;
};

type Publisher = {
  receiver: RTCRtpReceiver;
  budgetMs: number;
  upstreamBudgetMs: number;
  packets: Map<number, RtpPacket>;
  /** packets dropped from `packets` over RECORDING_MAX_PACKETS */
  recordingEvicted: number;
  /** newest upstream sequence number received */
  highestSeq?: number;
};

type Subscriber = {
  sender: RTCRtpSender;
  budgetMs: number;
  nackRequested: number;
  retransmitted: number;
  refused: number;
  /** Recovered upstream packets not relayed: already older than the budget */
  skippedLate: number;
  /** Upstream packets older than this subscription's start, not relayed */
  skippedBeforeStart: number;
  /** Send one upstream packet to this subscriber */
  relay: (rtp: RtpPacket) => void;
};

let publisher: Publisher | undefined;
/** RTP received by the last publisher, in RTP timestamp order */
let lastRecording: RtpPacket[] = [];
const subscribers = new Set<Subscriber>();
const liveEdge = new LiveEdge();

/**
 * How far behind the live edge of the upstream a packet is, on the media clock
 * (not since it entered a send history). A packet NACK-recovered upstream after
 * 600ms is already 600ms late for a subscriber, before any downstream wait.
 */
function mediaLagMs(timestamp: number) {
  return liveEdge.lagMs(timestamp);
}

const server = new WebSocketServer({ port });
console.log("start", port);

server.on("connection", (socket) => {
  socket.once("message", (data) => {
    const join = parse(data) as JoinMessage;
    switch (join.role) {
      case "publisher":
        void runPublisher(socket, join);
        break;
      case "subscriber":
        void runSubscriber(socket, join);
        break;
      case "tts":
        void runTts(socket);
        break;
    }
  });
});

const parse = (data: RawData) => JSON.parse(data.toString());
const send = (socket: WebSocket, message: object) => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
};

async function negotiate(socket: WebSocket, pc: RTCPeerConnection) {
  await pc.setLocalDescription(await pc.createOffer());
  send(socket, { type: "offer", sdp: pc.localDescription });
  const answer = await new Promise<any>((resolve) => {
    const onMessage = (data: RawData) => {
      const message = parse(data);
      if (message.type === "answer") {
        socket.off("message", onMessage);
        resolve(message.sdp);
      }
    };
    socket.on("message", onMessage);
  });
  await pc.setRemoteDescription(answer);
}

/** A burst as long as the budget must stay tracked, or old losses are dropped. */
function nackMaxLost(budgetMs: number) {
  return Math.max(
    NACK_MAX_LOST_MIN,
    Math.ceil(budgetMs / NACK_MS_PER_PACKET) + NACK_MAX_LOST_SLACK,
  );
}

/** Upstream waits as long as the most patient subscriber (or its own budget). */
function updateUpstreamBudget() {
  if (!publisher) return;
  const budgetMs = Math.max(
    publisher.budgetMs,
    ...[...subscribers].map((s) => s.budgetMs),
  );
  publisher.upstreamBudgetMs = budgetMs;
  publisher.receiver.setNackOptions({
    maxWaitMs: budgetMs,
    maxLost: nackMaxLost(budgetMs),
    retryIntervalMs: NACK_RETRY_INTERVAL_MS,
  });
  console.log("upstream nack budget", budgetMs);
}

/** Bounded set of recent sequence numbers (far below half the 16bit space). */
class RecentSeqs {
  private readonly seqs = new Set<number>();
  /** false when already seen */
  add(seq: number) {
    if (this.seqs.has(seq)) return false;
    this.seqs.add(seq);
    if (this.seqs.size > RECENT_SEQS) {
      this.seqs.delete(this.seqs.values().next().value!);
    }
    return true;
  }
}

/**
 * Deterministic upstream loss by sequence number (on top of the timed
 * burst): the first transmission of the first N packets (head), of `count`
 * packets of every `every` (periodic), and of every packet between the
 * client's "lose-tail" and its stop (tail). Audio has no
 * RTX, so a retransmission has the same sequence number and gets through.
 */
type PeriodicPacketLoss = { every: number; count: number };

function upstreamLoss(headLossPackets = 0, periodic?: PeriodicPacketLoss) {
  const seen = new RecentSeqs();
  const positions = new Unwrapper(16);
  let tail = false;
  const dropped = { head: 0, tail: 0, periodic: 0 };
  return {
    dropped,
    loseTail: () => {
      tail = true;
    },
    stopTail: () => {
      tail = false;
    },
    drop: (rtp: DebugRtpHeader) => {
      if (!seen.add(rtp.sequenceNumber)) return false;
      // Position in the stream, extended past the 16bit wrap (first = 0)
      const index = positions.unwrap(rtp.sequenceNumber);
      if (index < headLossPackets) {
        dropped.head++;
        return true;
      }
      // Fixed positions in the stream, unlike the timed burst: whether the
      // tail or the frames sent after the stop fall into it never depends on
      // when the stop happens.
      if (
        periodic &&
        periodic.every > 0 &&
        index % periodic.every >= periodic.every - periodic.count
      ) {
        dropped.periodic++;
        return true;
      }
      if (tail) {
        dropped.tail++;
        return true;
      }
      return false;
    },
  };
}

// Scenario A / C upstream: browser mic -> werift, NACKed within the budget.
async function runPublisher(socket: WebSocket, join: JoinMessage) {
  const budgetMs = join.budgetMs ?? 0;
  const loss = upstreamLoss(join.headLossPackets, join.periodicLoss);
  const pc = new RTCPeerConnection({
    iceServers: [],
    // Audio NACK must be negotiated explicitly; werift's default Opus has none.
    codecs: { audio: [useOPUS({ rtcpFeedback: [useNACK()] })] },
    nack: {
      maxWaitMs: budgetMs,
      retryIntervalMs: NACK_RETRY_INTERVAL_MS,
      maxLost: nackMaxLost(budgetMs),
    },
    debug: { inboundBurstLoss: join.loss, inboundRtpDrop: loss.drop },
  });
  const transceiver = pc.addTransceiver("audio", { direction: "recvonly" });
  const self: Publisher = {
    receiver: transceiver.receiver,
    budgetMs,
    upstreamBudgetMs: budgetMs,
    packets: new Map(),
    recordingEvicted: 0,
  };
  publisher = self;
  liveEdge.reset();
  updateUpstreamBudget();

  // The send range comes from the browser's sender transform (start / stop).
  const accounting = new SendAccounting();
  const seen = new RecentSeqs();
  let recorder: Promise<MediaRecorder> | undefined;
  /** packets received before the recorder started, in arrival order */
  const recorderQueue: RtpPacket[] = [];
  let recordTrack: MediaStreamTrack | undefined;
  /**
   * Record from the first sequence number the browser sent (not the first
   * one received): a head recovered by NACK is written in order, too. The
   * budget is the jitter buffer latency; budget 0 writes in arrival order.
   */
  const startRecorder = (
    source: MediaStreamTrack,
    startSequenceNumber?: number,
  ) => {
    if (!join.record || recorder) return;
    recorder = (async () => {
      const track = new MediaStreamTrack({
        kind: "audio",
        codec: source.codec,
      });
      recordPath = `./latency-budget-${budgetMs}ms-${Date.now()}.webm`;
      const created = new MediaRecorder({
        path: recordPath,
        numOfTracks: 1,
        jitterBuffer:
          budgetMs > 0 ? { latency: budgetMs, startSequenceNumber } : undefined,
      });
      await created.addTrack(track);
      // The writer times the audio by the sender reports (NTP).
      source.onReceiveRtcp.subscribe((rtcp) =>
        track.onReceiveRtcp.execute(rtcp),
      );
      recordTrack = track;
      for (const rtp of recorderQueue.splice(0))
        track.onReceiveRtp.execute(rtp);
      return created;
    })();
  };
  const toRecorder = (rtp: RtpPacket) => {
    if (!join.record) return;
    if (recordTrack) recordTrack.onReceiveRtp.execute(rtp);
    else recorderQueue.push(rtp);
  };
  let remoteTrack: MediaStreamTrack | undefined;
  let recordPath: string | undefined;
  /** leading frames of the .webm that equal the received frames in sequence order */
  let webmInOrder: number | undefined;
  /** frames in the .webm */
  let webmFrames: number | undefined;
  const markFirst = (firstSeq: number | undefined) => {
    if (firstSeq === undefined) return;
    // Head losses (before the first packet received) are NACKed from now on.
    self.receiver.markFirstSentSequence(firstSeq);
    if (remoteTrack && budgetMs > 0) startRecorder(remoteTrack, firstSeq);
  };
  let received = 0;
  let duplicates = 0;
  transceiver.onTrack.subscribe((track: MediaStreamTrack) => {
    remoteTrack = track;
    if (budgetMs === 0) startRecorder(track);
    track.onReceiveRtp.subscribe((rtp) => {
      markFirst(
        accounting.receive(rtp.header.sequenceNumber, rtp.header.timestamp),
      );
      if (accountingResult) {
        // Already reported, but a packet still arrives (given up with a small
        // budget, or a duplicate): the books stay open and are reported again.
        accountingResult = accounting.summary(self.receiver.nackStats);
        report();
      }
      if (!seen.add(rtp.header.sequenceNumber)) {
        // A retransmission answered twice: neither counted nor relayed again.
        duplicates++;
        return;
      }
      received++;
      const seq = rtp.header.sequenceNumber;
      if (self.highestSeq === undefined || uint16Gt(seq, self.highestSeq)) {
        self.highestSeq = seq;
      }
      toRecorder(rtp);
      liveEdge.update(rtp.header.timestamp);
      keepForAnswer(self, rtp);
      // Fan out to every subscriber. A recovered (late) packet only goes to
      // subscribers whose budget it still fits, judged from its media lag.
      const lag = mediaLagMs(rtp.header.timestamp);
      for (const subscriber of subscribers) {
        if (lag > subscriber.budgetMs) {
          subscriber.skippedLate++;
          continue;
        }
        subscriber.relay(rtp);
      }
    });
  });

  let accountingResult: Accounting | undefined;
  const stats = () => ({
    received,
    duplicates,
    nack: self.receiver.nackStats,
    upstreamBudgetMs: self.upstreamBudgetMs,
    dropped: loss.dropped,
    accounting: accountingResult,
    recording: {
      packets: self.packets.size,
      max: RECORDING_MAX_PACKETS,
      evicted: self.recordingEvicted,
      webmInOrder,
      webmFrames,
    },
  });
  const report = () => send(socket, { type: "stats", ...stats() });
  const timer = setInterval(report, 250);

  /**
   * The client has closed its sender with the range it sent. Mark the end of
   * the range, so the tail (lost, or still in flight) is NACKed too, then wait
   * until every packet of the range is received or given up.
   */
  const settle = async (range: SendRange) => {
    loss.stopTail();
    // The range repeats the start, in case that notice has not come yet.
    if (range.firstRtpTimestamp !== undefined) {
      markFirst(accounting.start(range.firstRtpTimestamp));
    }
    const lastSeq = accounting.stop(range);
    if (lastSeq === undefined) return;
    self.receiver.markLastSentSequence(lastSeq);
    // Every loss is detected by now (head at the start notice, the rest by a
    // gap or by the end mark above). The NACK handler gives one up at most the
    // budget after its detection, checked every retry interval; the wait
    // below cannot run longer than that.
    const stopAt = Date.now();
    while (
      self.receiver.nackStats.pending > 0 &&
      Date.now() < stopAt + self.upstreamBudgetMs + 2 * NACK_RETRY_INTERVAL_MS
    ) {
      await setTimeout(NACK_RETRY_INTERVAL_MS);
    }
  };

  const finish = async (range?: SendRange) => {
    if (range) {
      await settle(range);
      accountingResult = accounting.summary(self.receiver.nackStats);
    }
    clearInterval(timer);
    report();
    if (self.packets.size > 0) {
      lastRecording = sortByTimestamp([...self.packets.values()]);
    }
    if (publisher === self) publisher = undefined;
    // No start was ever known (nothing sent, or unverified): record what came.
    if (remoteTrack) startRecorder(remoteTrack);
    await (await recorder)?.stop();
    if (recordPath && range) {
      const frames = readWebmFrames(await readFile(recordPath));
      webmFrames = frames.length;
      webmInOrder = countSavedInOrder(
        frames,
        lastRecording.map((p) => p.payload),
      );
    }
    console.log("publisher stop", budgetMs, stats());
  };
  socket.on("message", async (data) => {
    const message = parse(data);
    switch (message.type) {
      case "start":
        markFirst(accounting.start(message.firstRtpTimestamp));
        break;
      case "lose-tail":
        loss.loseTail();
        break;
      case "stop":
        await finish(message);
        send(socket, { type: "stopped", stats: stats() });
        break;
    }
  });
  socket.on("close", async () => {
    if (publisher === self) await finish();
    await pc.close();
  });

  await negotiate(socket, pc);
}

const timestampOrder = (base: number) => (a: RtpPacket, b: RtpPacket) =>
  ((a.header.timestamp - base) | 0) - ((b.header.timestamp - base) | 0);

function sortByTimestamp(packets: RtpPacket[]) {
  return packets.sort(timestampOrder(packets[0].header.timestamp));
}

/**
 * Keep the publisher's audio for the "AI answer" (scenario B / D). Over the
 * limit the oldest by RTP timestamp (not by arrival: a recovered packet
 * arrives late) is dropped and counted, so a cut answer is visible.
 */
function keepForAnswer(self: Publisher, rtp: RtpPacket) {
  self.packets.set(rtp.header.sequenceNumber, rtp);
  if (self.packets.size <= RECORDING_MAX_PACKETS) return;
  const order = timestampOrder(rtp.header.timestamp);
  let oldest: RtpPacket | undefined;
  for (const packet of self.packets.values()) {
    if (!oldest || order(packet, oldest) < 0) oldest = packet;
  }
  self.packets.delete(oldest!.header.sequenceNumber);
  self.recordingEvicted++;
}

// Scenario C downstream: werift -> browser, recovered by application-layer
// NACK over a DataChannel and cut off at the subscriber's budget.
async function runSubscriber(socket: WebSocket, join: JoinMessage) {
  const pc = new RTCPeerConnection({
    iceServers: [],
    // No `nack` on purpose: Chrome would drive it from NetEQ, which gives up
    // on audio after its playout deadline. The player NACKs on its own.
    codecs: { audio: [useOPUS()] },
    rtpHistorySize: RTP_HISTORY_SIZE,
    debug: { outboundBurstLoss: join.loss },
  });
  const transceiver = pc.addTransceiver("audio", { direction: "sendonly" });
  const self: Subscriber = {
    sender: transceiver.sender,
    budgetMs: join.budgetMs ?? 500,
    nackRequested: 0,
    retransmitted: 0,
    refused: 0,
    skippedLate: 0,
    skippedBeforeStart: 0,
    relay: (rtp) => {
      // A packet from before this subscription (an older one recovered
      // upstream) is neither its start nor relayed: it was never in this
      // sender's history, so the player could not be given the holes before it.
      const decision = subscription.accept(
        rtp.header.sequenceNumber,
        rtp.header.timestamp,
        publisher?.highestSeq,
      );
      if (decision === "before") {
        self.skippedBeforeStart++;
        return;
      }
      if (decision === "start") {
        // Tell the player where this subscription starts, so a loss of this
        // very packet is a hole it can NACK, not a later start. (A fresh
        // sender keeps the upstream sequence numbers.)
        sendStart();
      }
      void self.sender.sendRtp(rtp);
    },
  };
  const subscription = new SubscriptionStart();

  const control = pc.createDataChannel("control");
  const sendStart = () => {
    const { start } = subscription;
    if (start && control.readyState === "open") {
      control.send(JSON.stringify({ type: "start", ...start }));
    }
  };
  control.stateChanged.subscribe((state) => {
    if (state === "open") sendStart();
  });
  control.onMessage.subscribe(async (data) => {
    const message = JSON.parse(data.toString());
    switch (message.type) {
      case "budget":
        // The subscriber declares its max latency (MoQ: per subscription).
        self.budgetMs = message.budgetMs;
        updateUpstreamBudget();
        break;
      case "nack": {
        const requested: number[] = message.seqs;
        self.nackRequested += requested.length;
        // Judge by media lag, which includes the time the packet spent being
        // recovered upstream; the send history only knows its own age.
        const seqs = requested.filter((seq) => {
          const packet = publisher?.packets.get(seq);
          return (
            !packet || mediaLagMs(packet.header.timestamp) <= self.budgetMs
          );
        });
        const sent = await self.sender.retransmit(seqs, {
          maxAgeMs: self.budgetMs,
        });
        self.retransmitted += sent.length;
        self.refused += requested.length - sent.length;
        break;
      }
    }
  });

  const timer = setInterval(
    () =>
      send(socket, {
        type: "stats",
        budgetMs: self.budgetMs,
        nackRequested: self.nackRequested,
        retransmitted: self.retransmitted,
        refused: self.refused,
        skippedLate: self.skippedLate,
        skippedBeforeStart: self.skippedBeforeStart,
      }),
    250,
  );
  socket.on("close", async () => {
    clearInterval(timer);
    subscribers.delete(self);
    updateUpstreamBudget();
    await pc.close();
  });

  await negotiate(socket, pc);
  // Relay only once DTLS is up: a packet sent before is dropped by the sender
  // and never enters its history, so the player could not get it back.
  if (pc.connectionState !== "connected") {
    await pc.connectionStateChange.watch((state) => state === "connected");
  }
  subscribers.add(self);
  updateUpstreamBudget();
}

// Scenario B / D: the "AI answer" (the last recording) is sent as fast as
// possible with its RTP timestamps kept. The CSRC carries the generation.
async function runTts(socket: WebSocket) {
  const pc = new RTCPeerConnection({
    iceServers: [],
    codecs: { audio: [useOPUS()] },
  });
  const transceiver = pc.addTransceiver("audio", { direction: "sendonly" });
  const sender = transceiver.sender;
  let generation = 1;
  let sequenceNumber = 0;
  let timestamp = 0;
  let speaking: AbortController | undefined;

  const speak = async (
    packets: RtpPacket[],
    pace: "burst" | "realtime",
    gen: number,
    /** RTP timestamp of the first packet; announced on interrupt */
    firstTimestamp?: number,
  ) => {
    speaking?.abort();
    const abort = new AbortController();
    speaking = abort;
    if (packets.length === 0) {
      send(socket, { type: "error", reason: "nothing recorded yet" });
      return;
    }
    // Start a new talk spurt 1s after the previous one on the RTP clock.
    const base = packets[0].header.timestamp;
    const startTimestamp = firstTimestamp ?? (timestamp + 48000) >>> 0;
    const startedAt = Date.now();
    let sent = 0;
    for (const [i, source] of packets.entries()) {
      if (abort.signal.aborted) break;
      const offset = (source.header.timestamp - base) >>> 0;
      if (pace === "realtime") {
        // What a WebRTC TTS server has to do today: sleep to the media clock.
        const wait = startedAt + offset / 48 - Date.now();
        if (wait > 0) await setTimeout(wait);
      } else if (i % 25 === 0) {
        await setImmediate();
      }
      if (abort.signal.aborted) break;
      sequenceNumber = (sequenceNumber + 1) & 0xffff;
      timestamp = (startTimestamp + offset) >>> 0;
      await sender.sendRtp(
        new RtpPacket(
          new RtpHeader({
            sequenceNumber,
            timestamp,
            marker: i === 0,
            csrc: [gen],
          }),
          source.payload,
        ),
      );
      sent++;
    }
    send(socket, {
      type: "spoken",
      generation: gen,
      pace,
      packets: sent,
      mediaMs: sent * 20,
      sendMs: Date.now() - startedAt,
    });
  };

  socket.on("message", async (data) => {
    const message = parse(data);
    switch (message.type) {
      case "speak":
        await speak(lastRecording, message.pace ?? "burst", generation);
        break;
      case "interrupt":
        // Barge-in: stop sending, bump the generation and answer briefly.
        speaking?.abort();
        generation++;
        // Control message first: the client flushes without waiting for RTP.
        // It carries the first RTP timestamp of the new generation, so a
        // client that cannot read the CSRC can still tell old frames from new.
        {
          const firstTimestamp = (timestamp + 48000) >>> 0;
          send(socket, { type: "generation", generation, firstTimestamp });
          if (message.reply !== false) {
            if (message.replyDelayMs) await setTimeout(message.replyDelayMs);
            await speak(
              lastRecording.slice(0, 50),
              "burst",
              generation,
              firstTimestamp,
            );
          }
        }
        break;
    }
  });
  socket.on("close", async () => {
    speaking?.abort();
    await pc.close();
  });

  await negotiate(socket, pc);
}
