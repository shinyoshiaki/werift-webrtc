import type { AcceptFn } from "protoo-server";
import { RTCPeerConnection, StunOverTurnProtocol } from "../..";
import { peerConfig } from "../../fixture";
import {
  type TurnRelayTransport,
  getTurnIceServer,
  getTurnTlsOptions,
} from "../../turn";

type TurnRelayInitPayload = {
  offer: {
    type: "offer" | "answer";
    sdp: string;
  };
  transport: TurnRelayTransport;
};

export class datachannel_turn_relay {
  pc?: RTCPeerConnection;

  async exec(type: string, payload: TurnRelayInitPayload, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          await this.closePeerConnection();

          this.pc = new RTCPeerConnection({
            ...(await peerConfig),
            iceServers: [getTurnIceServer(payload.transport)],
            iceTransportPolicy: "relay",
            turnTlsOptions:
              payload.transport === "tls" ? getTurnTlsOptions() : undefined,
          });
          this.pc.onDataChannel.subscribe((dc) => {
            dc.onopen = () => {
              dc.send(`server-to-browser-${payload.transport}`);
            };
            dc.onMessage.subscribe((msg) => {
              dc.send(`${msg}pong`);
            });
          });

          await this.pc.setRemoteDescription(payload.offer);
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          accept(this.pc.localDescription);
        }
        break;
      case "stats":
        accept(this.getRelayStats());
        break;
      case "close":
        await this.closePeerConnection();
        accept({});
        break;
    }
  }

  private getRelayStats() {
    if (!this.pc) {
      throw new Error("peer connection is not initialized");
    }

    return {
      connectionState: this.pc.connectionState,
      iceConnectionState: this.pc.iceConnectionState,
      iceTransports: this.pc.iceTransports.map((iceTransport) => {
        const nominated = iceTransport.connection.nominated;
        const nominatedRelayTransport =
          nominated?.protocol instanceof StunOverTurnProtocol
            ? nominated.protocol.turn.transport.type
            : undefined;

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
                remoteCandidateType: nominated.remoteCandidate.type,
                protocolType: nominated.protocol.type,
                relayTransport: nominatedRelayTransport,
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
