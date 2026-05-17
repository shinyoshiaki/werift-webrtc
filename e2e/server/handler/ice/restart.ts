import type { AcceptFn, Peer } from "protoo-server";
import { RTCPeerConnection } from "../..";
import { peerConfig } from "../../fixture";
import { createCandidateBuffer } from "../candidateBuffer";
import { acceptLocalDescription } from "../localDescription";

const ice_restart_web_trigger_label = "ice_restart_web_trigger";
export class ice_restart_web_trigger {
  pc!: RTCPeerConnection;
  private candidates!: ReturnType<typeof createCandidateBuffer>;

  async exec(type: string, payload: any, accept: AcceptFn, peer: Peer) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            ...(await peerConfig),
            icePasswordPrefix: "restartw",
          });
          this.candidates = createCandidateBuffer(this.pc);
          this.pc.onIceCandidate.subscribe((candidate) => {
            peer
              .request(ice_restart_web_trigger_label + "ice", {
                candidate: candidate ?? null,
              })
              .catch((e) => {
                console.error(e);
              });
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

          await acceptLocalDescription(
            this.pc,
            await this.pc.createOffer(),
            accept,
          );
        }
        break;
      case "candidate":
        {
          await this.candidates.add(payload);
          accept({});
        }
        break;
      case "answer":
        {
          await this.pc.setRemoteDescription(payload);
          await this.candidates.flush();
          accept({});
        }
        break;
      case "offer":
        {
          await this.pc.setRemoteDescription(payload);
          await this.candidates.flush();
          const answer = await this.pc.createAnswer();
          await acceptLocalDescription(this.pc, answer, accept);
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
  private candidates!: ReturnType<typeof createCandidateBuffer>;

  async exec(type: string, payload: any, accept: AcceptFn, peer: Peer) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(await peerConfig);
          this.candidates = createCandidateBuffer(this.pc);
          this.pc.onIceCandidate.subscribe((candidate) => {
            peer
              .request(ice_restart_node_trigger_label + "ice", {
                candidate: candidate ?? null,
              })
              .catch((e) => {
                console.error(e);
              });
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

          await acceptLocalDescription(
            this.pc,
            await this.pc.createOffer(),
            accept,
          );
        }
        break;
      case "candidate":
        {
          await this.candidates.add(payload);
          accept({});
        }
        break;
      case "answer":
        {
          await this.pc.setRemoteDescription(payload);
          await this.candidates.flush();
          accept({});
        }
        break;
      case "restart":
        {
          await acceptLocalDescription(
            this.pc,
            await this.pc.createOffer({ iceRestart: true }),
            accept,
          );
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
