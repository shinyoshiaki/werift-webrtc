import { type ChildProcess, spawn } from "child_process";
import type { AcceptFn } from "protoo-server";
import {
  MediaStreamTrack,
  MediaStreamTrackFactory,
  RTCPeerConnection,
} from "../../";
import { peerConfig } from "../../fixture";

export class mediachannel_removetrack_answer_base {
  pc!: RTCPeerConnection;
  private trackSources = new Map<
    MediaStreamTrack,
    { dispose: () => void; process: ChildProcess }
  >();

  private async createTrackSource() {
    const [track, port, dispose] =
      await MediaStreamTrackFactory.rtpSource({ kind: "video" });

    const args = [
      `videotestsrc`,
      "video/x-raw,width=640,height=480,format=I420",
      "vp8enc error-resilient=partitions keyframe-max-dist=10 auto-alt-ref=true cpu-used=5 deadline=1",
      "rtpvp8pay",
      `udpsink host=127.0.0.1 port=${port}`,
    ].join(" ! ");
    const process = spawn("gst-launch-1.0", args.split(" "));

    this.trackSources.set(track, { dispose, process });
    return track;
  }

  private disposeTrack(track: MediaStreamTrack) {
    const source = this.trackSources.get(track);
    if (!source) {
      return;
    }

    source.dispose();
    try {
      source.process.kill("SIGINT");
    } catch {}
    this.trackSources.delete(track);
  }

  private async cleanup() {
    if (this.pc) {
      this.pc.close();
    }

    for (const track of this.trackSources.keys()) {
      this.disposeTrack(track);
    }
  }

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          await this.cleanup();

          this.pc = new RTCPeerConnection(await peerConfig);
          const track = await this.createTrackSource();
          this.pc.addTrack(track);
          await this.pc.setLocalDescription(await this.pc.createOffer());
          accept(this.pc.localDescription);
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
      case "removeTrack":
        {
          const sender = this.pc
            .getTransceivers()
            .find((t) => t.mLineIndex === payload)!.sender;

          if (sender.track) {
            this.disposeTrack(sender.track);
          }
          this.pc.removeTrack(sender);
          await this.pc.setLocalDescription(await this.pc.createOffer());
          accept(this.pc.localDescription);
        }
        break;
      case "addTrack":
        {
          const track = await this.createTrackSource();
          this.pc.addTrack(track);
          await this.pc.setLocalDescription(await this.pc.createOffer());
          accept(this.pc.localDescription);
        }
        break;
      case "done":
        {
          await this.cleanup();
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
      case "init":
        {
          this.pc = new RTCPeerConnection(await peerConfig);
          accept({});
        }
        break;
      case "offer":
        {
          await this.pc.setRemoteDescription(payload);
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          accept(this.pc.localDescription);
        }
        break;
      case "check":
        {
          const { index } = payload as { index: number };

          const transceiver = this.pc
            .getTransceivers()
            .find((t) => t.mLineIndex === index)!;
          const track = transceiver.receiver.track;
          await track.onReceiveRtp.asPromise(2000);
          accept({});
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
          await this.pc.close();
        }
        break;
    }
  }
}

export class mediachannel_offer_replace_second extends mediachannel_removetrack_offer_base {}
