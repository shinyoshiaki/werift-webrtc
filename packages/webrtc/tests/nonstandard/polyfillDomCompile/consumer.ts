import {
  createCallbackRegister,
  createEncodedBinaryRegister,
  createMp4WebmRegister,
  createRtpRtcpRegister,
  installPolyfill,
} from "../../../src/polyfill/dom";

const uninstall = installPolyfill({
  mediaRegister: [
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
