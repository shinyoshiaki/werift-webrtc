import { Event } from "rx.mini";
import { Server } from "ws";
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type SenderBandwidthEstimator,
  useAbsSendTime,
  useTransportWideCC,
} from "../../../packages/webrtc/src";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const onMessage = new Event<[any]>();
  socket.on("message", (data: any) => {
    onMessage.execute(data);
  });

  const receiver = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          rtcpFeedback: [
            { type: "ccm", parameter: "fir" },
            { type: "nack" },
            { type: "nack", parameter: "pli" },
            { type: "goog-remb" },
            { type: "transport-cc" },
          ],
        }),
      ],
    },
    headerExtensions: { video: [useAbsSendTime(), useTransportWideCC()] },
  });
  const sender = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          rtcpFeedback: [
            { type: "ccm", parameter: "fir" },
            { type: "nack" },
            { type: "nack", parameter: "pli" },
            { type: "goog-remb" },
            { type: "transport-cc" },
          ],
        }),
      ],
    },
    headerExtensions: { video: [useAbsSendTime(), useTransportWideCC()] },
  });
  const receiverTransceiver = receiver.addTransceiver("video", {
    direction: "recvonly",
  });
  const senderTransceiver = sender.addTransceiver("video", {
    direction: "sendonly",
  });
  // Prefer rtpSender.onAvailableBitrate (bps, change-only; survives estimator swap).
  // onCongestion is legacy SenderBandwidthEstimator-only (default BWE).
  // GCC: rtpSender.setBandwidthEstimator(new GccBandwidthEstimator()).
  const rtpSender = senderTransceiver.sender;
  rtpSender.onAvailableBitrate.subscribe((bps) =>
    console.log("availableBitrate", bps),
  );
  const legacyBwe = rtpSender.senderBWE as SenderBandwidthEstimator;
  legacyBwe.onCongestion.subscribe((b) => console.log("congestion", b));

  receiverTransceiver.onTrack.subscribe(async (track) => {
    track.onReceiveRtp.once((rtp) => {
      receiverTransceiver.receiver.sendRtcpPLI(rtp.header.ssrc);
      setInterval(() => {
        receiverTransceiver.receiver.sendRtcpPLI(rtp.header.ssrc);
      }, 1000);
    });
    senderTransceiver.sender.replaceTrack(track);
  });

  {
    await receiver.setLocalDescription(await receiver.createOffer());
    socket.send(JSON.stringify(receiver.localDescription));
    const [data] = await onMessage.asPromise();
    receiver.setRemoteDescription(JSON.parse(data));
  }

  {
    await sender.setLocalDescription(await sender.createOffer());
    socket.send(JSON.stringify(sender.localDescription));
    const [data] = await onMessage.asPromise();
    sender.setRemoteDescription(JSON.parse(data));
  }
});
