import { AcceptFn } from "protoo-server";
import { RTCPeerConnection } from "../..";
import { peerConfig } from "../../fixture";

export class combination_all_media_answer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(await peerConfig);
          const dc = this.pc.createDataChannel("dc");
          dc.onmessage = (e) => {
            if (e.data === "ping") {
              dc.send("pong");
            }
          };
          const transceiver = this.pc.addTransceiver("video");
          transceiver.onTrack.subscribe((track) => {
            transceiver.sender.replaceTrack(track);
          });
          await this.pc.setLocalDescription(await this.pc.createOffer());
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

export class combination_all_media_offer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(await peerConfig);
          this.pc.ondatachannel = ({ channel }) => {
            channel.onmessage = (e) => {
              if (e.data === "ping") {
                channel.send("pong");
              }
            };
          };

          const transceiver = this.pc.addTransceiver("video");
          transceiver.onTrack.subscribe((track) => {
            transceiver.sender.replaceTrack(track);
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
