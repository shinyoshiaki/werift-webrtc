import { setTimeout } from "timers/promises";

import {
  codecParametersToString,
  MediaStreamTrack,
  RedEncoder,
  RTCRtpCodecParameters,
  RTCRtpCodingParameters,
  RtpHeader,
  RtpPacket,
} from "../../src";
import { RedHandler } from "../../src/media/receiver/red";
import { RTCRtpReceiver } from "../../src/media/rtpReceiver";
import { wrapRtx } from "../../src/media/rtpSender";
import { createDtlsTransport } from "../fixture";

describe("packages/webrtc/src/media/rtpReceiver.ts", () => {
  test("abort runRtcp", async () =>
    new Promise<void>(async (done) => {
      const dtls = createDtlsTransport();
      const receiver = new RTCRtpReceiver("audio", 1234);
      receiver.setDtlsTransport(dtls);

      jest.spyOn(dtls, "sendRtcp");

      Promise.any([
        setTimeout(200).then(() => false),
        receiver.runRtcp().then(() => true),
      ]).then((res) => {
        expect(res).toBeTruthy();
        done();
      });

      await setTimeout(10);
      receiver.stop();
    }));

  test("handleRTP with RTX packet", async () => {
    const dtls = createDtlsTransport();
    const receiver = new RTCRtpReceiver("video", 1234);
    receiver.setDtlsTransport(dtls);

    const track = new MediaStreamTrack({ kind: "video" });
    track.ssrc = 777;

    receiver.addTrack(track);
    receiver.prepareReceive({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/vp8",
          clockRate: 90000,
          payloadType: 96,
        }),
        new RTCRtpCodecParameters({
          mimeType: "video/rtx",
          clockRate: 90000,
          payloadType: 97,
          parameters: codecParametersToString({ apt: 96 }),
        }),
      ],
      encodings: [
        new RTCRtpCodingParameters({
          ssrc: 777,
          payloadType: 96,
          rtx: { ssrc: 666 },
        }),
        new RTCRtpCodingParameters({
          ssrc: 666,
          payloadType: 97,
        }),
      ],
      headerExtensions: [],
    });

    setImmediate(() => {
      receiver.handleRtpBySsrc(
        wrapRtx(
          new RtpPacket(
            new RtpHeader({ ssrc: 777, payloadType: 96 }),
            Buffer.from([1, 2, 3, 4])
          ),
          97,
          0,
          666
        ),
        {}
      );
    });
    const [rtp] = await track.onReceiveRtp.asPromise();
    expect(rtp.payload).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("handle red packet", () => {
    const redundantPackets = [
      new RtpPacket(
        new RtpHeader({
          version: 2,
          padding: false,
          paddingSize: 0,
          extension: false,
          marker: true,
          payloadType: 96,
          sequenceNumber: 30420,
          timestamp: 3086388154,
          ssrc: 4096661943,
          csrc: [],
          extensionProfile: 48862,
          extensions: [],
        }),
        Buffer.from([
          248, 62, 40, 37, 8, 94, 127, 87, 49, 135, 230, 96, 177, 32, 100, 14,
          207, 87, 246, 74, 104, 173, 95, 2, 74, 32, 233, 50, 202, 111, 175, 44,
          91, 50, 102, 29, 88, 37, 77, 189, 137, 248, 128, 37, 121, 215, 0, 230,
          138, 226, 52, 248, 74, 108, 191, 78, 129, 39, 28, 126, 74, 2, 192,
          250, 62, 90, 86, 65, 223, 156, 140, 92, 26, 132, 91, 30, 62, 254, 216,
          168, 3,
        ])
      ),
      new RtpPacket(
        new RtpHeader({
          version: 2,
          padding: false,
          paddingSize: 0,
          extension: false,
          marker: true,
          payloadType: 96,
          sequenceNumber: 30421,
          timestamp: 3086389114,
          ssrc: 4096661943,
          csrc: [],
          extensionProfile: 48862,
          extensions: [],
        }),
        Buffer.from([
          248, 176, 49, 49, 9, 170, 194, 16, 62, 29, 54, 113, 27, 245, 187, 200,
          149, 82, 175, 168, 39, 107, 15, 28, 72, 121, 29, 41, 194, 208, 106,
          159, 36, 191, 248, 92, 15, 40, 120, 129, 64, 140, 137, 105, 165, 37,
          188, 87, 163, 158, 146, 145, 88, 23, 57, 145, 107, 27, 46, 68, 42,
          172, 97, 211, 142, 94, 50, 56, 62, 251, 237, 19, 96, 67, 103, 217, 28,
          86, 92, 235, 213, 189, 159, 5,
        ])
      ),
    ];
    const present = new RtpPacket(
      new RtpHeader({
        version: 2,
        padding: false,
        paddingSize: 0,
        extension: false,
        marker: true,
        payloadType: 96,
        sequenceNumber: 30422,
        timestamp: 3086390074,
        ssrc: 4096661943,
        csrc: [],
        extensionProfile: 48862,
        extensions: [],
      }),
      Buffer.from([
        248, 215, 172, 2, 147, 205, 144, 123, 90, 236, 138, 131, 155, 167, 20,
        199, 140, 230, 9, 239, 156, 172, 71, 12, 115, 162, 195, 231, 31, 174,
        150, 214, 248, 250, 50, 221, 217, 133, 104, 153, 193, 143, 45, 47, 73,
        89, 226, 50, 234, 148, 3, 163, 106, 29, 129, 53, 111, 40, 90, 45, 206,
        187, 243, 105, 41, 35, 81, 247, 129, 44, 165, 191, 41, 91, 159, 58, 239,
        0, 250, 4, 185, 2, 141, 255, 52, 11, 51, 142, 68, 124,
      ])
    );
    const redEncoder = new RedEncoder(3);
    redundantPackets.forEach((p) =>
      redEncoder.push({
        block: p.payload,
        timestamp: p.header.timestamp,
        blockPT: p.header.payloadType,
      })
    );
    redEncoder.push({
      block: present.payload,
      timestamp: present.header.timestamp,
      blockPT: present.header.payloadType,
    });
    const red = redEncoder.build();

    const packet = present.clone();
    packet.payload = red.serialize();

    const redHandler = new RedHandler();
    const res = redHandler.push(red, packet);
    expect(res.length).toBe(3);
    expect(res).toEqual([...redundantPackets, present]);
  });
});
