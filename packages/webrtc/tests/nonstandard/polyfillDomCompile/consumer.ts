import {
  RTCSessionDescription as CoreRTCSessionDescription,
  useH264,
  type RTCDataChannel as WeriftRTCDataChannel,
} from "../../../src";
import {
  createCallbackRegister,
  createEmptyRegister,
  createEncodedBinaryRegister,
  createMp4WebmRegister,
  createRtpRtcpRegister,
  installPolyfill,
} from "../../../src/polyfill/dom";

const uninstall = installPolyfill({
  peerConnectionConfig: { codecs: { video: [useH264()] } },
  mediaRegister: [
    createEmptyRegister(),
    createCallbackRegister({
      mimeType: "video/VP8",
      kinds: ["video"],
      async createTracks() {
        return [];
      },
    }),
    createRtpRtcpRegister({
      mimeType: "video/VP8",
      udp: { port: 0 },
    }),
    createEncodedBinaryRegister({
      mimeType: "video/VP8",
      udp: { port: 0 },
    }),
    createMp4WebmRegister({
      binary: new Uint8Array([0, 0, 0, 0]),
    }),
  ],
});
uninstall();

declare const track: MediaStreamTrack;
track.writeRtp;
track.onReceiveRtp;

// RTCDataChannel / RTCSessionDescription (#375): lib.dom との型互換。
declare const weriftChannel: WeriftRTCDataChannel;
declare const domChannel: globalThis.RTCDataChannel;
domChannel.onbufferedamountlow = weriftChannel.onbufferedamountlow ?? null;
const threshold: number = weriftChannel.bufferedAmountLowThreshold;
const buffered: number = weriftChannel.bufferedAmount;
const state: RTCDataChannelState = weriftChannel.readyState;
const label: string = weriftChannel.label;
void [threshold, buffered, state, label];
// DOM の BinaryType は werift の binaryType に代入できる
weriftChannel.binaryType = domChannel.binaryType;
// werift の binaryType は "nodebuffer" を含むので DOM 側へは代入できない
declare const weriftBinaryType: WeriftRTCDataChannel["binaryType"];
// @ts-expect-error
domChannel.binaryType = weriftBinaryType;

declare const domInit: globalThis.RTCSessionDescriptionInit;
const coreDescription = new CoreRTCSessionDescription(domInit);
const domDescription: globalThis.RTCSessionDescriptionInit =
  coreDescription.toJSON();
void domDescription;
