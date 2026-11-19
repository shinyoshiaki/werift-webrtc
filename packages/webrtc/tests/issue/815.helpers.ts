/**
 * Issue #815 (DataChannel の stream ID を DTLS role から採番する) テストの
 * Arrange 用ユーティリティ。
 */
import { expect, vi } from "vitest";

import {
  type RTCDataChannel,
  type RTCDtlsTransport,
  RTCPeerConnection,
  RTCSctpTransport,
} from "../../src";
import type { RTCSessionDescriptionInit } from "../../src/sdpManager";
import { createDtlsTransport } from "../fixture";
import {
  createConnectedVideoPeers,
  exchangePranswer,
  waitForChannelState,
} from "../negotiation/harness/negotiationTransactionUtils";

export type Setup = "actpass" | "active" | "passive";

/** SDP の全 `a=setup` を書き換える (#815 の再現: ICE と DTLS の対応を逆にする)。 */
export function withSetup(sdp: string, setup: Setup) {
  return sdp.replace(/a=setup:\w+/g, `a=setup:${setup}`);
}

/**
 * ICE candidate を trickle で交換する 2 つの PeerConnection。ICE restart 後に
 * 届く旧世代の candidate は相手が拒否するので無視する。
 */
export function createPeers() {
  const offerer = new RTCPeerConnection({ iceServers: [] });
  const answerer = new RTCPeerConnection({ iceServers: [] });
  for (const [from, to] of [
    [offerer, answerer],
    [answerer, offerer],
  ]) {
    from.onIceCandidate.subscribe((candidate) => {
      if (!candidate || to.signalingState === "closed") return;
      to.addIceCandidate(candidate).catch(() => {});
    });
  }
  return { offerer, answerer };
}

/**
 * offer / answer を 1 往復する。`answerSetup` は answerer が適用する answer
 * ごと書き換える (offerer も同じ SDP を受け取る)。`onAnswered` は answer を
 * 適用した各 peer について、次の await の前に呼ばれる。
 */
export async function negotiate(
  offerer: RTCPeerConnection,
  answerer: RTCPeerConnection,
  {
    answerSetup,
    onAnswered = () => {},
  }: {
    answerSetup?: Setup;
    onAnswered?: (side: "offerer" | "answerer") => void;
  } = {},
) {
  const offer = await offerer.createOffer();
  await offerer.setLocalDescription(offer);
  await answerer.setRemoteDescription(offer);
  const createdAnswer = await answerer.createAnswer();
  const answer: RTCSessionDescriptionInit = {
    type: "answer",
    sdp: answerSetup
      ? withSetup(createdAnswer.sdp, answerSetup)
      : createdAnswer.sdp,
  };
  await answerer.setLocalDescription(answer);
  onAnswered("answerer");
  await offerer.setRemoteDescription(answer);
  onAnswered("offerer");
}

/** channel が open になるのを待つ (error / close なら失敗)。 */
export function waitOpen(channel: RTCDataChannel) {
  return new Promise<void>((resolve, reject) => {
    if (channel.readyState === "open") return resolve();
    channel.stateChanged.subscribe((state) => {
      if (state === "open") resolve();
      if (state === "closed") reject(new Error(`${channel.label} closed`));
    });
  });
}

/** 相手 peer に通知された label の channel を待つ。 */
export function waitRemoteChannel(pc: RTCPeerConnection, label: string) {
  return new Promise<RTCDataChannel>((resolve) => {
    pc.onDataChannel.subscribe((channel) => {
      if (channel.label === label) resolve(channel);
    });
  });
}

/** channel に届く最初のメッセージ。 */
export function nextMessage(channel: RTCDataChannel) {
  return channel.onMessage.asPromise().then(([data]) => data.toString());
}

export async function closeAll(...pcs: RTCPeerConnection[]) {
  await Promise.all(pcs.map((pc) => pc.close()));
}

/** close 通知の時点で見える PeerConnection / SCTP / DTLS の状態。 */
export interface CloseObservation {
  label: string;
  connectionState: string;
  sctpState: string | undefined;
  dtlsState: string | undefined;
}

/**
 * 各 channel の close 通知の時点で、PeerConnection・SCTP・DTLS の状態を記録する。
 * 記録用リスナーは呼び出し時点で最後に登録される。
 */
