/**
 * Shared Arrange for the data channel flow-control and close-delivery tests
 * (`bufferedAmount.test.ts`, `closeDelivery.test.ts`): channel pairs, loss
 * injection, notification recorders and not-yet-connected channels.
 *
 * The behavior under test is checked through the public RTCDataChannel API
 * only (`send`, `close`, `bufferedAmount`, `bufferedAmountLowThreshold`,
 * `bufferedamountlow`, `close`); only loss injection reaches below it.
 */

import { DataChunk, parsePacket } from "../../../sctp/src/chunk";
import { type RTCDataChannel, RTCPeerConnection } from "../../src";
import { createDataChannelPair } from "../utils";

export type ChannelOptions = Parameters<typeof createDataChannelPair>[0];

/** Open channel pair on two new PeerConnections, with a cleanup. */
export async function openChannelPair(options: ChannelOptions = {}) {
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();
  const [local, remote] = await createDataChannelPair(options, pc1, pc2);
  const close = async () => {
    await pc1.close();
    await pc2.close();
  };
  return { pc1, pc2, local, remote, close };
}

/**
 * Counts each kind of `bufferedamountlow` notification (Event,
 * `onbufferedamountlow`, `addEventListener`) and the bufferedAmount seen.
 */
export function recordBufferedAmountLow(channel: RTCDataChannel) {
  const record = { event: 0, handler: 0, listener: 0, amounts: [] as number[] };
  channel.bufferedAmountLow.subscribe(() => {
    record.event++;
    record.amounts.push(channel.bufferedAmount);
  });
  channel.onbufferedamountlow = () => record.handler++;
  channel.addEventListener("bufferedamountlow", () => record.listener++);
  return record;
}

/** Resolves on the next `bufferedamountlow` of the channel. */
export function nextBufferedAmountLow(channel: RTCDataChannel) {
  return new Promise<void>((resolve) =>
    channel.addEventListener("bufferedamountlow", () => resolve(), {
      once: true,
    }),
  );
}

/** Resolves when the channel fires `close`. */
export function closed(channel: RTCDataChannel) {
  return new Promise<void>((resolve) => {
    if (channel.readyState === "closed") return resolve();
    channel.addEventListener("close", () => resolve(), { once: true });
  });
}

/** Records every message of the channel, and at which point `close` fired. */
export function recordMessagesUntilClose(channel: RTCDataChannel) {
  const record = {
    messages: [] as (string | Buffer)[],
    /** Number of messages received when `close` fired. */
    atClose: undefined as number | undefined,
  };
  channel.onMessage.subscribe((data) => record.messages.push(data));
  channel.addEventListener("close", () => {
    record.atClose = record.messages.length;
  });
  return record;
}

/**
 * Loss on the SCTP packets `pc` sends: `drop(index)` decides per packet
 * carrying DATA (index = DATA packets before it); `enabled` switches it.
 * Below the public API on purpose: it only shapes the network.
 */
export function injectDataLoss(
  pc: RTCPeerConnection,
  drop: (index: number) => boolean,
) {
  const lower = pc.sctpTransport!.sctp.transport;
  const send = lower.send.bind(lower);
  const loss = { enabled: true, dataPackets: 0, dropped: 0 };
  (lower as { send: (packet: Buffer) => Promise<void> }).send = (packet) => {
    const [, , , chunks] = parsePacket(packet);
    if (chunks.some((c) => c instanceof DataChunk)) {
      const index = loss.dataPackets++;
      if (loss.enabled && drop(index)) {
        loss.dropped++;
        return Promise.resolve();
      }
    }
    return send(packet);
  };
  return loss;
}

/**
 * Negotiated channel pair (`id`) whose PeerConnections are not connected
 * yet: the local channel is `connecting`. `connect()` negotiates.
 */
export function negotiatedChannelsBeforeConnect(id = 0) {
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();
  const local = pc1.createDataChannel("pending", { negotiated: true, id });
  const remote = pc2.createDataChannel("pending", { negotiated: true, id });
  const connect = async () => {
    pc1.onIceCandidate.subscribe((c) => c && pc2.addIceCandidate(c));
    pc2.onIceCandidate.subscribe((c) => c && pc1.addIceCandidate(c));
    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription!);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(pc2.localDescription!);
  };
  const close = async () => {
    await pc1.close();
    await pc2.close();
  };
  return { pc1, pc2, local, remote, connect, close };
}

/** Lets SCTP deliveries and their microtasks run for `ms`. */
export const settle = (ms = 200) =>
  new Promise((resolve) => setTimeout(resolve, ms));
