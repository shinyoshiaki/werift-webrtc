import { AcceptFn } from "protoo-server";
import { RTCPeerConnection } from "../../../../packages/webrtc/src";

export class datachannel_close_server_answer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceConfig: { stunServer: ["stun.l.google.com", 19302] },
          });
          const dc = this.pc.createDataChannel("dc");
          dc.message.subscribe(() => {
            dc.close();
          });
          dc.stateChanged.subscribe(console.log);
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
