import type { AcceptFn, Peer } from "protoo-server";
import { RTCPeerConnection } from "../..";
import { peerConfig } from "../../fixture";
import { acceptLocalDescription } from "../localDescription";

export class ice_trickle_answer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn, peer: Peer) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(await peerConfig);
          const dc = this.pc.createDataChannel("dc");
          dc.onMessage.subscribe((msg) => {
            dc.send(msg + "pong");
          });
          this.pc.onIceCandidate.subscribe((candidate) => {
            peer
              .request("ice_trickle_answer", { candidate: candidate ?? null })
              .catch(() => {});
          });

          const offer = await this.pc.createOffer();
          await acceptLocalDescription(this.pc, offer, accept);
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

export class ice_trickle_offer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn, peer: Peer) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(await peerConfig);
          this.pc.onDataChannel.subscribe((dc) => {
            dc.onMessage.subscribe((msg) => {
              dc.send(msg + "pong");
            });
          });
          this.pc.onIceCandidate.subscribe((candidate) => {
            peer
              .request("ice_trickle_offer", { candidate: candidate ?? null })
              .catch(() => {});
          });
          await this.pc.setRemoteDescription(payload);
          await acceptLocalDescription(
            this.pc,
            await this.pc.createAnswer(),
            accept,
          );
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
