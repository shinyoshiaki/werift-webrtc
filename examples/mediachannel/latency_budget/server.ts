// Reproduces the points of https://moq.dev/blog/webrtc-is-still-the-problem/
// with plain WebRTC: werift side of the latency budget example.
// open http://localhost:<vite port>/ (see README.md)
import { setImmediate, setTimeout } from "node:timers/promises";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import {
  type BurstPacketLoss,
  type MediaStreamTrack,
  RTCPeerConnection,
  type RTCRtpReceiver,
  type RTCRtpSender,
  RtpHeader,
  RtpPacket,
  useNACK,
  useOPUS,
} from "../../../packages/webrtc/src";
import { MediaRecorder } from "../../../packages/webrtc/src/nonstandard";

const port = 8888;
/** NACK retry interval used with a latency budget */
const NACK_RETRY_INTERVAL_MS = 20;
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
};

type Publisher = {
  receiver: RTCRtpReceiver;
  budgetMs: number;
  upstreamBudgetMs: number;
  packets: Map<number, RtpPacket>;
  /** Newest RTP timestamp received (the live edge of the media clock) */
  newestTimestamp?: number;
};

type Subscriber = {
  sender: RTCRtpSender;
  budgetMs: number;
  nackRequested: number;
  retransmitted: number;
  refused: number;
  /** Recovered upstream packets not relayed: already older than the budget */
  skippedLate: number;
};

let publisher: Publisher | undefined;
/** RTP received by the last publisher, in RTP timestamp order */
let lastRecording: RtpPacket[] = [];
const subscribers = new Set<Subscriber>();

/**
 * How far behind the live edge of the upstream a packet is, on the media clock
 * (not since it entered a send history). A packet NACK-recovered upstream after
 * 600ms is already 600ms late for a subscriber, before any downstream wait.
 */
function mediaLagMs(timestamp: number) {
  const newest = publisher?.newestTimestamp;
  if (newest === undefined) return 0;
  return Math.max(0, ((newest - timestamp) | 0) / 48);
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

// Scenario A / C upstream: browser mic -> werift, NACKed within the budget.
async function runPublisher(socket: WebSocket, join: JoinMessage) {
  const budgetMs = join.budgetMs ?? 0;
  const pc = new RTCPeerConnection({
    iceServers: [],
    // Audio NACK must be negotiated explicitly; werift's default Opus has none.
    codecs: { audio: [useOPUS({ rtcpFeedback: [useNACK()] })] },
    nack: {
      maxWaitMs: budgetMs,
      retryIntervalMs: NACK_RETRY_INTERVAL_MS,
      maxLost: nackMaxLost(budgetMs),
    },
    debug: { inboundBurstLoss: join.loss },
  });
  const transceiver = pc.addTransceiver("audio", { direction: "recvonly" });
  const self: Publisher = {
    receiver: transceiver.receiver,
    budgetMs,
    upstreamBudgetMs: budgetMs,
    packets: new Map(),
  };
  publisher = self;
  updateUpstreamBudget();

  let recorder: MediaRecorder | undefined;
  let received = 0;
  transceiver.onTrack.subscribe(async (track: MediaStreamTrack) => {
    track.onReceiveRtp.subscribe((rtp) => {
      received++;
      if (
        self.newestTimestamp === undefined ||
        ((rtp.header.timestamp - self.newestTimestamp) | 0) > 0
      ) {
        self.newestTimestamp = rtp.header.timestamp;
      }
      self.packets.set(rtp.header.sequenceNumber, rtp);
      if (self.packets.size > RECORDING_MAX_PACKETS) {
        self.packets.delete(self.packets.keys().next().value!);
      }
      // Fan out to every subscriber. A recovered (late) packet only goes to
      // subscribers whose budget it still fits, judged from its media lag.
      const lag = mediaLagMs(rtp.header.timestamp);
      for (const subscriber of subscribers) {
        if (lag > subscriber.budgetMs) {
          subscriber.skippedLate++;
          continue;
        }
        void subscriber.sender.sendRtp(rtp);
      }
    });
    if (join.record) {
      recorder = new MediaRecorder({
        path: `./latency-budget-${budgetMs}ms-${Date.now()}.webm`,
        numOfTracks: 1,
        // The budget is the jitter buffer latency: a packet recovered by NACK
        // is written back in sequence order instead of at its arrival.
        jitterBuffer: budgetMs > 0 ? { latency: budgetMs } : undefined,
      });
      await recorder.addTrack(track);
    }
  });

  const report = () =>
    send(socket, {
      type: "stats",
      received,
      nack: self.receiver.nackStats,
      upstreamBudgetMs: self.upstreamBudgetMs,
    });
  const timer = setInterval(report, 250);

  const finish = async () => {
    clearInterval(timer);
    report();
    if (self.packets.size > 0) {
      const packets = [...self.packets.values()];
      const base = packets[0].header.timestamp;
      lastRecording = packets.sort(
        (a, b) =>
          ((a.header.timestamp - base) | 0) - ((b.header.timestamp - base) | 0),
      );
    }
    if (publisher === self) publisher = undefined;
    await recorder?.stop();
    console.log("publisher stop", budgetMs, received, self.receiver.nackStats);
  };
  socket.on("message", async (data) => {
    if (parse(data).type === "stop") {
      await finish();
      send(socket, { type: "stopped" });
    }
  });
  socket.on("close", async () => {
    if (publisher === self) await finish();
    await pc.close();
  });

  await negotiate(socket, pc);
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
  };

  const control = pc.createDataChannel("control");
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
    const startTimestamp = (timestamp + 48000) >>> 0;
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
        send(socket, { type: "generation", generation });
        if (message.reply !== false) {
          if (message.replyDelayMs) await setTimeout(message.replyDelayMs);
          await speak(lastRecording.slice(0, 50), "burst", generation);
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
