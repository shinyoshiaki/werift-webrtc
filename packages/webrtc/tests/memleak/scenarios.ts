/**
 * メモリリーク試験の主要ユースケースシナリオ定義。
 * 実時間 1 時間相当の処理量バジェットを計算し、時間加速して消化する。
 */
import { setTimeout as delay } from "node:timers/promises";

import {
  MediaStreamTrack,
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
  /** 1 サイクル実行。接続確立 → 処理 → close */
  runCycle: (cycle: number) => Promise<CycleResult>;
};

function exchangeIceCandidates(
  pc1: RTCPeerConnection,
  pc2: RTCPeerConnection,
): void {
  const forward = (local: RTCPeerConnection, remote: RTCPeerConnection) => {
    local.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return;
      if (remote.signalingState !== "closed") {
        remote.addIceCandidate(candidate).catch((error) => {
          if ((error as Error).message !== "The remote description was null") {
            throw error;
          }
        });
      }
    });
  };
  forward(pc1, pc2);
  forward(pc2, pc1);
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
  await Promise.race([
    pc.connectionStateChange.watch((v) => v === "connected"),
    delay(timeoutMs).then(() => {
      throw new Error(
        `connectionState did not become connected (state=${pc.connectionState})`,
      );
    }),
  ]);
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
    async runCycle(cycle: number): Promise<CycleResult> {
      const pc1 = new RTCPeerConnection();
      const pc2 = new RTCPeerConnection();
      try {
        const openPromise = new Promise<
          [
            import("../../src").RTCDataChannel,
            import("../../src").RTCDataChannel,
          ]
        >((resolve, reject) => {
          const dc1 = pc1.createDataChannel("memleak");
          let dc2: import("../../src").RTCDataChannel | undefined;
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
          setTimeout(
            () => reject(new Error("DataChannel open timeout")),
            15_000,
          );
        });

        exchangeIceCandidates(pc1, pc2);
        await exchangeOfferAnswer(pc1, pc2);
        const [dc1, dc2] = await openPromise;

        let received = 0;
        const receiveTarget = messagesPerCycle;
        const allReceived = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(
                  `DataChannel receive timeout (${received}/${receiveTarget})`,
                ),
              ),
            Math.max(120_000, messagesPerCycle * 20),
          );
          dc2.onMessage.subscribe(() => {
            received++;
            if (received >= receiveTarget) {
              clearTimeout(timer);
              resolve();
            }
          });
        });

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
        dc1.close();
        dc2.close();
        return { unitsProcessed: messagesPerCycle };
      } finally {
        await Promise.all([pc1.close(), pc2.close()]);
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
      try {
        const track = new MediaStreamTrack({ kind: "video" });
        const transceiver = sendonly.addTransceiver(track, {
          direction: "sendonly",
        });

        let received = 0;
        const receiveDone = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(
                  `RTP receive timeout (${received}/${framesPerCycle})`,
                ),
              ),
            Math.max(120_000, framesPerCycle * 10),
          );
          recvonly.onRemoteTransceiverAdded.subscribe((t) => {
            t.onTrack.subscribe((remoteTrack) => {
              remoteTrack.onReceiveRtp.subscribe(() => {
                received++;
                if (received >= framesPerCycle) {
                  clearTimeout(timer);
                  resolve();
                }
              });
            });
          });
        });

        // sender ready を接続前から購読（発火済みの asPromise 待ちを避ける）
        const senderReady = transceiver.sender.onReady
          .asPromise(10_000)
          .catch(() => undefined);

        exchangeIceCandidates(sendonly, recvonly);
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
        await Promise.all([sendonly.close(), recvonly.close()]);
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
      try {
        // SCTP 確立を促すため DataChannel を 1 本作成するがメッセージは送らない
        const dc = pc1.createDataChannel("lifecycle");
        const dcOpen = new Promise<void>((resolve, reject) => {
          dc.onopen = () => resolve();
          dc.onerror = ({ error }) => reject(error);
          setTimeout(() => reject(new Error("DC open timeout")), 15_000);
        });
        exchangeIceCandidates(pc1, pc2);
        await exchangeOfferAnswer(pc1, pc2);
        await Promise.all([waitConnected(pc1), waitConnected(pc2), dcOpen]);
        injectSyntheticLeak(env.injectLeakBytes);
        dc.close();
        return { unitsProcessed: 1 };
      } finally {
        await Promise.all([pc1.close(), pc2.close()]);
      }
    },
  };
}

/**
 * 合成リーク検証用シナリオ。
 * PeerConnection は張らず、意図的に Buffer を保持してヒープ増加を起こす。
 */
export function createSyntheticLeakScenario(env: MemleakEnv): Scenario {
  const iterations = Math.min(env.iterations, 20);
  const leakBytes = env.injectLeakBytes > 0 ? env.injectLeakBytes : 256 * 1024;
  return {
    id: "synthetic-leak",
    label: "合成リーク（検出ロジック検証）",
    budget: {
      id: "synthetic-leak",
      label: "合成リーク（検出ロジック検証）",
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
