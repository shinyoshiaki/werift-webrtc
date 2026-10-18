import { randomUUID } from "crypto";
import { $ } from "zx";
import { randomPort } from "../../packages/webrtc/src";
import { MediaRecorder } from "../../packages/webrtc/src/nonstandard";
import {
  createRtpRtcpRegister,
  installPolyfill,
} from "../../packages/webrtc/src/polyfill";

(async () => {
  const path =
    process.env.WERIFT_EXAMPLE_OUTPUT_PATH ??
    `${__dirname}/tmp${randomUUID()}.webm`;
  const recorder = new MediaRecorder({
    numOfTracks: 1,
    path,
    disableNtp: true,
  });

  const port = await randomPort();
  installPolyfill({
    mediaRegister: [
      createRtpRtcpRegister({
        mimeType: "audio/opus",
        udp: { port },
        payloadType: 96,
        clockRate: 48000,
      }),
    ],
  });
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const [track] = stream.getAudioTracks();
  if (!track) {
    throw new Error("opus track was not created");
  }
  await recorder.addTrack(track);

  console.log("start");
  $`gst-launch-1.0 audiotestsrc ! audioconvert ! audioresample ! opusenc ! rtpopuspay ! udpsink host=127.0.0.1 port=${port}`;

  setTimeout(async () => {
    await recorder.stop();
    console.log("stop");
  }, 5_000);
})();
