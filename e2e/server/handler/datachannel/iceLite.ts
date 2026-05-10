import type { AcceptFn } from "protoo-server";
import { RTCPeerConnection } from "../..";
import { iceLitePeerConfig } from "../../fixture";

type IceLiteStats = {
  localDescriptionSdp?: string;
  connectionState: string;
  iceConnectionState: string;
  iceTransports: {
    iceLite: boolean;
    iceRole: "controlling" | "controlled";
    localCandidateTypes: string[];
    remoteCandidateTypes: string[];
    nominated?: {
      localCandidateType: string;
      remoteCandidateType: string;
      protocolType: string;
    };
  }[];
};

export class datachannel_ice_lite_answer {
  pc?: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          await this.closePeerConnection();

          this.pc = new RTCPeerConnection(await iceLitePeerConfig);
          const dc = this.pc.createDataChannel("dc");
          dc.onopen = () => {
            dc.send("server-to-browser-ice-lite");
          };
          dc.onMessage.subscribe((msg) => {
            dc.send(`${msg}pong`);
          });

          await this.pc.setLocalDescription(await this.pc.createOffer());
          accept(this.pc.localDescription);
        }
        break;
      case "candidate":
        {
          await this.pc?.addIceCandidate(payload);
          accept({});
        }
        break;
      case "answer":
        {
          await this.pc?.setRemoteDescription(payload);
          accept({});
        }
        break;
      case "stats":
        accept(this.getStats());
        break;
      case "close":
        await this.closePeerConnection();
        accept({});
        break;
    }
  }

  private getStats(): IceLiteStats {
    if (!this.pc) {
      throw new Error("peer connection is not initialized");
    }

    return {
      localDescriptionSdp: this.pc.localDescription?.sdp,
      connectionState: this.pc.connectionState,
      iceConnectionState: this.pc.iceConnectionState,
      iceTransports: this.pc.iceTransports.map((iceTransport) => {
        const nominated = iceTransport.connection.nominated;
        return {
          iceLite: iceTransport.connection.iceLite,
          iceRole: iceTransport.role,
          localCandidateTypes: iceTransport.localCandidates.map(
            (candidate) => candidate.type,
          ),
          remoteCandidateTypes: iceTransport.connection.remoteCandidates.map(
            (candidate) => candidate.type,
          ),
          nominated: nominated
            ? {
                localCandidateType: nominated.localCandidate.type,
                remoteCandidateType: nominated.remoteCandidate.type,
                protocolType: nominated.protocol.type,
              }
            : undefined,
        };
      }),
    };
  }

  private async closePeerConnection() {
    if (!this.pc) {
      return;
    }

    const activePeerConnection = this.pc;
    this.pc = undefined;
    await activePeerConnection.close();
  }
}
