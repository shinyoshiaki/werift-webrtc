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
