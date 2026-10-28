import { BudgetPlayer, type PlayerStats } from "./player";
import {
  connect,
  enableOpusNack,
  tapReceiver,
  transformApi,
} from "./signaling";

type BurstLoss = { intervalMs: number; durationMs: number };

/** Results for the page and for the smoke test (examples/e2e). */
const result = {
  env: { userAgent: navigator.userAgent, transformApi },
  a: {} as Record<string, unknown>,
  b: {} as Record<string, unknown>,
  c: {} as Record<string, unknown>,
  d: {} as Record<string, unknown>,
};
(window as any).__latencyBudgetResult = result;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const num = (id: string) => Number($<HTMLInputElement>(id).value);
const show = (id: string, value: unknown) => {
  $(id).textContent = JSON.stringify(value, null, 2);
};

let context: AudioContext | undefined;
async function audioContext() {
  if (!context) {
    context = new AudioContext({ sampleRate: 48000 });
    await BudgetPlayer.load(context);
  }
  await context.resume();
  return context;
}

async function microphone() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  return stream.getAudioTracks()[0];
}

/** Browser mic -> werift. `munge` adds the audio NACK Chrome leaves out. */
async function publish(options: {
  budgetMs: number;
  loss?: BurstLoss;
  record?: boolean;
  munge?: boolean;
}) {
  const track = await microphone();
  const session = await connect(
    {
      type: "join",
      role: "publisher",
      budgetMs: options.budgetMs,
      loss: options.loss,
      record: options.record,
    },
    {
      setup: (pc) => {
        pc.addTrack(track);
      },
      mungeAnswer: options.munge === false ? undefined : enableOpusNack,
    },
  );
  let stats: any = {};
  session.onMessage("stats", (message) => {
    stats = message;
  });
  return {
    session,
    get stats() {
      return stats;
    },
    stop: async () => {
      const stopped = session.next("stopped");
      session.send({ type: "stop" });
      await stopped;
      track.stop();
      session.close();
      return stats;
    },
  };
}

/** werift -> browser with the frames tapped before NetEQ into a BudgetPlayer. */
async function subscribe(
  join: object,
  player: { minDelayMs: number; maxDelayMs: number; appNack: boolean },
  output: "player" | "native",
) {
  const ctx = await audioContext();
  let control: RTCDataChannel | undefined;
  const budgetPlayer = new BudgetPlayer(ctx, {
    minDelayMs: player.minDelayMs,
    maxDelayMs: player.maxDelayMs,
    nack: player.appNack
      ? (seqs) => {
          if (control?.readyState === "open") {
            control.send(JSON.stringify({ type: "nack", seqs }));
          }
        }
      : undefined,
  });
  budgetPlayer.muted = output !== "player";
  const audio = new Audio();
  let untap = () => {};
  const session = await connect(join, {
    setup: (pc) => {
      pc.ontrack = ({ receiver, track }) => {
        untap = tapReceiver(receiver, (frame) => budgetPlayer.push(frame));
        // The native path (NetEQ) gets the same frames; mute it unless chosen.
        audio.srcObject = new MediaStream([track]);
        audio.muted = output !== "native";
        void audio.play().catch(() => {});
      };
      pc.ondatachannel = ({ channel }) => {
        control = channel;
        channel.onopen = () =>
          // Declare this subscriber's latency budget to werift.
          channel.send(
            JSON.stringify({ type: "budget", budgetMs: player.maxDelayMs }),
          );
      };
    },
  });
  let server: any = {};
  session.onMessage("stats", (message) => {
    server = message;
  });
  // Barge-in control message: flush now, without waiting for new-generation RTP.
  session.onMessage("generation", (message) =>
    budgetPlayer.interrupt(message.generation),
  );
  return {
    session,
    player: budgetPlayer,
    get server() {
      return server;
    },
    native: () => nativeStats(session.pc),
    close: () => {
      untap();
      budgetPlayer.close();
      audio.srcObject = null;
      session.close();
    },
  };
}

