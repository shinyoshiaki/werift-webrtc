import {
  MediaStreamTrack,
  RTCPeerConnection,
  JitterBuffer,
  SampleBuilder,
  WebmOutput,
  RTCRtpCodecParameters,
} from "../../packages/webrtc/src";
import { Server } from "ws";

// open ./answer.html

const server = new Server({ port: 8878 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/AV1X",
          clockRate: 90000,
          rtcpFeedback: [
            { type: "nack" },
            { type: "nack", parameter: "pli" },
            { type: "goog-remb" },
          ],
        }),
      ],
    },
  });

  const tracks: { audio?: MediaStreamTrack; video?: MediaStreamTrack } = {};
  const start = async () => {
    const { video, audio } = tracks;

    const webm = new WebmOutput("./test.webm", [
      {
        width: 640,
        height: 360,
        kind: "video",
        codec: "AV1",
        clockRate: 90000,
        payloadType: video.codec.payloadType,
        trackNumber: 1,
      },
      {
        kind: "audio",
        codec: "OPUS",
        clockRate: 48000,
        payloadType: audio.codec.payloadType,
        trackNumber: 2,
      },
    ]);

    new JitterBuffer({
      rtpStream: video.onReceiveRtp,
      rtcpStream: video.onReceiveRtcp,
    }).pipe(new SampleBuilder((h) => !!h.marker).pipe(webm));
    new JitterBuffer({
      rtpStream: audio.onReceiveRtp,
      rtcpStream: audio.onReceiveRtcp,
    }).pipe(new SampleBuilder(() => true).pipe(webm));

    setTimeout(() => {
      console.log("stop");
      webm.stop();
    }, 5_000);
  };
  {
    const transceiver = pc.addTransceiver("video");

    transceiver.onTrack.subscribe((track) => {
      transceiver.sender.replaceTrack(track);

      tracks.video = track;
      if (Object.keys(tracks).length === 2) {
        start();
      }
      setInterval(() => {
        transceiver.receiver.sendRtcpPLI(track.ssrc);
      }, 2_000);
    });
  }
  {
    const transceiver = pc.addTransceiver("audio");
    transceiver.onTrack.subscribe((track) => {
      transceiver.sender.replaceTrack(track);

      tracks.audio = track;
      if (Object.keys(tracks).length === 2) {
        start();
      }
    });
  }

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
