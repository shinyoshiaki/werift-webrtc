import { UdpContext } from "./context/udp";
import { Socket } from "dgram";
import { DtlsContext } from "./context/dtls";
import { RecordContext } from "./context/record";
import { CipherContext } from "./context/cipher";
import { createPlaintext } from "./record/builder";
import { ContentType } from "./record/const";

type Options = {
  port?: number;
  address?: string;
  socket: Socket;
};

export abstract class DtlsSocket {
  onConnect: () => void = () => {};
  onData: (buf: Buffer) => void = () => {};
  udp: UdpContext;
  dtls = new DtlsContext();
  record = new RecordContext();
  cipher = new CipherContext();

  constructor(options: Options) {
    this.udp = new UdpContext(options.socket, options);
  }

  send(buf: Buffer) {
    const pkt = createPlaintext(this.dtls)(
      [{ type: ContentType.applicationData, fragment: buf }],
      ++this.record.recordSequenceNumber
    )[0];
    this.udp.send(this.cipher.encryptPacket(pkt).serialize());
  }

  close() {
    this.udp.socket.close();
  }
}