export function observeCloseStates(
  pc: RTCPeerConnection,
  channels: RTCDataChannel[],
) {
  const observed: CloseObservation[] = [];
  for (const channel of channels) {
    channel.addEventListener("close", () => {
      const sctp = (pc as any).sctpManager.sctpTransport;
      observed.push({
        label: channel.label,
        connectionState: pc.connectionState,
        sctpState: sctp?.state,
        dtlsState: sctp?.dtlsTransport?.state,
      });
    });
  }
  return observed;
}

/** 全状態が closed であることを表す close 通知時の観測値。 */
export function closedObservation(label: string): CloseObservation {
  return {
    label,
    connectionState: "closed",
    sctpState: "closed",
    dtlsState: "closed",
  };
}

/** maxChannels を 2 に絞った SCTP transport (DTLS role は未確定)。 */
export function createLimitedTransport() {
  const dtls: RTCDtlsTransport = createDtlsTransport();
  const transport = new RTCSctpTransport();
  transport.setDtlsTransport(dtls);
  transport.sctp._inboundStreamsCount = 2;
  transport.sctp._outboundStreamsCount = 2;
  return { dtls, transport };
}

/**
 * `createLimitedTransport` を PeerConnection の SCTP transport として差し込む。
 * 返す `create` は公開入口 (`SctpTransportManager.createDataChannel`) で channel を作る。
 */
export function attachLimitedTransport(pc: RTCPeerConnection) {
  const limited = createLimitedTransport();
  const manager = (pc as any).sctpManager;
  manager.sctpTransport = limited.transport;
  const create = (label: string): RTCDataChannel =>
    manager.createDataChannel(label);
  return { ...limited, create };
}

/** 接続済みの 2 peer と、offerer が作り両端で open になった channel "dc"。 */
export async function openChannelPair() {
  const { offerer, answerer } = createPeers();
  const remoteChannel = waitRemoteChannel(answerer, "dc");
  const local = offerer.createDataChannel("dc");
  await negotiate(offerer, answerer);
  await waitOpen(local);
  const remote = await remoteChannel;
  await waitOpen(remote);
  return { offerer, answerer, local, remote };
}

/**
 * 接続済みの video セッションに後付けした channel "late" を pranswer で open にする
 * (pending-only の association。rollback / final answer の拒否で破棄される)。
 */
export async function openProvisionalChannel() {
  const { offerer, answerer } = await createConnectedVideoPeers();
  const local = offerer.createDataChannel("late");
  const answer = await exchangePranswer(offerer, answerer);
  await waitForChannelState(local, "open");
  return { offerer, answerer, local, answer };
}

/** 通知の時点でコールバックから見える状態。 */
export interface NotificationObservation {
  connectionState: string;
  sctpState: string | undefined;
  dtlsState: string | undefined;
  id: number | undefined;
  readyState: string;
}

/** channel の `type` 通知の時点で見える状態を記録する (呼び出し時点で最後のリスナー)。 */
export function observeAt(
  pc: RTCPeerConnection,
  channel: RTCDataChannel,
  type: "close" | "error" = "close",
) {
  const observed: NotificationObservation[] = [];
  channel.addEventListener(type, () => {
    const sctp = (pc as any).sctpManager.sctpTransport;
    observed.push({
      connectionState: pc.connectionState,
      sctpState: sctp?.state,
      dtlsState: sctp?.dtlsTransport?.state,
      id: channel.id,
      readyState: channel.readyState,
    });
  });
  return observed;
}

/**
 * SCTP transport の内部集合: 登録表 (stream ID → channel)、OPEN 未送信の
 * channel、送信待ちキューの channel。`label:readyState` で表す。
 */
export function channelSetsOf(pc: RTCPeerConnection) {
  const transport = (pc as any).sctpManager.sctpTransport;
  const describe = (channel: RTCDataChannel) =>
    `${channel.label}:${channel.readyState}`;
  return {
    registered: Object.values(transport.dataChannels as object).map(describe),
    unannounced: [...transport.unannounced].map(describe),
    queued: transport.dataChannelQueue
      .toArray()
      .map(([channel]: [RTCDataChannel]) => channel.label),
  };
}

/** 例外を投げるリスナー (先頭に登録して、後続が止まらないことを確かめる)。 */
export function throwing(name: string) {
  return () => {
    throw new Error(`${name} listener failed`);
  };
}

