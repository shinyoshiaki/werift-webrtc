import type { AcceptFn } from "protoo-server";
import { RTCPeerConnection } from "../..";
import { peerConfig } from "../../fixture";

type IceTcpInitPayload = {
  offer: {
    type: "offer" | "answer";
    sdp: string;
  };
};

function filterSdpToTcp(sdp: string) {
  return sdp
    .split(/\r?\n/)
    .filter((line) => {
      if (line.startsWith("a=candidate:")) {
        return /\s(?:TCP|tcp)\s/.test(line);
      }
      return true;
    })
    .join("\r\n");
}

export class datachannel_ice_tcp {
  pc?: RTCPeerConnection;

  async exec(type: string, payload: IceTcpInitPayload, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          await this.closePeerConnection();

          this.pc = new RTCPeerConnection({
            ...(await peerConfig),
            iceServers: [],
            iceUseIpv6: false,
            iceUseTcp: true,
          });
          this.pc.onDataChannel.subscribe((dc) => {
            dc.onopen = () => {
              dc.send("server-to-browser-ice-tcp");
            };
            dc.onMessage.subscribe((msg) => {
              dc.send(`${msg}pong`);
            });
          });

          await this.pc.setRemoteDescription(payload.offer);
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          accept({
            ...this.pc.localDescription,
            sdp: filterSdpToTcp(this.pc.localDescription!.sdp),
          });
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

  private getStats() {
    if (!this.pc) {
      throw new Error("peer connection is not initialized");
    }

    return {
      connectionState: this.pc.connectionState,
      iceConnectionState: this.pc.iceConnectionState,
      iceTransports: this.pc.iceTransports.map((iceTransport) => {
        const nominated = iceTransport.connection.nominated;
        return {
          state: iceTransport.state,
          localCandidateTypes: iceTransport.localCandidates.map(
            (candidate) => candidate.type,
          ),
          remoteCandidateTypes: iceTransport.connection.remoteCandidates.map(
            (candidate) => candidate.type,
          ),
          nominated: nominated
            ? {
                localCandidateType: nominated.localCandidate.type,
                localCandidateTransport: nominated.localCandidate.transport,
                localTcpType: nominated.localCandidate.tcptype,
                remoteCandidateType: nominated.remoteCandidate.type,
                remoteCandidateTransport: nominated.remoteCandidate.transport,
                remoteTcpType: nominated.remoteCandidate.tcptype,
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
