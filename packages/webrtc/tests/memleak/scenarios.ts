/**
 * メモリリーク試験の主要ユースケースシナリオ定義。
 * 実時間 1 時間相当の処理量バジェットを計算し、時間加速して消化する。
 *
 * 注意: タイマーや Event 購読をサイクル終了後に必ず解放すること。
 * 未 clear の setTimeout が PeerConnection をクロージャで保持すると、
 * 本番リークのように Event / DTLS オブジェクトが蓄積して見える。
 */
import { setTimeout as delay } from "node:timers/promises";

import {
  MediaStreamTrack,
  type RTCDataChannel,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
} from "../../src";
import { type MemleakEnv, injectSyntheticLeak } from "./heapUtils";

/** 想定実時間レート（時間加速の換算に使用） */
export const RATES = {
  /** ビデオ 30fps */
  mediaFps: 30,
  /** DataChannel 100 messages/s */
  dcMessagesPerSec: 100,
  /** 接続ライフサイクル 1 接続/分 */
  connectionsPerMinute: 1,
} as const;

export type ScenarioId =
  | "datachannel"
  | "media"
  | "connection"
  | "synthetic-leak";

export type ScenarioBudget = {
  id: ScenarioId;
  label: string;
  iterations: number;
  /** 1 サイクルあたりの送信量（メッセージ or フレーム）。接続系は 1 */
  unitsPerCycle: number;
  /** 総処理量 */
  totalUnits: number;
  /** 実時間相当秒数 = totalUnits / rate */
  equivalentSeconds: number;
  unitName: string;
  rateDescription: string;
};

export type CycleResult = {
  unitsProcessed: number;
  notes?: string;
};

export type Scenario = {
  id: ScenarioId;
  label: string;
  budget: ScenarioBudget;
  /** 合成リーク検証など、FAIL が期待されるシナリオ */
  expectedLeak?: boolean;
  /** 1 サイクル実行。接続確立 → 処理 → close */
  runCycle: (cycle: number) => Promise<CycleResult>;
};

type Unsub = () => void;

/** タイムアウト付き Promise。解決/拒否/finally で必ず timer を clear する */
function withTimeout<T>(
  work: (signal: { expired: boolean }) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const signal = { expired: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      signal.expired = true;
      reject(new Error(`${label} timeout (${timeoutMs}ms)`));
    }, timeoutMs);
  });
  return Promise.race([work(signal), timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function exchangeIceCandidates(
  pc1: RTCPeerConnection,
  pc2: RTCPeerConnection,
): Unsub {
  const unsubs: Unsub[] = [];
  const forward = (local: RTCPeerConnection, remote: RTCPeerConnection) => {
    const { unSubscribe } = local.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return;
      if (remote.signalingState !== "closed") {
        remote.addIceCandidate(candidate).catch((error) => {
          if ((error as Error).message !== "The remote description was null") {
            // closed 後の競合は無視
            if (remote.signalingState === "closed") return;
            throw error;
          }
        });
      }
    });
    unsubs.push(unSubscribe);
  };
  forward(pc1, pc2);
  forward(pc2, pc1);
  return () => {
    for (const u of unsubs) u();
  };
}

async function exchangeOfferAnswer(
  caller: RTCPeerConnection,
  callee: RTCPeerConnection,
): Promise<void> {
  await caller.setLocalDescription(await caller.createOffer());
  await callee.setRemoteDescription(caller.localDescription!);
  const answer = await callee.createAnswer();
  await caller.setRemoteDescription(answer);
  await callee.setLocalDescription(answer);
}

async function waitConnected(
  pc: RTCPeerConnection,
  timeoutMs = 15_000,
): Promise<void> {
  if (pc.connectionState === "connected") return;
  await withTimeout(
    async () => {
      await pc.connectionStateChange.watch((v) => v === "connected");
    },
    timeoutMs,
    "connectionState connected",
  );
}

