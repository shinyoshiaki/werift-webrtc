import type { AcceptFn } from "protoo-server";
import {
  type MediaStreamTrack,
  RTCPeerConnection,
  type RTCRtpTransceiver,
} from "../..";
import { peerConfig } from "../../fixture";

export class mediachannel_oneway_answer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(await peerConfig);
          const receiver = this.pc.addTransceiver("video", {
            direction: "recvonly",
          });
          const sender = this.pc.addTransceiver("video", {
            direction: "sendonly",
          });
          receiver.onTrack.subscribe((track) => {
            sender.sender.replaceTrack(track);
          });
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
    }
  }
}

export class mediachannel_oneway_offer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(await peerConfig);
          // JSEP 5.10: the browser's offer (sendonly, recvonly) gets its own
          // transceivers: receive on the first, send back on the second.
          const remote: RTCRtpTransceiver[] = [];
          let received: MediaStreamTrack | undefined;
          this.pc.onRemoteTransceiverAdded.subscribe((transceiver) => {
            remote.push(transceiver);
            if (remote.length === 1) {
              transceiver.onTrack.subscribe((track) => {
                received = track;
                remote[1]?.sender.replaceTrack(track);
              });
            } else {
              transceiver.setDirection("sendonly");
            }
          });
          await this.pc.setRemoteDescription(payload);
          if (received) await remote[1]?.sender.replaceTrack(received);
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          accept(this.pc.localDescription);
        }
        break;
      case "candidate":
        {
          await this.pc.addIceCandidate(payload);
          accept({});
        }
        break;
    }
  }
}
