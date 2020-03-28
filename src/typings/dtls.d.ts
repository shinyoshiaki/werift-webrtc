type Options = {
  type: string;
  remotePort: number;
  remoteAddress: string;
  maxHandshakeRetransmissions: number;
};

declare module "@nodertc/dtls" {
  import { Socket } from "dgram";
  type Dtls = {
    connect(options: Partial<Options>): Socket;
    createServer(args: { socket: Socket }): Socket;
  };
  declare const dtls: Dtls;
  export default dtls;
}