/** イベントループを塞がないよう、一定回数ごとに yield する */
async function yieldOccasionally(i: number, every = 64): Promise<void> {
  if (i > 0 && i % every === 0) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

/**
 * DataChannel の bufferedAmount によるバックプレッシャー待ち。
 * send() 自体は同期だが、SCTP フロー制御でバッファが膨らむため閾値で待つ。
 */
async function waitForBufferedAmount(
  channel: { bufferedAmount: number },
  threshold: number,
  timeoutMs = 10_000,
): Promise<void> {
  if (channel.bufferedAmount <= threshold) return;
  const start = Date.now();
  while (channel.bufferedAmount > threshold) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `bufferedAmount backpressure timeout (${channel.bufferedAmount} > ${threshold})`,
      );
    }
    await delay(1);
  }
}

async function closePeers(...pcs: RTCPeerConnection[]): Promise<void> {
  await Promise.all(pcs.map((pc) => pc.close()));
  // ソケット/タイマー解放のための短い猶予
  await delay(20);
  await new Promise<void>((r) => setImmediate(r));
}

export function computeBudgets(env: MemleakEnv): {
  datachannel: ScenarioBudget;
  media: ScenarioBudget;
  connection: ScenarioBudget;
} {
  const hours = env.targetHours;
  const iterations = env.iterations;

  const totalDc =
    env.dcMessages ?? Math.round(RATES.dcMessagesPerSec * 3600 * hours);
  const totalMedia =
    env.mediaFrames ?? Math.round(RATES.mediaFps * 3600 * hours);
  const totalConn =
    env.connCycles ??
    Math.max(1, Math.round(RATES.connectionsPerMinute * 60 * hours));

  // 接続ライフサイクルは 1 サイクル = 1 接続。iterations を接続数に合わせる
  const connIterations = env.connCycles ?? totalConn;
  // media/dc は共通 iterations で割る。明示オーバーライド時は 1 サイクル量を直接指定
  const dcPerCycle = env.dcMessages
    ? Math.ceil(env.dcMessages / iterations)
    : Math.max(1, Math.ceil(totalDc / iterations));
  const mediaPerCycle = env.mediaFrames
    ? Math.ceil(env.mediaFrames / iterations)
    : Math.max(1, Math.ceil(totalMedia / iterations));

  // 明示 MEMLEAK_DC_MESSAGES 等は「総量」として解釈し、iterations で分割
  const dcTotal = env.dcMessages ? env.dcMessages : dcPerCycle * iterations;
  const mediaTotal = env.mediaFrames
    ? env.mediaFrames
    : mediaPerCycle * iterations;
  const connTotal = connIterations;

  return {
    datachannel: {
      id: "datachannel",
      label: "DataChannel ループ",
      iterations,
      unitsPerCycle: dcPerCycle,
      totalUnits: dcTotal,
      equivalentSeconds: dcTotal / RATES.dcMessagesPerSec,
      unitName: "messages",
      rateDescription: `${RATES.dcMessagesPerSec} msg/s`,
    },
    media: {
      id: "media",
      label: "メディア通信ループ",
      iterations,
      unitsPerCycle: mediaPerCycle,
      totalUnits: mediaTotal,
      equivalentSeconds: mediaTotal / RATES.mediaFps,
      unitName: "frames",
      rateDescription: `${RATES.mediaFps} fps`,
    },
    connection: {
      id: "connection",
      label: "接続ライフサイクル（コントロール）",
      iterations: connIterations,
      unitsPerCycle: 1,
      totalUnits: connTotal,
      equivalentSeconds: (connTotal / RATES.connectionsPerMinute) * 60,
      unitName: "connections",
      rateDescription: `${RATES.connectionsPerMinute} conn/min`,
    },
  };
}

