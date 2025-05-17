import { type Chunk, serializePacket } from "./chunk";
import type { Unpacked } from "./helper";
import type { Transport } from "./transport";

export class SCTPTransmitter {
  private localPort: number;
  remotePort?: number;
  remoteVerificationTag = 0;
  state: SCTPConnectionState = "new";

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
}
export const SCTPConnectionStates = [
  "new",
  "closed",
  "connected",
  "connecting",
] as const;
export type SCTPConnectionState = Unpacked<typeof SCTPConnectionStates>;
