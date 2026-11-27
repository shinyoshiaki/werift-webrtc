import { DataChunk, parsePacket } from "../../../sctp/src/chunk";
import {
  type RTCDataChannel,
  type RTCDataChannelMessageData,
  RTCPeerConnection,
  type RTCPeerConnectionConfig,
} from "../../src";
import { createDataChannelPair } from "../utils";

export type ChannelOptions = Parameters<typeof createDataChannelPair>[0];

export async function openChannelPair(
  options: ChannelOptions = {},
  {
    config = {},
    remoteConfig = config,
    create = (c: RTCPeerConnectionConfig) => new RTCPeerConnection(c),
  }: {
    config?: RTCPeerConnectionConfig;
    remoteConfig?: RTCPeerConnectionConfig;
    create?: (config: RTCPeerConnectionConfig) => RTCPeerConnection;
  } = {},
) {
  const pc1 = create(config);
  const pc2 = create(remoteConfig);
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

export async function channelsToCloseWhileSending(
  mode: "before-connect" | "open",
) {
  if (mode === "before-connect") return negotiatedChannelsBeforeConnect();
  const pair = await openChannelPair();
  return { ...pair, connect: async () => {} };
}

/**
 * The next message as each surface sees it: `onMessage` (werift),
 * `onmessage` and the `"message"` event.
 */
export function nextMessageOnEverySurface(channel: RTCDataChannel) {
  return new Promise<{
    onMessage: string | Buffer;
    onmessage: RTCDataChannelMessageData;
    event: RTCDataChannelMessageData;
  }>((resolve) => {
    let onMessage: string | Buffer | undefined;
    let event: RTCDataChannelMessageData | undefined;
    const { unSubscribe } = channel.onMessage.subscribe((data) => {
      onMessage = data;
    });
    const listener = (e: { data: RTCDataChannelMessageData }) => {
      event = e.data;
    };
    channel.addEventListener("message", listener);
    channel.onmessage = ({ data }) => {
      unSubscribe();
      channel.removeEventListener("message", listener);
      channel.onmessage = undefined;
      resolve({ onMessage: onMessage!, onmessage: data, event: event! });
    };
  });
}

/**
 * Deliver a raw SCTP user message to `channel` as if the peer sent it
 * (e.g. an empty message, PPID 56 / 57 of RFC 8831, which werift does not
 * send itself).
 */
export function receiveRawMessage(
  channel: RTCDataChannel,
  ppId: number,
  data: Buffer,
) {
  const receive = (channel.sctp as any).datachannelReceive as (
    streamId: number,
    ppId: number,
    data: Buffer,
  ) => Promise<void>;
  return receive(channel.id, ppId, data);
}

/** The bytes of a received binary message in any `binaryType` form. */
export async function bytesOf(data: RTCDataChannelMessageData) {
  if (typeof data === "string") throw new Error("not binary");
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(await data.arrayBuffer());
}

/**
 * Record every `bufferedamountlow` notification of `channel` in order:
 * `bufferedAmountLow` (werift Event), `onbufferedamountlow` and the
 * `"bufferedamountlow"` event.
 */
export function recordBufferedAmountLowOrder(channel: RTCDataChannel) {
  const calls: string[] = [];
  channel.bufferedAmountLow.subscribe(() => calls.push("bufferedAmountLow"));
  channel.onbufferedamountlow = () => calls.push("onbufferedamountlow");
  channel.addEventListener("bufferedamountlow", () => calls.push("event"));
  return calls;
}

export const LOW_NOTIFICATIONS = [
  "bufferedAmountLow",
  "onbufferedamountlow",
  "event",
] as const;
