import { readFile } from "fs/promises";
import { uint16Add, uint32Add } from "../../packages/common/src";
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

  let timestampOffset = 0;
  let sequenceNumberOffset = 0;
  for (let times = 0; times < 10000; times++) {
    const headTimestamp = packets[0].header.timestamp;
    const tailTimestamp = packets.slice(-1)[0].header.timestamp;
    const headSeq = packets[0].header.sequenceNumber;
    const tailSeq = packets.slice(-1)[0].header.sequenceNumber;

    packets.forEach((p) => {
      const packet = p.clone();
      packet.header.timestamp = Number(
        uint32Add(BigInt(p.header.timestamp), BigInt(timestampOffset))
      );
      packet.header.sequenceNumber = uint16Add(
        packet.header.sequenceNumber,
        sequenceNumberOffset
      );
      track.onReceiveRtp.execute(packet);
    });

    timestampOffset += Number(
      uint32Add(BigInt(tailTimestamp), BigInt(-headTimestamp))
    );
    sequenceNumberOffset += uint16Add(uint16Add(tailSeq, -headSeq), 1);
  }

  recorder.stop();
})();
