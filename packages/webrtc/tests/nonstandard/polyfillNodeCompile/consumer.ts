import { useH264 } from "../../../src";
import { installPolyfill } from "../../../src/polyfill";

const uninstall = installPolyfill({
  mediaRegister: [],
  peerConnectionConfig: { codecs: { video: [useH264()] } },
});
const pc = new RTCPeerConnection();
const stream = new MediaStream();
void navigator.mediaDevices.getUserMedia;
void navigator.userAgent;
void MediaStreamTrack;
uninstall();
void pc;
void stream;

// RTCSessionDescription の辞書形式と binaryType (#375)
const description = new RTCSessionDescription({ type: "offer", sdp: "" });
const json: { type: string; sdp: string } = description.toJSON();
declare const channel: InstanceType<typeof RTCDataChannel>;
channel.binaryType = "arraybuffer";
void json;

// lib.dom がなくても MediaStreamTrack / MediaStream を型として使える。
declare function produce(options: {
  track?: MediaStreamTrack;
}): Promise<{ track: MediaStreamTrack | null }>;
const track: MediaStreamTrack = new MediaStreamTrack({ kind: "audio" });
const typedStream: MediaStream = new MediaStream([track]);
void produce({ track });
void typedStream.getAudioTracks()[0]?.writeRtp;
void produce({ track }).then((producer) => {
  // @ts-expect-error 型情報が残っているので存在しないメンバーはエラーになる。
  void producer.track?.nonexistent;
});
