import { DataChunk, parsePacket } from "../../../sctp/src/chunk";
import { type RTCDataChannel, RTCPeerConnection } from "../../src";
import { createDataChannelPair } from "../utils";

export type ChannelOptions = Parameters<typeof createDataChannelPair>[0];

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

export function nextBufferedAmountLow(channel: RTCDataChannel) {
  return new Promise<void>((resolve) =>
    channel.addEventListener("bufferedamountlow", () => resolve(), {
      once: true,
    }),
  );
}

export function closed(channel: RTCDataChannel) {
  return new Promise<void>((resolve) => {
    if (channel.readyState === "closed") return resolve();
    channel.addEventListener("close", () => resolve(), { once: true });
  });
}

export function recordMessagesUntilClose(channel: RTCDataChannel) {
  const record = {
    messages: [] as (string | Buffer)[],
    messagesAtClose: undefined as number | undefined,
  };
  channel.onMessage.subscribe((data) => record.messages.push(data));
  channel.addEventListener("close", () => {
    record.messagesAtClose = record.messages.length;
  });
  return record;
}

export function injectDataLoss(
  pc: RTCPeerConnection,
  drop: (dataPacketIndex: number) => boolean,
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

export function holdLowerSends(pc: RTCPeerConnection) {
  const lower = pc.sctpTransport!.sctp.transport;
  const send = lower.send.bind(lower);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = { packets: 0 };
  (lower as { send: (packet: Buffer) => Promise<void> }).send = async (
    packet,
  ) => {
    held.packets++;
    await gate;
    await send(packet);
  };
  return {
    held,
    release: () => {
      (lower as { send: (packet: Buffer) => Promise<void> }).send = send;
      release();
    },
  };
}

export function peersBeforeConnect() {
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();
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
  return { pc1, pc2, connect, close };
}

export function negotiatedChannelsBeforeConnect(id = 0) {
  const peers = peersBeforeConnect();
  const local = peers.pc1.createDataChannel("pending", {
    negotiated: true,
    id,
  });
  const remote = peers.pc2.createDataChannel("pending", {
    negotiated: true,
    id,
  });
  return { ...peers, local, remote };
}

export const settleSctpDeliveries = (ms = 200) =>
  new Promise((resolve) => setTimeout(resolve, ms));