/** createDataChannel を試し、`created` か `throws:<name>` を返す (再入の確認用)。 */
export function tryCreateDataChannel(
  pc: RTCPeerConnection,
  label = "in-callback",
) {
  try {
    pc.createDataChannel(label);
    return "created";
  } catch (error) {
    return `throws:${(error as Error).name}`;
  }
}

/**
 * `pc` の in-band 採番を指定の偶奇に固定する (DTLS role の偶奇規則に違反する
 * 相手、たとえば ICE role から偶奇を決めていた旧 werift の再現)。
 */
export function forceIdParity(pc: RTCPeerConnection, parity: 0 | 1) {
  const transport = (pc as any).sctpManager.sctpTransport;
  Object.defineProperty(transport, "idParity", {
    get: () => parity,
    configurable: true,
  });
}

/** `pc` が SCTP に渡した DCEP メッセージ (`OPEN:<stream>` / `ACK:<stream>`)。 */
export function captureSentDcep(pc: RTCPeerConnection) {
  const sctp = (pc as any).sctpManager.sctpTransport.sctp;
  const sent: string[] = [];
  const send = sctp.send.bind(sctp);
  sctp.send = (
    streamId: number,
    ppId: number,
    data: Buffer,
    ...rest: any[]
  ) => {
    if (ppId === 50) {
      sent.push(
        `${data[0] === 3 ? "OPEN" : data[0] === 2 ? "ACK" : data[0]}:${streamId}`,
      );
    }
    return send(streamId, ppId, data, ...rest);
  };
  return sent;
}

/** `pc` 側の stream ID 上限を `count` に絞る (SCTP が交渉した stream 数の代わり)。 */
export function limitStreams(pc: RTCPeerConnection, count: number) {
  const sctp = (pc as any).sctpManager.sctpTransport.sctp;
  sctp._inboundStreamsCount = count;
  sctp._outboundStreamsCount = count;
}

/** 両端が同じ ID で作る negotiated channel。 */
export function createNegotiatedPair(
  offerer: RTCPeerConnection,
  answerer: RTCPeerConnection,
  { label, id, ordered }: { label: string; id: number; ordered: boolean },
) {
  const options = { negotiated: true, id, ordered };
  return {
    local: offerer.createDataChannel(label, options),
    remote: answerer.createDataChannel(label, options),
  };
}

/** 接続済みの 2 peer と、両端で open になった negotiated channel。 */
export async function openNegotiatedPair(options: {
  id: number;
  ordered: boolean;
}) {
  const { offerer, answerer } = createPeers();
  const { local, remote } = createNegotiatedPair(offerer, answerer, {
    label: "dc",
    ...options,
  });
  await negotiate(offerer, answerer);
  await Promise.all([waitOpen(local), waitOpen(remote)]);
  return { offerer, answerer, local, remote };
}

/** `from` から送ったメッセージが `to` に届くのを待つ。 */
export async function deliver(
  from: RTCDataChannel,
  to: RTCDataChannel,
  text: string,
) {
  const received = nextMessage(to);
  from.send(text);
  await expect(received).resolves.toBe(text);
}

/** channel が closed になるのを待つ。 */
export function waitClosed(channel: RTCDataChannel) {
  return vi.waitFor(() => expect(channel.readyState).toBe("closed"), {
    timeout: 5_000,
  });
}

/**
 * `pc` の stream reset 処理を develop (7a1cb6f6c 以前の werift) と同じにする:
 * どちらかの方向の reset で channel をすぐ閉じ、相手の reset には SCTP が
 * ordered で送った stream についてだけ答える。
 */
export function emulateLegacyResetHandling(pc: RTCPeerConnection) {
  const transport = (pc as any).sctpManager.sctpTransport;
  transport.onStreamsReset = (ids: number[]) => {
    for (const id of ids) {
      const channel = transport.dataChannels[id];
      if (!channel) continue;
      channel.setReadyState("closing");
      channel.setReadyState("closed");
      delete transport.dataChannels[id];
    }
  };
}

/** `pc` が相手の reset を待つ時間 (reverseResetTimeout) を `ms` にする。 */
export function setReverseResetTimeout(pc: RTCPeerConnection, ms: number) {
  (pc as any).sctpManager.sctpTransport.reverseResetTimeout = ms;
}

/** SCTP transport が close 中として追跡している stream。 */
export function closingStreamsOf(pc: RTCPeerConnection) {
  return [...(pc as any).sctpManager.sctpTransport.closingStreams.keys()];
}
