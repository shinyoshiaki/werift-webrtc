import { Socket, RemoteInfo } from "dgram";

export class UdpContext {
  constructor(public socket: Socket, public rinfo: Partial<RemoteInfo>) {}

  send(buf: Buffer) {
    this.socket.send(buf, this.rinfo.port, this.rinfo.address);
  }
}
