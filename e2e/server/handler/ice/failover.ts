import type { AcceptFn } from "protoo-server";
import type { Address } from "../../../../packages/common/src";
import type {
  Message,
  Protocol,
  TransactionRequestOptions,
} from "../../../../packages/ice/src";
import { TransactionTimeout } from "../../../../packages/ice/src/exceptions";
import { type RTCDataChannel, RTCPeerConnection } from "../..";
import { peerConfig } from "../../fixture";
import { getTurnIceServer } from "../../turn";

type FailoverInitPayload = {
  /** Enable `PeerConfig.iceRenomination` (advertise `a=ice-options:renomination`). */
  renomination: boolean;
};

/** What the werift agent saw, for the browser's assertions. */
export type FailoverStats = {
  connectionState: string;
  iceConnectionState: string;
  controlling: boolean;
  remoteRenomination: boolean;
  generation: number;
  nominated?: {
    localCandidateType: string;
    remoteAddress: string;
    remotePort: number;
  };
  /** The ICE agent's states since the cut. */
  states: string[];
};

/**
 * werift offers (controlling, semi-aggressive or renomination) with host and
 * TURN relay candidates; the browser answers and both select the host path.
 * `cut` then cuts werift's host sockets off (nothing is sent or received on
 * them; requests time out), as when a network interface goes away, so werift
 * has to fail over to its relay pair without an ICE restart.
 */
export class ice_failover {
  pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private states: string[] = [];

  async exec(type: string, payload: FailoverInitPayload, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          await this.close();
          this.states = [];
          const pc = new RTCPeerConnection({
            ...(await peerConfig),
            iceServers: [getTurnIceServer("udp")],
            iceUseIpv6: false,
            iceRenomination: payload.renomination,
          });
          this.pc = pc;
          const channel = pc.createDataChannel("failover");
          this.channel = channel;
          channel.onMessage.subscribe((message) => {
            channel.send(`${message}pong`);
          });
          await pc.setLocalDescription(await pc.createOffer());
          await this.gatheringComplete(pc);
          accept(pc.localDescription);
        }
        break;
      case "answer":
        await this.pc!.setRemoteDescription(payload as never);
        accept({});
        break;
      case "cut":
        this.cutHostSockets();
        accept({});
        break;
      case "send":
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

  private cutHostSockets() {
    const connection = this.pc!.iceTransports[0]!.connection;
    connection.stateChanged.subscribe((state) => this.states.push(state));
    const protocols = (connection as unknown as { protocols: Protocol[] })
      .protocols;
    for (const protocol of protocols) {
      if (protocol.localCandidate?.type !== "host") continue;
      protocol.request = (async (
        _message: Message,
        _address: Address,
        _integrityKey?: Buffer,
        options?: TransactionRequestOptions,
      ) => {
        // Lost on the way: the transaction times out (or is cancelled).
        const retransmissions = options?.retransmissions ?? 0;
        const timeout = options?.responseTimeout ?? 50;
        let wait = 0;
        for (let i = 0; i <= retransmissions; i++) wait += timeout * 2 ** i;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait);
          options?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        throw new TransactionTimeout();
      }) as typeof protocol.request;
      protocol.sendStun = async () => {};
      protocol.sendData = async () => {};
      protocol.onRequestReceived.execute = () => {};
      protocol.onDataReceived.execute = () => {};
    }
  }

  private stats(): FailoverStats {
    const pc = this.pc!;
    const connection = pc.iceTransports[0]!.connection;
    const nominated = connection.nominated;
    return {
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      controlling: connection.iceControlling,
      remoteRenomination: !!connection.remoteRenomination,
      generation: connection.generation,
      nominated: nominated && {
        localCandidateType: nominated.localCandidate.type,
        remoteAddress: nominated.remoteAddr[0],
        remotePort: nominated.remoteAddr[1],
      },
      states: this.states,
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