export function createDataChannelScenario(env: MemleakEnv): Scenario {
  const budget = computeBudgets(env).datachannel;
  const messagesPerCycle = budget.unitsPerCycle;

  return {
    id: "datachannel",
    label: budget.label,
    budget,
    async runCycle(_cycle: number): Promise<CycleResult> {
      const pc1 = new RTCPeerConnection();
      const pc2 = new RTCPeerConnection();
      let stopIce: Unsub = () => {};
      let stopRecv: Unsub = () => {};
      try {
        const openPromise = withTimeout(
          async () =>
            new Promise<[RTCDataChannel, RTCDataChannel]>((resolve, reject) => {
              const dc1 = pc1.createDataChannel("memleak");
              let dc2: RTCDataChannel | undefined;
              const maybeResolve = () => {
                if (dc1.readyState === "open" && dc2?.readyState === "open") {
                  resolve([dc1, dc2]);
                }
              };
              dc1.onopen = () => maybeResolve();
              dc1.onerror = ({ error }) => reject(error);
              pc2.ondatachannel = ({ channel }) => {
                dc2 = channel;
                channel.onopen = () => maybeResolve();
                channel.onerror = ({ error }) => reject(error);
              };
            }),
          15_000,
          "DataChannel open",
        );

        stopIce = exchangeIceCandidates(pc1, pc2);
        await exchangeOfferAnswer(pc1, pc2);
        const [dc1, dc2] = await openPromise;

        let received = 0;
        const receiveTarget = messagesPerCycle;
        const allReceived = withTimeout(
          async () =>
            new Promise<void>((resolve) => {
              const { unSubscribe } = dc2.onMessage.subscribe(() => {
                received++;
                if (received >= receiveTarget) {
                  unSubscribe();
                  resolve();
                }
              });
              stopRecv = unSubscribe;
            }),
          Math.max(120_000, messagesPerCycle * 20),
          `DataChannel receive (${receiveTarget})`,
        );

        // 時間加速: RTT 待ちせず一括送信（bufferedAmount でバックプレッシャー）
        const payload = "m";
        const highWater = 256 * 1024;
        const lowWater = 64 * 1024;
        for (let i = 0; i < messagesPerCycle; i++) {
          if (dc1.bufferedAmount > highWater) {
            await waitForBufferedAmount(dc1, lowWater);
          }
          dc1.send(payload);
          await yieldOccasionally(i, 128);
        }

        await allReceived;
        injectSyntheticLeak(env.injectLeakBytes);
        dc1.onopen = undefined;
        dc1.onerror = undefined;
        dc2.onopen = undefined;
        dc2.onerror = undefined;
        pc2.ondatachannel = null;
        dc1.close();
        dc2.close();
        return { unitsProcessed: messagesPerCycle };
      } finally {
        stopRecv();
        stopIce();
        await closePeers(pc1, pc2);
      }
    },
  };
}

export function createMediaScenario(env: MemleakEnv): Scenario {
  const budget = computeBudgets(env).media;
  const framesPerCycle = budget.unitsPerCycle;

  return {
    id: "media",
    label: budget.label,
    budget,
    async runCycle(_cycle: number): Promise<CycleResult> {
      const sendonly = new RTCPeerConnection();
      const recvonly = new RTCPeerConnection();
      let stopIce: Unsub = () => {};
      const stopRecv: Unsub[] = [];
      try {
        const track = new MediaStreamTrack({ kind: "video" });
        const transceiver = sendonly.addTransceiver(track, {
          direction: "sendonly",
        });

        let received = 0;
        const receiveDone = withTimeout(
          async () =>
            new Promise<void>((resolve) => {
              const sub1 = recvonly.onRemoteTransceiverAdded.subscribe((t) => {
                const sub2 = t.onTrack.subscribe((remoteTrack) => {
                  const sub3 = remoteTrack.onReceiveRtp.subscribe(() => {
                    received++;
                    if (received >= framesPerCycle) {
                      sub3.unSubscribe();
                      sub2.unSubscribe();
                      sub1.unSubscribe();
                      resolve();
                    }
                  });
                  stopRecv.push(sub3.unSubscribe);
                });
                stopRecv.push(sub2.unSubscribe);
              });
              stopRecv.push(sub1.unSubscribe);
            }),
          Math.max(120_000, framesPerCycle * 10),
          `RTP receive (${framesPerCycle})`,
        );

        // sender ready を接続前から購読（発火済みの asPromise 待ちを避ける）
        const senderReady = transceiver.sender.onReady
          .asPromise(10_000)
          .catch(() => undefined);

        stopIce = exchangeIceCandidates(sendonly, recvonly);
        await exchangeOfferAnswer(sendonly, recvonly);
        await Promise.all([waitConnected(sendonly), senderReady]);

        // 時間加速: 30fps ペーシング無しでタイトループ送信
        const payload = Buffer.alloc(64, 0x11);
        for (let i = 0; i < framesPerCycle; i++) {
          const packet = new RtpPacket(
            new RtpHeader({
              sequenceNumber: i % 65536,
              timestamp: (i * 3000) >>> 0,
              payloadType: 96,
              marker: true,
            }),
            payload,
          );
          track.writeRtp(packet);
          await yieldOccasionally(i, 64);
        }

        await receiveDone;
        injectSyntheticLeak(env.injectLeakBytes);
        return { unitsProcessed: framesPerCycle };
      } finally {
        for (const u of stopRecv) u();
        stopIce();
        await closePeers(sendonly, recvonly);
      }
    },
  };
}

