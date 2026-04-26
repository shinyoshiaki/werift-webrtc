import { randomUUID } from "crypto";
import { $ } from "zx";
import { randomPort } from "../../packages/webrtc/src";
import {
  MediaRecorder,
  Navigator,
} from "../../packages/webrtc/src/nonstandard";

(async () => {
  const path = `${__dirname}/tmp${randomUUID()}.webm`;
  const recorder = new MediaRecorder({
    numOfTracks: 1,
    path,
    disableNtp: true,
  });

  const port = await randomPort();
  const navigator = new Navigator();
  const { track } = navigator.mediaDevices.getUdpMedia({
    port,
    codec: { clockRate: 48000, mimeType: "audio/opus", payloadType: 96 },
  });
  await recorder.addTrack(track);

  $`gst-launch-1.0 audiotestsrc ! audioconvert ! audioresample ! opusenc ! rtpopuspay ! udpsink host=127.0.0.1 port=${port}`;
})();
