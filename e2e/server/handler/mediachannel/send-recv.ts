import { AcceptFn } from "protoo-server";
import { RTCPeerConnection } from "../../";

export class mediachannel_send_recv_answer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          });
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

export class mediachannel_send_recv_offer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          });
          const receiver = this.pc.addTransceiver("video", {
            direction: "recvonly",
          });
          const sender = this.pc.addTransceiver("video", {
            direction: "sendonly",
          });
          receiver.onTrack.subscribe((track) => {
            sender.sender.replaceTrack(track);
          });
          await this.pc.setRemoteDescription(payload);
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
