import { ChildProcess, exec } from "child_process";
import { createSocket } from "dgram";
import { AcceptFn } from "protoo-server";
import {
  RTCPeerConnection,
  MediaStreamTrack,
  RtpPacket,
  RTCRtpCodecParameters,
  randomPort,
} from "../../";

export class mediachannel_rtx_client_answer {
  pc!: RTCPeerConnection;
  child!: ChildProcess;
  udp = createSocket("udp4");

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          const port = await randomPort();
          this.udp.bind(port);

          this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
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
                  ],
                }),
                new RTCRtpCodecParameters({
                  mimeType: "video/rtx",
                  clockRate: 90000,
                }),
              ],
            },
          });
          const track = new MediaStreamTrack({ kind: "video" });
          this.pc.addTrack(track);
          await this.pc.setLocalDescription(await this.pc.createOffer());
          accept(this.pc.localDescription);

          this.udp.on("message", (data) => {
            const rtp = RtpPacket.deSerialize(data);
            track.writeRtp(rtp);
          });
          this.child = exec(
            `gst-launch-1.0 videotestsrc ! video/x-raw,width=640,height=480,format=I420 ! vp8enc error-resilient=partitions keyframe-max-dist=10 auto-alt-ref=true cpu-used=5 deadline=1 ! rtpvp8pay ! udpsink host=127.0.0.1 port=${port}`
          );
        }
        break;
      case "candidate":
        {
          await this.pc.addIceCandidate(payload);
          accept({});
        }
        break;
      case "answer":
        {
          await this.pc.setRemoteDescription(payload);
          accept({});
        }
        break;
      case "done":
        {
          this.udp.close();
          process.kill(this.child.pid + 1);
          this.pc.close();
          accept({});
        }
        break;
    }
  }
}

export class mediachannel_rtx_client_offer {
  pc!: RTCPeerConnection;
  child!: ChildProcess;
  udp = createSocket("udp4");

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
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
                  ],
                }),
                new RTCRtpCodecParameters({
                  mimeType: "video/rtx",
                  clockRate: 90000,
                }),
              ],
            },
          });
          accept({});
        }
        break;
      case "offer":
        {
          const port = await randomPort();
          this.udp.bind(port);

          const track = new MediaStreamTrack({ kind: "video" });
          this.pc.addTrack(track);

          await this.pc.setRemoteDescription(payload);
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          accept(this.pc.localDescription);

          this.udp.on("message", (data) => {
            const rtp = RtpPacket.deSerialize(data);
            track.writeRtp(rtp);
          });
          this.child = exec(
            `gst-launch-1.0 videotestsrc ! video/x-raw,width=640,height=480,format=I420 ! vp8enc error-resilient=partitions keyframe-max-dist=10 auto-alt-ref=true cpu-used=5 deadline=1 ! rtpvp8pay ! udpsink host=127.0.0.1 port=${port}`
          );
        }
        break;
      case "candidate":
        {
          await this.pc.addIceCandidate(payload);
          accept({});
        }
        break;
      case "done":
        {
          this.udp.close();
          try {
            process.kill(this.child.pid + 1);
          } catch (error) {}
          this.pc.close();
          accept({});
        }
        break;
    }
  }
}
