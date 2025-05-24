import type { RemoteInfo, Socket } from "dgram";

export interface Transport {
  onData?: (buf: Buffer) => void;
  send: (buf: Buffer) => Promise<void>;
  close: () => void;
}

export class UdpTransport implements Transport {
  constructor(
    private udp: Socket,
    private remoteInfo: Partial<RemoteInfo>,
  ) {
    udp.on("message", (buf, target) => {
      this.remoteInfo = target;
      if (this.onData) this.onData(buf);
    });
  }
  onData?: (buf: Buffer) => void;

  send = (buf: Buffer) =>
    new Promise<void>((r, f) => {
      this.udp.send(
        buf,
        this.remoteInfo.port,
        this.remoteInfo.address,
        (err) => {
          if (err) {
            f(err);
          } else {
            r();
          }
        },
      );
    });

  close() {
    this.udp.close();
  }
}

export const createUdpTransport = (
  socket: Socket,
  rinfo: Partial<RemoteInfo> = {},
) => new UdpTransport(socket, rinfo);
