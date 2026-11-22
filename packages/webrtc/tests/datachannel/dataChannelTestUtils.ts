import {
  type RTCDataChannel,
  type RTCDataChannelMessageData,
  RTCPeerConnection,
  type RTCPeerConnectionConfig,
} from "../../src";
import { createDataChannelPair } from "../utils";

/**
 * Arrange: an open in-band channel pair between two PeerConnections created
 * with `config` (or by `create`, e.g. a polyfill constructor).
 */
export async function openDataChannelPair({
  config = {},
  remoteConfig = config,
  create = (c: RTCPeerConnectionConfig) => new RTCPeerConnection(c),
}: {
  config?: RTCPeerConnectionConfig;
  remoteConfig?: RTCPeerConnectionConfig;
  create?: (config: RTCPeerConnectionConfig) => RTCPeerConnection;
} = {}) {
  const offerer = create(config);
  const answerer = create(remoteConfig);
  const [local, remote] = await createDataChannelPair({}, offerer, answerer);
  return {
    offerer,
    answerer,
    local,
    remote,
    close: () => Promise.all([offerer.close(), answerer.close()]),
  };
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
export function recordBufferedAmountLow(channel: RTCDataChannel) {
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
