import { AcceptFn } from "protoo-server";
import { RTCPeerConnection } from "../../";

export class mediachannel_sendrecv_answer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceConfig: { stunServer: ["stun.l.google.com", 19302] },
          });
          const transceiver = this.pc.addTransceiver("video", "sendrecv");
          transceiver.onTrack.subscribe((track) => {
            track.onRtp.subscribe((rtp) => {
              transceiver.sendRtp(rtp);
            });
          });
          await this.pc.setLocalDescription(this.pc.createOffer());
          accept(this.pc.localDescription);
        }
        break;
      case "candidate":
        {
          await this.pc.addIceCandidate(payload);
          try {
            accept({});
          } catch (error) {}
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

export class mediachannel_sendrecv_offer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceConfig: { stunServer: ["stun.l.google.com", 19302] },
          });
          const transceiver = this.pc.addTransceiver("video", "sendrecv");
          transceiver.onTrack.subscribe((track) => {
            track.onRtp.subscribe((rtp) => {
              transceiver.sendRtp(rtp);
            });
          });
          await this.pc.setRemoteDescription(payload);
          await this.pc.setLocalDescription(this.pc.createAnswer());
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
