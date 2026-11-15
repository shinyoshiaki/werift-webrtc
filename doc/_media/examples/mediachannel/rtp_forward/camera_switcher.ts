// Live camera switcher: a browser publishes two cameras (A and B) and the
// server forwards only the active one to UDP 127.0.0.1:1234 as ONE RTP stream
// (one SSRC, continuous sequence numbers / timestamps). Switching cameras is
// the typical "replace the upstream source" case of a relay / SFU, a
// broadcast switcher or an active-speaker view: the downstream receiver
// (ffmpeg, GStreamer, a restreaming or recording pipeline, an SRTP session)
// keeps running and never sees a new stream.
//
// RtpTimelineRewriter vs. RTCRtpSender.replaceTrack(): this example sends raw
// RTP over UDP, so there is no RTCRtpSender and the app keeps the timeline
// itself. When the downstream is a WebRTC peer that werift sends to (a browser
// viewer, SFU subscribers), use `transceiver.sender.replaceTrack(trackB)`
// instead (see examples/mediachannel/pubsub/offer.ts): the sender keeps
// seq / timestamp / SSRC continuous, drops queued packets of the old track and
// re-anchors its Sender Reports. Either way the switch does not wait for a key
// frame: request one (PLI) and switch when it arrives, as this example does.
// replaceTrack() advances the timestamp by 1 at the switch and can switch back
// to the same track; this rewriter can use the elapsed time instead
// ("wallClock") and needs a new `source` key to switch back.
//
// Open camera_switcher.html in a browser and press "Camera A" / "Camera B".
// Set SWITCH_INTERVAL_MS to also switch automatically (used by the e2e test).
//
// Receive the forwarded stream with, e.g.:
//   gst-launch-1.0 udpsrc port=1234 caps="application/x-rtp,media=video,encoding-name=VP8,clock-rate=90000,payload=96" ! rtpjitterbuffer ! rtpvp8depay ! decodebin ! autovideosink
import { createSocket } from "dgram";
import { WebSocketServer } from "ws";
import {
  type MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCRtpTransceiver,
  RtpTimelineRewriter,
  Vp8RtpPayload,
} from "../../../packages/webrtc/src";

const switchIntervalMs = Number(process.env.SWITCH_INTERVAL_MS ?? 0);
const downstreamSsrc = 0x12345678;
const downstreamPayloadType = 96;

const server = new WebSocketServer({ port: 8888 });
console.log("start");
const udp = createSocket("udp4");

type Camera = {
  name: string;
  transceiver: RTCRtpTransceiver;
  track?: MediaStreamTrack;
};

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }],
        }),
      ],
    },
  });
  const cameras: Camera[] = ["A", "B"].map((name) => ({
    name,
    transceiver: pc.addTransceiver("video", { direction: "recvonly" }),
  }));

  // One downstream timeline for the lifetime of the downstream stream.
  const rewriter = new RtpTimelineRewriter({
    // "auto" + clockRate: the time between the last packet of the old camera
    // and the first packet of the new one becomes media time.
    clockRate: 90000,
    ssrc: downstreamSsrc,
    payloadType: downstreamPayloadType,
  });
  rewriter.onSourceSwitch.subscribe((s) =>
    console.log(
      "source switch",
      `to=${String(s.source)}`,
      `seq=${s.sequenceNumber}`,
      `timestamp=${s.timestamp}`,
      `step=${s.timestampStep}`,
    ),
  );
  rewriter.onDrop.subscribe((rtp, reason) =>
    console.log("drop", reason, rtp.header.sequenceNumber),
  );

  let active: Camera | undefined;
  /** Source key of the current activation. */
  let activeSource = "";
  let activations = 0;
  let pending: Camera | undefined;
  let pliTimer: ReturnType<typeof setInterval> | undefined;

  const requestKeyFrame = (camera: Camera) => {
    if (camera.track?.ssrc) {
      camera.transceiver.receiver.sendRtcpPLI(camera.track.ssrc);
    }
  };

  // Switch at a key frame of the new camera, so the downstream decoder can
  // continue without corrupted frames: ask for one, keep forwarding the
  // current camera until it arrives.
  const requestSwitch = (camera: Camera) => {
    if (camera === active) {
      pending = undefined;
      return;
    }
    console.log(`switch requested camera=${camera.name}`);
    pending = camera;
    clearInterval(pliTimer);
    requestKeyFrame(camera);
    pliTimer = setInterval(() => requestKeyFrame(camera), 1000);
  };

  const activate = (camera: Camera) => {
    clearInterval(pliTimer);
    pending = undefined;
    active = camera;
    // A new key per activation. A key that was replaced stays retired (its
    // late packets are dropped), so switching back to a camera needs a new key.
    activeSource = `${camera.name}#${++activations}`;
    socket.send(JSON.stringify({ type: "active", camera: camera.name }));
  };

  for (const camera of cameras) {
    camera.transceiver.onTrack.subscribe((track) => {
      camera.track = track;
      track.onReceiveRtp.subscribe((rtp) => {
        if (camera === pending || (!active && camera === cameras[0])) {
          const vp8 = Vp8RtpPayload.deSerialize(rtp.payload);
          if (vp8.payloadHeaderExist && vp8.isKeyframe) {
            activate(camera);
          } else if (!active) {
            requestKeyFrame(camera);
            return;
          }
        }
        if (camera !== active) return;

        // rewrite() returns a clone: the received packet is shared by every
        // subscriber of the track.
        const out = rewriter.rewrite(rtp, { source: activeSource });
        if (out) {
          udp.send(out.serialize(), 1234, "127.0.0.1");
        }
      });
    });
  }

  socket.on("message", async (data: any) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "answer") {
      await pc.setRemoteDescription(msg.sdp);
    } else if (msg.type === "switch") {
      const camera = cameras.find((c) => c.name === msg.camera);
      if (camera) requestSwitch(camera);
    }
  });

  const timer =
    switchIntervalMs > 0
      ? setInterval(
          () => requestSwitch(active === cameras[0] ? cameras[1] : cameras[0]),
          switchIntervalMs,
        )
      : undefined;
  socket.on("close", () => {
    clearInterval(timer);
    clearInterval(pliTimer);
    void pc.close();
  });

  await pc.setLocalDescription(await pc.createOffer());
  socket.send(JSON.stringify({ type: "offer", sdp: pc.localDescription }));
});
