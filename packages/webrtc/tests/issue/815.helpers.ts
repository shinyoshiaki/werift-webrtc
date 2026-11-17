/**
 * Issue #815 (DataChannel の stream ID を DTLS role から採番する) テストの
 * Arrange 用ユーティリティ。
 */
import { type RTCDataChannel, RTCPeerConnection } from "../../src";
import type { RTCSessionDescriptionInit } from "../../src/sdpManager";

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
