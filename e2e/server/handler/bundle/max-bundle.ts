import type { AcceptFn, Peer } from "protoo-server";
import { RTCPeerConnection } from "../..";
import { peerConfig } from "../../fixture";
import { createCandidateBuffer } from "../candidateBuffer";
import { acceptLocalDescription } from "../localDescription";

export class bundle_max_bundle_answer {
  pc!: RTCPeerConnection;
  private candidates!: ReturnType<typeof createCandidateBuffer>;

  async exec(type: string, payload: any, accept: AcceptFn, peer: Peer) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            ...(await peerConfig),
            bundlePolicy: "max-bundle",
          });
          this.candidates = createCandidateBuffer(this.pc);
          const dc = this.pc.createDataChannel("dc");
          dc.onmessage = (e) => {
            if (e.data === "ping") {
              dc.send("pong");
            }
          };
          this.pc.onicecandidate = (e) => {
            peer.notify("candidate", { candidate: e.candidate ?? null });
          };

          {
            const transceiver = this.pc.addTransceiver("video");
            transceiver.onTrack.subscribe((track) => {
              transceiver.sender.replaceTrack(track);
            });
          }
          {
            const transceiver = this.pc.addTransceiver("video");
            transceiver.onTrack.subscribe((track) => {
              transceiver.sender.replaceTrack(track);
            });
          }
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
          try {
            accept({});
          } catch (error) {}
        }
        break;
      case "answer":
        {
          await this.pc.setRemoteDescription(payload);
          await this.candidates.flush();
          accept({});
        }
        break;
    }
  }
}

export class bundle_max_bundle_offer {
  pc!: RTCPeerConnection;
  private candidates!: ReturnType<typeof createCandidateBuffer>;

  async exec(type: string, payload: any, accept: AcceptFn, peer: Peer) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            ...(await peerConfig),
            bundlePolicy: "max-bundle",
          });
          this.candidates = createCandidateBuffer(this.pc);
          this.pc.ondatachannel = ({ channel }) => {
            channel.onmessage = (e) => {
              if (e.data === "ping") {
                channel.send("pong");
              }
            };
          };

          {
            const transceiver = this.pc.addTransceiver("video");
            transceiver.onTrack.subscribe((track) => {
              transceiver.sender.replaceTrack(track);
            });
          }
          {
            const transceiver = this.pc.addTransceiver("video");
            transceiver.onTrack.subscribe((track) => {
              transceiver.sender.replaceTrack(track);
            });
          }

          this.pc.onicecandidate = (e) => {
            peer.notify("candidate", { candidate: e.candidate ?? null });
          };

          await this.pc.setRemoteDescription(payload);
          await this.candidates.flush();
          await acceptLocalDescription(
            this.pc,
            await this.pc.createAnswer(),
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
    }
  }
}
