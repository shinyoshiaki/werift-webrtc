import type { ChildProcess } from "child_process";
import type { Socket } from "dgram";
import type { AcceptFn } from "protoo-server";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpPacket,
} from "../../";
import { DtlsKeysContext } from "../../fixture";
import { spawnGstreamerPipeline, stopGstreamerProcess } from "../../gstreamer";
import { closeUdpSource, openUdpSource } from "../../udpSource";

export class mediachannel_rtx_client_answer {
  pc!: RTCPeerConnection;
  process?: ChildProcess;
  udp?: Socket;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          await stopGstreamerProcess(this.process);
          this.process = undefined;
          const { udp, port } = await openUdpSource(this.udp);
          this.udp = udp;

          this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
            dtls: { keys: await DtlsKeysContext.get() },
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

          this.process = spawnGstreamerPipeline([
            "videotestsrc",
            "video/x-raw,width=640,height=480,format=I420",
            "vp8enc error-resilient=partitions keyframe-max-dist=10 auto-alt-ref=true cpu-used=5 deadline=1",
            "rtpvp8pay",
            `udpsink host=127.0.0.1 port=${port}`,
          ]);
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
          closeUdpSource(this.udp);
          this.udp = undefined;
          await stopGstreamerProcess(this.process);
          this.process = undefined;
          this.pc.close();
          accept({});
        }
        break;
    }
  }
}

export class mediachannel_rtx_client_offer {
  pc!: RTCPeerConnection;
  process?: ChildProcess;
  udp?: Socket;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
            dtls: { keys: await DtlsKeysContext.get() },
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
          await stopGstreamerProcess(this.process);
          this.process = undefined;
          const { udp, port } = await openUdpSource(this.udp);
          this.udp = udp;

          const track = new MediaStreamTrack({ kind: "video" });
          this.pc.addTrack(track);

          await this.pc.setRemoteDescription(payload);
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          accept(this.pc.localDescription);

          this.udp.on("message", (data) => {
            const rtp = RtpPacket.deSerialize(data);
            track.writeRtp(rtp);
          });

          this.process = spawnGstreamerPipeline([
            "videotestsrc",
            "video/x-raw,width=640,height=480,format=I420",
            "vp8enc error-resilient=partitions keyframe-max-dist=10 auto-alt-ref=true cpu-used=5 deadline=1",
            "rtpvp8pay",
            `udpsink host=127.0.0.1 port=${port}`,
          ]);
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
          closeUdpSource(this.udp);
          this.udp = undefined;
          await stopGstreamerProcess(this.process);
          this.process = undefined;
          this.pc.close();
          accept({});
        }
        break;
    }
  }
}
