import {
  RTCPeerConnection,
  RtpHeader,
  SampleBuilder,
} from "../../packages/webrtc/src";
import { Server } from "ws";
import * as EBML from "simple-ebml-builder";
import fs from "fs/promises";

import { BitWriter, bufferWriter, int } from "../../packages/common/src";
import { appendFileSync } from "fs";

const server = new Server({ port: 8888 });
console.log("start");

const millisecond = 1000000;

server.on("connection", async (socket) => {
  const ebmlHeader = EBML.build(
    EBML.element(EBML.ID.EBML, [
      EBML.element(EBML.ID.EBMLVersion, EBML.number(1)),
      EBML.element(EBML.ID.EBMLReadVersion, EBML.number(1)),
      EBML.element(EBML.ID.EBMLMaxIDLength, EBML.number(4)),
      EBML.element(EBML.ID.EBMLMaxSizeLength, EBML.number(8)),
      EBML.element(EBML.ID.DocType, EBML.string("webm")),
      EBML.element(EBML.ID.DocTypeVersion, EBML.number(4)),
      EBML.element(EBML.ID.DocTypeReadVersion, EBML.number(2)),
    ])
  );
  const ebmlSegment = EBML.build(
    EBML.unknownSizeElement(EBML.ID.Segment, [
      EBML.element(EBML.ID.Info, [
        EBML.element(EBML.ID.TimecodeScale, EBML.number(millisecond)),
        EBML.element(EBML.ID.MuxingApp, EBML.string("werift.mux")),
        EBML.element(EBML.ID.WritingApp, EBML.string("werift.write")),
      ]),
      EBML.element(EBML.ID.Tracks, [
        EBML.element(EBML.ID.TrackEntry, [
          EBML.element(EBML.ID.TrackNumber, EBML.number(1)),
          EBML.element(EBML.ID.TrackUID, EBML.number(12345)),
          EBML.element(EBML.ID.TrackType, EBML.number(1)), // video:1 audio:2
          EBML.element(EBML.ID.CodecID, EBML.string("V_VP8")),
          EBML.element(EBML.ID.Video, [
            EBML.element(EBML.ID.PixelWidth, EBML.number(640)),
            EBML.element(EBML.ID.PixelHeight, EBML.number(360)),
          ]),
        ]),
        // EBML.element(EBML.ID.TrackEntry, [
        //   EBML.element(EBML.ID.TrackNumber, EBML.number(1)),
        //   EBML.element(EBML.ID.TrackUID, EBML.number(12345)),
        //   EBML.element(EBML.ID.CodecID, EBML.string("A_OPUS")),
        //   EBML.element(EBML.ID.TrackType, EBML.number(2)), // video:1 audio:2
        //   EBML.element(EBML.ID.Audio, [
        //     EBML.element(EBML.ID.SamplingFrequency, EBML.number(48000.0)),
        //     EBML.element(EBML.ID.Channels, EBML.number(2)),
        //   ]),
        // ]),
      ]),
      EBML.unknownSizeElement(EBML.ID.Cluster, [
        EBML.element(EBML.ID.Timecode, EBML.number(0.0)),
      ]),
    ])
  );
  const path = "./test.webm";
  await fs.writeFile(path, Buffer.concat([ebmlHeader, ebmlSegment]));

  const pc = new RTCPeerConnection({});

  {
    const transceiver = pc.addTransceiver("video");
    transceiver.onTrack.subscribe((track) => {
      transceiver.sender.replaceTrack(track);

      const sampleBuilder = new SampleBuilder();

      track.onReceiveRtp.subscribe((rtp) => {
        sampleBuilder.push(rtp);
        const res = sampleBuilder.build();
        if (!res) return;
        const { data, duration, isKeyframe } = res;
        console.log({ data, duration, isKeyframe });

        const elementId = Buffer.from([0xa3]);
        const contentSize: Uint8Array = EBML.vintEncodedNumber(
          1 + 2 + 1 + data.length
        ).bytes;
        const trackNumber: Uint8Array = EBML.vintEncodedNumber(1).bytes;

        const flags = new BitWriter(8);
        const keyframe = isKeyframe ? 1 : 0;
        flags.set(1, 0, keyframe);
        flags.set(3, 1, 0);
        flags.set(1, 4, 0);
        flags.set(2, 5, 0);
        flags.set(1, 7, 0);

        const simpleBlock = Buffer.concat([
          elementId,
          contentSize,
          trackNumber,
          bufferWriter([2, 1], [duration, flags.value]),
          data,
        ]);

        appendFileSync(path, simpleBlock);
      });
      track.onReceiveRtp.once(() => {
        setInterval(() => transceiver.receiver.sendRtcpPLI(track.ssrc), 3000);
      });
    });
  }
  {
    const transceiver = pc.addTransceiver("audio");

    let first: RtpHeader | undefined;
    transceiver.onTrack.subscribe((track) => {
      transceiver.sender.replaceTrack(track);

      track.onReceiveRtp.subscribe((rtp) => {
        const elementId = Buffer.from([0xa3]);
        const contentSize: Uint8Array = EBML.vintEncodedNumber(
          1 + 2 + 1 + rtp.payload.length
        ).bytes;
        const trackNumber: Uint8Array = EBML.vintEncodedNumber(1).bytes;

        if (!first) first = rtp.header;
        let timestamp = rtp.header.timestamp - first.timestamp;
        if (timestamp < 0) {
          // todo fix
          timestamp = (0x01 << 32) - 1 + rtp.header.timestamp - first.timestamp;
        }

        if (timestamp) timestamp = int((timestamp / 48000) * 1000);

        const flags = new BitWriter(8);
        const keyframe = 1;
        flags.set(1, 0, keyframe);
        flags.set(3, 1, 0);
        flags.set(1, 4, 0);
        flags.set(2, 5, 0);
        flags.set(1, 7, 0);

        const simpleBlock = Buffer.concat([
          elementId,
          contentSize,
          trackNumber,
          bufferWriter([2, 1], [timestamp, flags.value]),
          rtp.payload,
        ]);

        // appendFileSync(path, simpleBlock);
      });
    });
  }

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
