import type { AcceptFn, Peer } from "protoo-server";
import { RTCPeerConnection } from "../..";
import { peerConfig } from "../../fixture";

const ice_restart_web_trigger_label = "ice_restart_web_trigger";
export class ice_restart_web_trigger {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn, peer: Peer) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            ...(await peerConfig),
            icePasswordPrefix: "restartw",
          });
          this.pc.onIceCandidate.subscribe((candidate) => {
            peer
              .request(ice_restart_web_trigger_label + "ice", candidate)
              .catch((e) => {
                console.error(e);
              });
          });
          this.pc.iceConnectionStateChange.subscribe((state) => {
            console.log(state);
          });

          const transceiver = this.pc.addTransceiver("video");
          transceiver.onTrack.subscribe((track) => {
            transceiver.sender.replaceTrack(track);
            const interval = setInterval(async () => {
              if (this.pc.signalingState === "closed") {
                clearInterval(interval);
                return;
              }
              await transceiver.receiver.sendRtcpPLI(track.ssrc);
            }, 3000);
          });

          this.pc.setLocalDescription(await this.pc.createOffer());
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
          await this.pc.setRemoteDescription(payload);
          accept({});
        }
        break;
      case "offer":
        {
          await this.pc.setRemoteDescription(payload);
          const answer = await this.pc.createAnswer();
          this.pc.setLocalDescription(answer);
          accept(this.pc.localDescription);
        }
        break;
      case "fin":
        {
          this.pc.close();
          accept({});
        }
        break;
    }
  }
}

const ice_restart_node_trigger_label = "ice_restart_node_trigger";
export class ice_restart_node_trigger {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn, peer: Peer) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(await peerConfig);
          this.pc.onIceCandidate.subscribe((candidate) => {
            peer
              .request(ice_restart_node_trigger_label + "ice", candidate)
              .catch((e) => {
                console.error(e);
              });
          });
          this.pc.iceConnectionStateChange.subscribe((state) => {
            console.log(state);
          });

          const transceiver = this.pc.addTransceiver("video");
          transceiver.onTrack.subscribe((track) => {
            transceiver.sender.replaceTrack(track);
            const interval = setInterval(async () => {
              if (this.pc.signalingState === "closed") {
                clearInterval(interval);
                return;
              }
              await transceiver.receiver.sendRtcpPLI(track.ssrc);
            }, 3000);
          });

          this.pc.setLocalDescription(await this.pc.createOffer());
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
          await this.pc.setRemoteDescription(payload);
          accept({});
        }
        break;
      case "restart":
        {
          await this.pc.setLocalDescription(
            await this.pc.createOffer({ iceRestart: true }),
          );
          accept(this.pc.localDescription);
        }
        break;
      case "fin":
        {
          this.pc.close();
          accept({});
        }
        break;
    }
  }
}
