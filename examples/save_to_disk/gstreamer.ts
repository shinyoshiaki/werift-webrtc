import { exec } from "child_process";
import { createSocket } from "dgram";
import { Server } from "ws";
import { RTCPeerConnection, randomPorts, uint16Add } from "../../packages/webrtc/src";

(async () => {
  const [videoPort, audioPort] = await randomPorts(2);
  const command = `gst-launch-1.0 -e \
udpsrc name=videoRTP port=${videoPort} \
caps = "application/x-rtp, media=(string)video, clock-rate=(int)90000, encoding-name=(string)VP8, payload=(int)97" \
! queue \
! rtpvp8depay \
! queue ! muxer.video_0 \
udpsrc port=${audioPort} \
caps = "application/x-rtp, media=(string)audio, clock-rate=(int)48000, encoding-name=(string)OPUS, payload=(int)96" \
! queue \
! rtpopusdepay ! opusdec ! opusenc \
! queue ! muxer.audio_0 \
qtmux name="muxer" ! filesink location=capture.webm`;

  console.log(command);
  const gst = exec(command);

  gst.stdout.on("data", (data) => console.log(data.toString()));

  process.on("SIGINT", () => {
    gst.kill("SIGINT");
    process.exit();
  });

  const udp = createSocket("udp4");
  const server = new Server({ port: 8878 });
  console.log("start");

  server.on("connection", async (socket) => {
    const pc = new RTCPeerConnection({});

    {
      const transceiver = pc.addTransceiver("video");
      transceiver.onTrack.subscribe((track) => {
        transceiver.sender.replaceTrack(track);
        // Probe padding shares the media RTP sequence space. Skipping it without
        // compacting seq looks like loss to rtpvp8depay / the next jitterbuffer.
        let skippedPadding = 0;
        track.onReceiveRtp.subscribe((rtp, _extensions, info) => {
          // GCC probe padding is padding-only RTP; do not forward hop-local probes.
          if (info?.type === "padding") {
            skippedPadding = uint16Add(skippedPadding, 1);
            return;
          }
          const forwarded = rtp.clone();
          forwarded.header.sequenceNumber = uint16Add(
            forwarded.header.sequenceNumber,
            -skippedPadding,
          );
          udp.send(forwarded.serialize(), videoPort, "127.0.0.1");
        });
        track.onReceiveRtp.once(() => {
          setInterval(() => transceiver.receiver.sendRtcpPLI(track.ssrc), 2000);
        });
      });
    }
    {
      const transceiver = pc.addTransceiver("audio");
      transceiver.onTrack.subscribe((track) => {
        transceiver.sender.replaceTrack(track);
        let skippedPadding = 0;
        track.onReceiveRtp.subscribe((rtp, _extensions, info) => {
          // GCC probe padding is padding-only RTP; do not forward hop-local probes.
          if (info?.type === "padding") {
            skippedPadding = uint16Add(skippedPadding, 1);
            return;
          }
          const forwarded = rtp.clone();
          forwarded.header.sequenceNumber = uint16Add(
            forwarded.header.sequenceNumber,
            -skippedPadding,
          );
          udp.send(forwarded.serialize(), audioPort, "127.0.0.1");
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
})();
