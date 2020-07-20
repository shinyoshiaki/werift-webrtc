import { TransportContext } from "./context/transport";
import { DtlsContext } from "./context/dtls";
import { RecordContext } from "./context/record";
import { CipherContext } from "./context/cipher";
import { createPlaintext } from "./record/builder";
import { ContentType } from "./record/const";
import { Transport } from "./transport";

export type Options = {
  cert: string; // when Server CertificateRequest
  key: string; // when Server CertificateRequest
  srtpProfiles: number[];
};

export abstract class DtlsSocket {
  onConnect: () => void = () => {};
  onData: (buf: Buffer) => void = () => {};
  onClose: () => void = () => {};
  udp: TransportContext;
  dtls = new DtlsContext();
  record = new RecordContext();
  cipher = new CipherContext();

  constructor(socket: Transport, public options: Partial<Options> = {}) {
    this.udp = new TransportContext(socket);
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
