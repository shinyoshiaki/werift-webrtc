import { ChildProcess, spawn } from "child_process";
import { createSocket } from "dgram";
import { AcceptFn } from "protoo-server";
import { RTCPeerConnection, MediaStreamTrack, RtpPacket } from "../../";
import { randomPort } from "../../../../packages/ice/src";
import { peerConfig } from "../../fixture";

export class mediachannel_addTrack_answer {
  pc!: RTCPeerConnection;
  process!: ChildProcess;
  udp = createSocket("udp4");

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          const port = await randomPort();
          this.udp.bind(port);

          this.pc = new RTCPeerConnection(await peerConfig);
          const track = new MediaStreamTrack({ kind: "video" });
          this.pc.addTrack(track);
          await this.pc.setLocalDescription(await this.pc.createOffer());
          accept(this.pc.localDescription);

          this.udp.on("message", (data) => {
            const rtp = RtpPacket.deSerialize(data);
            track.writeRtp(rtp);
          });

          const args = [
            `videotestsrc`,
            "video/x-raw,width=640,height=480,format=I420",
            "vp8enc error-resilient=partitions keyframe-max-dist=10 auto-alt-ref=true cpu-used=5 deadline=1",
            "rtpvp8pay",
            `udpsink host=127.0.0.1 port=${port}`,
          ].join(" ! ");
          this.process = spawn("gst-launch-1.0", args.split(" "));
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
          this.pc.close();
          try {
            this.process.kill("SIGINT");
          } catch (error) {}
          accept({});
        }
        break;
    }
  }
}

export class mediachannel_addTrack_offer {
  pc!: RTCPeerConnection;
  process!: ChildProcess;
  udp = createSocket("udp4");

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(await peerConfig);
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

          const args = [
            `videotestsrc`,
            "video/x-raw,width=640,height=480,format=I420",
            "vp8enc error-resilient=partitions keyframe-max-dist=10 auto-alt-ref=true cpu-used=5 deadline=1",
            "rtpvp8pay",
            `udpsink host=127.0.0.1 port=${port}`,
          ].join(" ! ");
          this.process = spawn("gst-launch-1.0", args.split(" "));
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
          this.pc.close();
          try {
            this.process.kill("SIGINT");
          } catch (error) {}
          accept({});
        }
        break;
    }
  }
}