/** NetEQ (native <audio>) side of the comparison. */
async function nativeStats(pc: RTCPeerConnection) {
  const report = await pc.getStats();
  for (const stats of report.values()) {
    if (stats.type === "inbound-rtp" && stats.kind === "audio") {
      const s = stats as any;
      return {
        packetsReceived: s.packetsReceived,
        packetsLost: s.packetsLost,
        packetsDiscarded: s.packetsDiscarded,
        nackCount: s.nackCount,
        totalSamplesReceived: s.totalSamplesReceived,
        concealedSamples: s.concealedSamples,
        removedSamplesForAcceleration: s.removedSamplesForAcceleration,
        insertedSamplesForDeceleration: s.insertedSamplesForDeceleration,
        jitterBufferDelayMs:
          s.jitterBufferEmittedCount > 0
            ? (s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000
            : 0,
      };
    }
  }
  return {};
}

const summarize = (stats: PlayerStats) => ({
  receivedFrames: stats.receivedFrames,
  decodedFrames: stats.decodedFrames,
  unmatchedOutputs: stats.unmatchedOutputs,
  playedFrames: stats.playedFrames,
  missingFrames: stats.missingFrames,
  recoveredFrames: stats.recoveredFrames,
  concealedFrames: stats.concealedFrames,
  lateDiscardedFrames: stats.lateDiscardedFrames,
  skippedSilentFrames: stats.skippedSilentFrames,
  nackSent: stats.nackSent,
  nackGaveUp: stats.nackGaveUp,
  delayMs: Math.round(stats.delayMs),
  startDelayMs: Math.round(stats.startDelayMs),
  maxDelayMs: Math.round(stats.maxDelayMs),
  stalledMs: Math.round(stats.stalledMs),
  arrivalSpanMs: Math.round(stats.arrivalSpanMs),
  arrivalMediaMs: Math.round(stats.arrivalMediaMs),
  playbackRate: Number(stats.playbackRate.toFixed(3)),
  flushedFrames: stats.flushedFrames,
  oldGenerationPlayed: stats.oldGenerationPlayed,
  staleGenerationFrames: stats.staleGenerationFrames,
  generation: stats.generation,
  lateDroppedFrames: stats.lateDroppedFrames,
  outOfOrderDecodedFrames: stats.outOfOrderDecodedFrames,
  heldFrames: stats.heldFrames,
});

// Scenario A: reliable upstream. werift NACKs Opus within the budget.
async function runA(options: {
  budgetMs: number;
  durationMs: number;
  loss: BurstLoss;
  munge?: boolean;
}) {
  const pub = await publish({ ...options, record: true });
  const timer = setInterval(() => show("a-out", { live: pub.stats }), 250);
  await sleep(options.durationMs);
  clearInterval(timer);
  const stats = await pub.stop();
  result.a[String(options.budgetMs)] = {
    ...options,
    received: stats.received,
    ...stats.nack,
  };
  show("a-out", result.a);
  return result.a[String(options.budgetMs)];
}

const ttsPlayer = { minDelayMs: 100, maxDelayMs: 1000, appNack: false };

// Scenario B: the answer is sent faster than real time and played by RTP
// timestamp, compared with NetEQ (arrival-time playout).
async function runB(options: {
  pace: "burst" | "realtime";
  output: "player" | "native";
}) {
  const sub = await subscribe(
    { type: "join", role: "tts" },
    ttsPlayer,
    options.output,
  );
  const before = await sub.native();
  const spoken = sub.session.next<any>("spoken");
  sub.session.send({ type: "speak", pace: options.pace });
  const done = await spoken;
  const timer = setInterval(
    () => show("b-out", { live: summarize(sub.player.stats) }),
    250,
  );
  // Wait until the player has played it all at real time.
  await sleep(Math.max(0, done.mediaMs - done.sendMs) + 1500);
  clearInterval(timer);
  const after = await sub.native();
  const native = Object.fromEntries(
    Object.entries(after).map(([key, value]) => [
      key,
      key === "jitterBufferDelayMs"
        ? Math.round(value as number)
        : (value as number) - ((before as any)[key] ?? 0),
    ]),
  );
  result.b[options.pace] = {
    ...options,
    server: done,
    player: summarize(sub.player.stats),
    native,
  };
  sub.close();
  show("b-out", result.b);
  return result.b[options.pace];
}

// Scenario C: one upstream, two subscribers with different budgets.
async function runC(options: {
  budgets: number[];
  /** Fallback when `minDelays` has no entry for a subscriber */
  minDelayMs: number;
  /** minDelay per subscriber, in the order of `budgets` */
  minDelays?: number[];
  durationMs: number;
  /** downstream loss of every subscriber */
  loss?: BurstLoss;
  /** loss on the mic -> werift leg; recovered by upstream NACK and relayed late */
  upstreamLoss?: BurstLoss;
}) {
  const pub = await publish({ budgetMs: 0, loss: options.upstreamLoss });
  const subs = [];
  for (const [i, budgetMs] of options.budgets.entries()) {
    const minDelayMs = options.minDelays?.[i] ?? options.minDelayMs;
    subs.push({
      budgetMs,
      minDelayMs,
      sub: await subscribe(
        { type: "join", role: "subscriber", budgetMs, loss: options.loss },
        { minDelayMs, maxDelayMs: budgetMs, appNack: true },
        "player",
      ),
    });
  }
  // Only the first one is audible.
  subs.forEach(({ sub }, i) => {
    sub.player.muted = i !== 0;
  });
  const collect = () =>
    Object.fromEntries(
      subs.map(({ budgetMs, minDelayMs, sub }) => [
        String(budgetMs),
        {
          budgetMs,
          minDelayMs,
          player: summarize(sub.player.stats),
          server: sub.server,
        },
      ]),
    );
  const timer = setInterval(() => show("c-out", collect()), 250);
  await sleep(options.durationMs);
  clearInterval(timer);
  result.c = { ...options, upstream: pub.stats, subscribers: collect() };
  for (const { sub } of subs) sub.close();
  await pub.stop();
  show("c-out", result.c);
  return result.c;
}

// Scenario D: barge-in. The user's interrupt (button) flushes the old answer
// at once; the new generation's audio may come late or never.
let activeD: Awaited<ReturnType<typeof subscribe>> | undefined;

/** Flush locally right away, then tell werift to stop and bump the generation. */
function interruptNow(
  options: { reply?: boolean; replyDelayMs?: number } = {},
) {
  if (!activeD) throw new Error("scenario D is not running");
  activeD.player.interrupt();
  activeD.session.send({ type: "interrupt", ...options });
}

async function runD(options: {
  interruptAfterMs: number;
  /** false: no new answer follows the interrupt */
  reply?: boolean;
  /** delay of the new answer's RTP after the interrupt */
  replyDelayMs?: number;
  /** wait for the button instead of interrupting automatically */
  manual?: boolean;
}) {
  const sub = await subscribe(
    { type: "join", role: "tts" },
    ttsPlayer,
    "player",
  );
  activeD = sub;
  const spoken = sub.session.next<any>("spoken");
  sub.session.send({ type: "speak", pace: "burst" });
  const first = await spoken;
  // Subscribe before the interrupt: the new answer can follow it immediately.
  const reply =
    options.reply === false ? undefined : sub.session.next<any>("spoken");
  if (options.manual) {
    await new Promise<void>((resolve) => {
      sub.session.onMessage("generation", () => resolve());
    });
  } else {
    await sleep(options.interruptAfterMs);
  }
  const beforeInterrupt = summarize(sub.player.stats);
  if (!options.manual) {
    interruptNow({ reply: options.reply, replyDelayMs: options.replyDelayMs });
  }
  // Played frames must stop growing once the old answer is flushed, even
  // while the new generation's RTP has not arrived.
  await sleep(300);
  const settled = summarize(sub.player.stats);
  await sleep(
    options.replyDelayMs ? Math.max(options.replyDelayMs - 600, 300) : 700,
  );
  const quiet = summarize(sub.player.stats);
  const second = await reply;
  const replyMs = second?.mediaMs ?? 0;
  await sleep(replyMs + 1000);
  const after = summarize(sub.player.stats);
  result.d = {
    ...options,
    answerMs: first.mediaMs,
    replyMs,
    playedBeforeInterrupt: beforeInterrupt.playedFrames,
    playedAfterInterrupt: settled.playedFrames,
    playedWhileWaitingReply: quiet.playedFrames - settled.playedFrames,
    playedAfter: after.playedFrames,
    player: after,
  };
  activeD = undefined;
  sub.close();
  show("d-out", result.d);
  return result.d;
}

const lossInput = (prefix: string): BurstLoss => ({
  intervalMs: num(`${prefix}-loss-interval`),
  durationMs: num(`${prefix}-loss-duration`),
});

const button = (id: string, run: () => Promise<unknown>) => {
  $(id).onclick = async () => {
    const target = $<HTMLButtonElement>(id);
    target.disabled = true;
    try {
      await audioContext();
      await run();
    } catch (error) {
      console.error(error);
      $("error").textContent = String(error);
    } finally {
      target.disabled = false;
    }
  };
};

button("a-start", () =>
  runA({
    budgetMs: num("a-budget"),
    durationMs: num("a-duration"),
    loss: lossInput("a"),
    munge: $<HTMLInputElement>("a-munge").checked,
  }),
);
button("b-start", () =>
  runB({
    pace: $<HTMLSelectElement>("b-pace").value as "burst" | "realtime",
    output: $<HTMLSelectElement>("b-output").value as "player" | "native",
  }),
);
button("c-start", () =>
  runC({
    budgets: [num("c-budget-1"), num("c-budget-2")],
    minDelayMs: num("c-min-delay-1"),
    minDelays: [num("c-min-delay-1"), num("c-min-delay-2")],
    durationMs: num("c-duration"),
    loss: lossInput("c"),
  }),
);
button("d-start", () =>
  runD({
    interruptAfterMs: num("d-interrupt-after"),
    manual: $<HTMLInputElement>("d-manual").checked,
    replyDelayMs: num("d-reply-delay"),
  }),
);
button("d-interrupt", async () =>
  interruptNow({ replyDelayMs: num("d-reply-delay") }),
);

(window as any).latencyBudget = {
  audioContext,
  runA,
  runB,
  runC,
  runD,
  interruptNow,
};
$("env").textContent = `${transformApi} / ${navigator.userAgent}`;
