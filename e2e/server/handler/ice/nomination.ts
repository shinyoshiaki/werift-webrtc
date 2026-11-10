import type { AcceptFn } from "protoo-server";
import { type RTCDataChannel, RTCPeerConnection } from "../..";
import { peerConfig } from "../../fixture";
import { getTurnIceServer } from "../../turn";

type NominationInitPayload = {
  /** Enable `PeerConfig.iceRenomination` (advertise `a=ice-options:renomination`). */
  renomination: boolean;
  /** The browser's offer (Chrome controlling); absent when werift offers (werift controlling). */
  offer?: { type: "offer"; sdp: string };
};

/** What the werift agent saw of the nomination, for the browser's assertions. */
export type NominationStats = {
  connectionState: string;
  /** werift's ICE role. */
  controlling: boolean;
  /** werift saw `a=ice-options:renomination` in the browser's description. */
  remoteRenomination: boolean;
  nominated?: {
    localCandidateType: string;
    remoteAddress: string;
    remotePort: number;
    /** The NOMINATION value werift sent and Chrome answered (werift controlling). */
    nomination: number;
    /** The largest nomination Chrome sent for the pair (werift controlled). */
    remoteNomination: number;
  };
  /** Incoming STUN binding requests that carried USE-CANDIDATE. */
  useCandidateReceived: number;
  /** NOMINATION values carried by incoming STUN binding requests. */
  nominationsReceived: number[];
};

/**
 * werift with a TURN relay whose own checks only use relay pairs
 * (`iceFilterCandidatePair`): the first path that connects is relay <-> host.
 * A host path forms only once the browser signals werift's host candidates
 * (which it holds back) and Chrome's checks reach the host socket, so the
 * selection has to move from the relay pair to the better host pair.
 */
export class ice_nomination {
  pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private useCandidateReceived = 0;
  private nominationsReceived: number[] = [];

  async exec(type: string, payload: NominationInitPayload, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          await this.close();
          this.useCandidateReceived = 0;
          this.nominationsReceived = [];
          const pc = new RTCPeerConnection({
            ...(await peerConfig),
            iceServers: [getTurnIceServer("udp")],
            iceUseIpv6: false,
            iceRenomination: payload.renomination,
            iceFilterCandidatePair: (pair) =>
              pair.localCandidate.type === "relay",
            iceFilterStunResponse: (message) => {
              const keys = message.attributesKeys;
              if (keys.includes("USE-CANDIDATE")) this.useCandidateReceived++;
              if (keys.includes("NOMINATION")) {
                this.nominationsReceived.push(
                  message.getAttributeValue("NOMINATION"),
                );
              }
              return true;
            },
          });
          this.pc = pc;
          const onChannel = (channel: RTCDataChannel) => {
            this.channel = channel;
            channel.onMessage.subscribe((message) => {
              channel.send(`${message}pong`);
            });
          };
          pc.onDataChannel.subscribe(onChannel);

          if (payload.offer) {
            await pc.setRemoteDescription(payload.offer);
            await pc.setLocalDescription(await pc.createAnswer());
          } else {
            onChannel(pc.createDataChannel("nomination"));
            await pc.setLocalDescription(await pc.createOffer());
          }
          await this.gatheringComplete(pc);
          accept(pc.localDescription);
        }
        break;
      case "answer":
        await this.pc!.setRemoteDescription(payload as never);
        accept({});
        break;
      case "send":
        // werift sends on its selected pair (Chrome follows the data when
        // nominations tie, see the test).
        this.channel?.send("server-to-browser");
        accept({});
        break;
      case "stats":
        accept(this.stats());
        break;
      case "close":
        await this.close();
        accept({});
        break;
    }
  }

  private stats(): NominationStats {
    const pc = this.pc!;
    const connection = pc.iceTransports[0]!.connection;
    const nominated = connection.nominated;
    return {
      connectionState: pc.connectionState,
      controlling: connection.iceControlling,
      remoteRenomination: !!connection.remoteRenomination,
      nominated: nominated && {
        localCandidateType: nominated.localCandidate.type,
        remoteAddress: nominated.remoteAddr[0],
        remotePort: nominated.remoteAddr[1],
        nomination: nominated.nomination,
        remoteNomination: nominated.remoteNomination,
      },
      useCandidateReceived: this.useCandidateReceived,
      nominationsReceived: this.nominationsReceived,
    };
  }

  private async gatheringComplete(pc: RTCPeerConnection) {
    if (pc.iceGatheringState === "complete") return;
    await pc.iceGatheringStateChange.watch((state) => state === "complete");
  }

  private async close() {
    const pc = this.pc;
    this.pc = undefined;
    this.channel = undefined;
    await pc?.close();
  }
}
