import { readFile } from "fs/promises";
import {
  MediaRecorder,
  MediaStreamTrack,
  RtpPacket,
} from "../../packages/webrtc/src";

(async () => {
  const packets = await Promise.all(
    [...Array(34).keys()].map(async (i) => {
      const buf = await readFile(`./assets/rtp/vp8/dump_${i}.rtp`);
      return RtpPacket.deSerialize(buf);
    })
  );

  const track = new MediaStreamTrack({ kind: "video" });
  const recorder = new MediaRecorder([track], "./test.webm", {
    width: 640,
    height: 360,
  });
  await recorder.start();
  packets.forEach((p) => {
    track.onReceiveRtp.execute(p);
  });
  recorder.stop();
})();
