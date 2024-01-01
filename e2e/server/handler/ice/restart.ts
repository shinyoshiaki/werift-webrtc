import { AcceptFn, Peer } from "protoo-server";
import { RTCPeerConnection } from "../..";
import { peerConfig } from "../../fixture";

export class ice_restart_answer {
  label = "ice_restart_answer";
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn, peer: Peer) {
    switch (type) {
      case "init": {
        this.pc = new RTCPeerConnection(await peerConfig);
        const dc = this.pc.createDataChannel("dc");
        dc.onMessage.subscribe((msg) => {
          dc.send(msg + "pong");
        });
        this.pc.onIceCandidate.subscribe((candidate) => {
          peer.request(this.label, candidate).catch(() => {});
        });

        const offer = await this.pc.createOffer();
        this.pc.setLocalDescription(offer);
        accept(this.pc.localDescription);
      }
      break;
      case "candidate": {
        this.pc.addIceCandidate(payload);
        accept({});
      }
      break;
      case "answer": {
        this.pc.setRemoteDescription(payload);
        accept({});
      }
      break;
      case "restart": {
        this.pc.restartIce();
        const offer = await this.pc.createOffer();
        this.pc.setLocalDescription(offer);
        accept(this.pc.localDescription);
        await this.pc.iceConnectionStateChange.watch((e) => e === "connected");
        this.pc.dataChannels[0].send("ping" + "pong" + "pang");
      }
      break;
    }
  }
}

export class ice_restart_offer {
  label = "ice_restart_offer";
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn, peer: Peer) {
    switch (type) {
      case "init": {
        this.pc = new RTCPeerConnection(await peerConfig);
        this.pc.onDataChannel.subscribe((dc) => {
          dc.onMessage.subscribe((msg) => {
            dc.send(msg + "pong");
          });
        });
        this.pc.onIceCandidate.subscribe((candidate) => {
          peer.request(this.label, candidate).catch(() => {});
        });
        this.pc.setRemoteDescription(payload);
        this.pc.setLocalDescription(await this.pc.createAnswer());

        accept(this.pc.localDescription);
      }
      break;
      case "candidate": {
        await this.pc.addIceCandidate(payload);
        accept({});
      }
      break;
      case "restart": {
        this.pc.setRemoteDescription(payload);
        this.pc.setLocalDescription(await this.pc.createAnswer());

        accept(this.pc.localDescription);

        // await this.pc.iceConnectionStateChange.watch((e) => e === "connected");
        this.pc.dataChannels[0].send("ping" + "pong" + "pang");
      }
      break;
    }
  }
}
