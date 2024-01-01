import { ChildProcess, spawn } from "child_process";
import { createSocket } from "dgram";
import { AcceptFn } from "protoo-server";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpPacket,
  randomPort,
} from "../../";
import { peerConfig } from "../../fixture";

export class mediachannel_removetrack_answer_base {
  pc!: RTCPeerConnection;
  process!: ChildProcess;
  udp = createSocket("udp4");

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init": {
        const port = await randomPort();
        this.udp.bind(port);

        this.pc = new RTCPeerConnection(await peerConfig);
        const track = new MediaStreamTrack({ kind: "video" });
        this.pc.addTransceiver(track, { direction: "sendonly" });
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
      case "candidate": {
        await this.pc.addIceCandidate(payload);
        accept({});
      }
      break;
      case "answer": {
        await this.pc.setRemoteDescription(payload);
        accept({});
      }
      break;
      case "removeTrack": {
        const sender = this.pc
          .getTransceivers()
          .find((t) => t.mLineIndex === payload)!.sender;

        this.pc.removeTrack(sender);
        await this.pc.setLocalDescription(await this.pc.createOffer());
        accept(this.pc.localDescription);
      }
      break;
      case "addTrack": {
        const track = new MediaStreamTrack({ kind: "video" });
        this.pc.addTransceiver(track, { direction: "sendonly" });
        await this.pc.setLocalDescription(await this.pc.createOffer());
        accept(this.pc.localDescription);

        this.udp.on("message", (data) => {
          const rtp = RtpPacket.deSerialize(data);
          track.writeRtp(rtp);
        });
      }
      break;
      case "done": {
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

export class mediachannel_removetrack_addtrack extends mediachannel_removetrack_answer_base {}

export class mediachannel_addtrack_removefirst_addtrack extends mediachannel_removetrack_answer_base {}

class mediachannel_removetrack_offer_base {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init": {
        this.pc = new RTCPeerConnection(await peerConfig);
        accept({});
      }
      break;
      case "offer": {
        await this.pc.setRemoteDescription(payload);
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        accept(this.pc.localDescription);
      }
      break;
      case "check": {
        const { index } = payload as { index: number };

        const transceiver = this.pc
          .getTransceivers()
          .find((t) => t.mLineIndex === index)!;
        const track = transceiver.receiver.track;
        await track.onReceiveRtp.asPromise(2000);
        accept({});
      }
      break;
      case "candidate": {
        await this.pc.addIceCandidate(payload);
        accept({});
      }
      break;
      case "done": {
        await this.pc.close();
      }
      break;
    }
  }
}

export class mediachannel_offer_replace_second extends mediachannel_removetrack_offer_base {}
