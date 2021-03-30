import { AcceptFn } from "protoo-server";
import { RTCPeerConnection } from "../";

export class datachannel_answer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceConfig: { stunServer: ["stun.l.google.com", 19302] },
          });
          const dc = this.pc.createDataChannel("dc");
          dc.message.subscribe((msg) => {
            dc.send(msg + "pong");
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

export class datachannel_offer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceConfig: { stunServer: ["stun.l.google.com", 19302] },
          });
          await this.pc.setRemoteDescription(payload);
          await this.pc.setLocalDescription(await this.pc.createAnswer());

          this.pc.onDataChannel.subscribe((dc) => {
            dc.message.subscribe((msg) => {
              dc.send(msg + "pong");
            });
          });

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
