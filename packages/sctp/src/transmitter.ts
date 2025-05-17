import { type Chunk, serializePacket } from "./chunk";
import type { Unpacked } from "./helper";
import { debug, Event } from "./imports/common";
import type { Transport } from "./transport";

const log = debug("packages/sctp/src/transmitter.ts");

export class SCTPTransmitter {
  private localPort: number;
  remotePort?: number;
  remoteVerificationTag = 0;
  state: SCTPConnectionState = "new";
  onStateChanged = new Event();

  constructor(
    public transport: Transport,
    public port = 5000,
  ) {
    this.localPort = port;
  }

  async sendChunk(chunk: Chunk) {
    if (this.state === "closed") return;
    if (this.remotePort === undefined) {
      throw new Error("invalid remote port");
    }

    const packet = serializePacket(
      this.localPort,
      this.remotePort,
      this.remoteVerificationTag,
      chunk,
    );
    await this.transport.send(packet);
  }

  setConnectionState(state: SCTPConnectionState) {
    this.state = state;
    log("setConnectionState", state);
    this.onStateChanged.execute();
  }
}
export const SCTPConnectionStates = [
  "new",
  "closed",
  "connected",
  "connecting",
] as const;
export type SCTPConnectionState = Unpacked<typeof SCTPConnectionStates>;
