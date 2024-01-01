import { RemoteInfo, Socket } from "dgram";

export interface Transport {
  onData?: (buf: Buffer) => void;
  send: (buf: Buffer) => void;
  close: () => void;
}

export class UdpTransport implements Transport {
  constructor(private upd: Socket, private rinfo: Partial<RemoteInfo>) {
    upd.on("message", (buf, target) => {
      this.rinfo = target;
      if (this.onData) this.onData(buf);
    });
  }
  onData?: (buf: Buffer) => void;

  send(buf: Buffer) {
    this.upd.send(buf, this.rinfo.port, this.rinfo.address);
  }

  close() {
    this.upd.close();
  }
}

export const createUdpTransport = (
  socket: Socket,
  rinfo: Partial<RemoteInfo> = {},
) => new UdpTransport(socket, rinfo);
