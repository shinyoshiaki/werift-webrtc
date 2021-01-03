import { AcceptFn } from "protoo-server";
import { RTCPeerConnection } from "../../../../../packages/webrtc/src";

export class mediachannel_sendrecv_answer_ {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            stunServer: ["stun.l.google.com", 19302],
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
