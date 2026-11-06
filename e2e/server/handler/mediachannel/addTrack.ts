import type { ChildProcess } from "child_process";
import type { Socket } from "dgram";
import type { AcceptFn } from "protoo-server";
import {
  MediaStreamTrack,
  MediaStreamTrackFactory,
  RTCPeerConnection,
  RtpPacket,
} from "../../";
import { peerConfig } from "../../fixture";
import { spawnGstreamerPipeline, stopGstreamerProcess } from "../../gstreamer";
import { closeUdpSource, openUdpSource } from "../../udpSource";

export class mediachannel_addTrack_answer {
  pc!: RTCPeerConnection;
  process?: ChildProcess;
  private disposer = () => {};

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          // vitest retry reuses this handler; tear down previous resources first
          this.disposer();
          this.disposer = () => {};
          await stopGstreamerProcess(this.process);
          this.process = undefined;
          try {
            this.pc?.close();
          } catch {
            // ignore
          }

          const [track, port, disposer] =
            await MediaStreamTrackFactory.rtpSource({ kind: "video" });
          this.disposer = disposer;

          this.pc = new RTCPeerConnection(await peerConfig);
          this.pc.addTrack(track);
          await this.pc.setLocalDescription(await this.pc.createOffer());
          accept(this.pc.localDescription);

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
          this.disposer();
          this.disposer = () => {};
          this.pc.close();
          await stopGstreamerProcess(this.process);
          this.process = undefined;
          accept({});
        }
        break;
    }
  }
}

export class mediachannel_addTrack_offer {
  pc!: RTCPeerConnection;
  process?: ChildProcess;
  udp?: Socket;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          try {
            this.pc?.close();
          } catch {
            // ignore
          }
          this.pc = new RTCPeerConnection(await peerConfig);
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
          this.pc.close();
          await stopGstreamerProcess(this.process);
          this.process = undefined;
          accept({});
        }
        break;
    }
  }
}
