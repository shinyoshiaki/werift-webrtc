import type { AcceptFn, Peer } from "protoo-server";
import { RTCPeerConnection } from "../..";
import { peerConfig } from "../../fixture";
import { acceptLocalDescription } from "../localDescription";

/**
 * `bundleCandidates: "tagOnly"` (issue #269) against the browser: werift
 * re-offers with added m-lines and answers the browser's re-offer without
 * repeating the candidates on the non-tag m-lines of the negotiated BUNDLE.
 */
export class bundle_tag_only_candidates {
  pc!: RTCPeerConnection;

  private addEchoTransceiver() {
    const transceiver = this.pc.addTransceiver("video", {
      direction: "sendrecv",
    });
    transceiver.onTrack.subscribe((track) => {
      transceiver.sender.replaceTrack(track);
    });
  }

  async exec(type: string, payload: any, accept: AcceptFn, peer: Peer) {
    switch (type) {
      case "init":
        {
          try {
            this.pc?.close();
          } catch {
            // ignore
          }
          this.pc = new RTCPeerConnection({
            ...(await peerConfig),
            bundleCandidates: "tagOnly",
          });
          const dc = this.pc.createDataChannel("dc");
          dc.onmessage = (e) => {
            if (typeof e.data === "string" && e.data.startsWith("ping")) {
              dc.send(e.data.replace("ping", "pong"));
            }
          };
          this.pc.onicecandidate = (e) => {
            peer.notify("candidate", { candidate: e.candidate ?? null });
          };
          this.pc.onRemoteTransceiverAdded.subscribe((transceiver) => {
            transceiver.onTrack.subscribe((track) => {
              transceiver.sender.replaceTrack(track);
            });
          });
          this.addEchoTransceiver();
          await acceptLocalDescription(
            this.pc,
            await this.pc.createOffer(),
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
      case "answer":
        {
          await this.pc.setRemoteDescription(payload);
          accept({});
        }
        break;
      case "reoffer":
        {
          // ICE restart なしで video の m-line を足して再 offer する
          this.addEchoTransceiver();
          await acceptLocalDescription(
            this.pc,
            await this.pc.createOffer(),
            accept,
          );
        }
        break;
      case "offer":
        {
          // ブラウザの再 offer に answer を返す
          await this.pc.setRemoteDescription(payload);
          for (const transceiver of this.pc.getTransceivers()) {
            if (transceiver.direction === "recvonly") {
              transceiver.setDirection("sendrecv");
            }
          }
          await acceptLocalDescription(
            this.pc,
            await this.pc.createAnswer(),
            accept,
          );
        }
        break;
      case "done":
        {
          this.pc.close();
          accept({});
        }
        break;
    }
  }
}
