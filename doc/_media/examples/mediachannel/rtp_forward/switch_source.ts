// Forward received video RTP to UDP 127.0.0.1:1234 on one continuous RTP
// timeline while the upstream WebRTC connection is recreated every
// SWITCH_INTERVAL_MS (for example a camera service that closes a live view
// after a fixed time). Open switch_source.html in a browser.
//
// Receive the forwarded stream with, e.g.:
//   gst-launch-1.0 udpsrc port=1234 caps="application/x-rtp,media=video,encoding-name=VP8,clock-rate=90000,payload=96" ! rtpvp8depay ! decodebin ! autovideosink
import { createSocket } from "dgram";
import { WebSocketServer } from "ws";
import {
  RTCPeerConnection,
  RtpTimelineRewriter,
} from "../../../packages/webrtc/src";

const switchIntervalMs = Number(process.env.SWITCH_INTERVAL_MS ?? 10_000);
const downstreamSsrc = 0x12345678;

const server = new WebSocketServer({ port: 8888 });
console.log("start");
const udp = createSocket("udp4");

server.on("connection", (socket) => {
  // One downstream timeline for the lifetime of the downstream session.
  const rewriter = new RtpTimelineRewriter({
    // "auto" uses the reconnect time as the timestamp step when clockRate is set.
    clockRate: 90000,
    ssrc: downstreamSsrc,
  });
  rewriter.onSourceSwitch.subscribe((s) =>
    console.log(
      "source switch",
      `generation=${s.source}`,
      `seq=${s.sequenceNumber}`,
      `timestamp=${s.timestamp}`,
      `step=${s.timestampStep}`,
    ),
  );

  let generation = 0;
  let pc: RTCPeerConnection | undefined;

  const connect = async () => {
    const current = ++generation;
    await pc?.close();
    const peer = (pc = new RTCPeerConnection({}));
    peer.connectionStateChange.subscribe((state) =>
      console.log(`generation ${current} connection state`, state),
    );
    const transceiver = peer.addTransceiver("video", {
      direction: "recvonly",
    });
    transceiver.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((rtp) => {
        // The source key drops late packets of an older connection.
        // rewrite() returns a clone: the received packet is shared.
        const out = rewriter.rewrite(rtp, { source: current });
        if (out) {
          udp.send(out.serialize(), 1234, "127.0.0.1");
        }
      });
      // The downstream decoder needs a key frame of the new source.
      track.onReceiveRtp.once(() => {
        if (track.ssrc) {
          transceiver.receiver.sendRtcpPLI(track.ssrc);
        }
      });
    });

    await peer.setLocalDescription(await peer.createOffer());
    socket.send(
      JSON.stringify({ generation: current, sdp: peer.localDescription }),
    );
  };

  socket.on("message", (data: any) => {
    const { generation: answered, sdp } = JSON.parse(data.toString());
    if (answered === generation) {
      pc?.setRemoteDescription(sdp);
    }
  });

  void connect();
  const timer = setInterval(() => void connect(), switchIntervalMs);
  socket.on("close", () => {
    clearInterval(timer);
    void pc?.close();
  });
});
