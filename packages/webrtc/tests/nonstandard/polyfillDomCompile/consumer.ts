import { useH264 } from "../../../src";
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

// --- werift の track / stream を DOM 型の API へキャストなしで渡せる ---

import {
  MediaStream as WeriftMediaStream,
  MediaStreamTrack as WeriftMediaStreamTrack,
} from "../../../src";
import {
  MediaStream as DomMediaStream,
  MediaStreamTrack as DomMediaStreamTrack,
} from "../../../src/polyfill/dom";

// mediasoup-client の ProducerOptions / Producer を模した DOM 型の API。
declare function produce(options: {
  track?: MediaStreamTrack;
  appData?: Record<string, unknown>;
}): Promise<{ track: MediaStreamTrack | null }>;

const weriftTrack = new WeriftMediaStreamTrack({ kind: "audio" });
void produce({ track: weriftTrack, appData: { type: "webcam" } });
void produce({ track: weriftTrack.clone() });

const weriftStream = new WeriftMediaStream([
  weriftTrack,
  new WeriftMediaStreamTrack({ kind: "video" }),
]);
const domStream: MediaStream = weriftStream;
const domAudio: MediaStreamTrack[] = weriftStream.getAudioTracks();
const domTrack: MediaStreamTrack | null = weriftStream.getTrackById("id");
void domStream;
void domAudio;
void domTrack;

// werift/polyfill/dom の constructor は lib.dom の引数なし constructor の代わりに使える。
const polyfillTrack: MediaStreamTrack = new DomMediaStreamTrack({
  kind: "video",
});
polyfillTrack.writeRtp;
const polyfillStream: MediaStream = new DomMediaStream([weriftTrack]);
polyfillStream.addTrack(polyfillTrack);
void polyfillStream;
void produce({ track: new DomMediaStreamTrack({ kind: "audio" }) });

// DOM 型が将来メンバーを増やしたら、ここで差分が型エラーになる。
type MissingTrackMembers = Exclude<
  keyof MediaStreamTrack,
  keyof WeriftMediaStreamTrack
>;
type MissingStreamMembers = Exclude<keyof MediaStream, keyof WeriftMediaStream>;
const noMissingTrackMembers: [MissingTrackMembers] extends [never]
  ? true
  : MissingTrackMembers = true;
const noMissingStreamMembers: [MissingStreamMembers] extends [never]
  ? true
  : MissingStreamMembers = true;
void noMissingTrackMembers;
void noMissingStreamMembers;

// polyfill/dom の augmentation は werift のクラスと同じ型を持つ。
const onReceiveRtp: WeriftMediaStreamTrack["onReceiveRtp"] = track.onReceiveRtp;
const domOnReceiveRtp: MediaStreamTrack["onReceiveRtp"] =
  weriftTrack.onReceiveRtp;
void onReceiveRtp;
void domOnReceiveRtp;
