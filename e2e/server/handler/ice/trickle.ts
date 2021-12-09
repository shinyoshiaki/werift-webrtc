import { AcceptFn, Peer } from "protoo-server";
import { RTCPeerConnection } from "../..";
import { DtlsKeysContext } from "../../fixture";

export class ice_trickle_answer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn, peer: Peer) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
            dtls: { keys: await DtlsKeysContext.get() },
          });
          const dc = this.pc.createDataChannel("dc");
          dc.message.subscribe((msg) => {
            dc.send(msg + "pong");
          });
          this.pc.onIceCandidate.subscribe((candidate) => {
            peer.request("ice_trickle_answer", candidate).catch(() => {});
          });

          const offer = await this.pc.createOffer();
          this.pc.setLocalDescription(offer);
          accept(this.pc.localDescription);
        }
        break;
      case "candidate":
        {
          this.pc.addIceCandidate(payload);
          accept({});
        }
        break;
      case "answer":
        {
          this.pc.setRemoteDescription(payload);
          accept({});
        }
        break;
    }
  }
}

export class ice_trickle_offer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn, peer: Peer) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
            dtls: { keys: await DtlsKeysContext.get() },
          });
          this.pc.onDataChannel.subscribe((dc) => {
            dc.message.subscribe((msg) => {
              dc.send(msg + "pong");
            });
          });
          this.pc.onIceCandidate.subscribe((candidate) => {
            peer.request("ice_trickle_offer", candidate).catch(() => {});
          });
          await this.pc.setRemoteDescription(payload);
          this.pc.setLocalDescription(await this.pc.createAnswer());

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