export function createConnectionScenario(env: MemleakEnv): Scenario {
  const budget = computeBudgets(env).connection;

  return {
    id: "connection",
    label: budget.label,
    budget,
    async runCycle(_cycle: number): Promise<CycleResult> {
      // メディア/データなしで ICE → DTLS → SCTP 確立と close のみ
      const pc1 = new RTCPeerConnection();
      const pc2 = new RTCPeerConnection();
      let stopIce: Unsub = () => {};
      try {
        // SCTP 確立を促すため DataChannel を 1 本作成するがメッセージは送らない
        const dc = pc1.createDataChannel("lifecycle");
        const dcOpen = withTimeout(
          async () =>
            new Promise<void>((resolve, reject) => {
              dc.onopen = () => resolve();
              dc.onerror = ({ error }) => reject(error);
            }),
          15_000,
          "DC open",
        );
        stopIce = exchangeIceCandidates(pc1, pc2);
        await exchangeOfferAnswer(pc1, pc2);
        await Promise.all([waitConnected(pc1), waitConnected(pc2), dcOpen]);
        injectSyntheticLeak(env.injectLeakBytes);
        dc.onopen = undefined;
        dc.onerror = undefined;
        dc.close();
        return { unitsProcessed: 1 };
      } finally {
        stopIce();
        await closePeers(pc1, pc2);
      }
    },
  };
}

/**
 * 合成リーク検証用シナリオ。
 * PeerConnection は張らず、意図的にオブジェクトを保持してヒープ増加を起こす。
 * 本シナリオの FAIL は検出ロジックの健全性確認であり、本番リークではない。
 */
export function createSyntheticLeakScenario(env: MemleakEnv): Scenario {
  const iterations = Math.min(env.iterations, 20);
  const leakBytes = env.injectLeakBytes > 0 ? env.injectLeakBytes : 256 * 1024;
  return {
    id: "synthetic-leak",
    label: "合成リーク（検出ロジック検証・FAIL 期待）",
    expectedLeak: true,
    budget: {
      id: "synthetic-leak",
      label: "合成リーク（検出ロジック検証・FAIL 期待）",
      iterations,
      unitsPerCycle: 1,
      totalUnits: iterations,
      equivalentSeconds: 0,
      unitName: "leaks",
      rateDescription: "n/a",
    },
    async runCycle(): Promise<CycleResult> {
      injectSyntheticLeak(leakBytes);
      // わずかに非同期処理を挟んで計測タイミングを実試験に近づける
      await delay(5);
      return { unitsProcessed: 1 };
    },
  };
}

export function createAllScenarios(env: MemleakEnv): Scenario[] {
  return [
    createConnectionScenario(env),
    createDataChannelScenario(env),
    createMediaScenario(env),
  ];
}
