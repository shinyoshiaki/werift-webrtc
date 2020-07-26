import { Transport } from "../transport";
import { Session, Config } from "./session";
import { RtpHeader } from "../rtp/rtp";
import { SrtpContext } from "./context/srtp";

export class SrtpSession extends Session<SrtpContext> {
  constructor(transport: Transport, public config: Config) {
    super(transport, SrtpContext);
    this.start(
      config.keys.localMasterKey,
      config.keys.localMasterSalt,
      config.keys.remoteMasterKey,
      config.keys.remoteMasterSalt,
      config.profile,
      this.decrypt
    );
  }

  decrypt = (buf: Buffer) => {
    const [decrypted] = this.remoteContext.decryptRTP(buf);
    return decrypted;
  };

  sendRTP(header: RtpHeader, payload: Buffer) {
    const [enc] = this.localContext.encryptRTP(payload, header);
    this.transport.send(enc);
  }
}
