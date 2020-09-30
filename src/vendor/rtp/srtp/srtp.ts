import { RtpHeader } from "../rtp/rtp";
import { SrtpContext } from "./context/srtp";
import { Config, Session } from "./session";

export class SrtpSession extends Session<SrtpContext> {
  constructor(public config: Config) {
    super(SrtpContext);
    this.start(
      config.keys.localMasterKey,
      config.keys.localMasterSalt,
      config.keys.remoteMasterKey,
      config.keys.remoteMasterSalt,
      config.profile
    );
  }

  decrypt = (buf: Buffer) => {
    const [decrypted] = this.remoteContext.decryptRTP(buf);
    return decrypted;
  };

  encrypt(payload: Buffer, header: RtpHeader) {
    return this.localContext.encryptRTP(payload, header);
  }
}
