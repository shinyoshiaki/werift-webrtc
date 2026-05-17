import type { AcceptFn, Peer } from "protoo-server";
import { RTCPeerConnection } from "../..";
import { peerConfig } from "../../fixture";
import { acceptLocalDescription } from "../localDescription";

type PendingCandidate = Parameters<RTCPeerConnection["addIceCandidate"]>[0];

function createCandidateBuffer(pc: RTCPeerConnection) {
  const pending: PendingCandidate[] = [];

  return {
    async add(candidate: PendingCandidate) {
      if (!pc.remoteDescription) {
        pending.push(candidate);
        return;
      }
      await pc.addIceCandidate(candidate);
    },
    async flush() {
      if (!pc.remoteDescription) {
        return;
      }
      while (pending.length > 0) {
        const candidate = pending.shift();
        await pc.addIceCandidate(candidate);
      }
    },
  };
}

export class ice_trickle_answer {
  pc!: RTCPeerConnection;
  private candidates!: ReturnType<typeof createCandidateBuffer>;

  async exec(type: string, payload: any, accept: AcceptFn, peer: Peer) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(await peerConfig);
          this.candidates = createCandidateBuffer(this.pc);
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
    }
  }
}

export class ice_trickle_offer {
  pc!: RTCPeerConnection;
  private candidates!: ReturnType<typeof createCandidateBuffer>;

  async exec(type: string, payload: any, accept: AcceptFn, peer: Peer) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(await peerConfig);
          this.candidates = createCandidateBuffer(this.pc);
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
