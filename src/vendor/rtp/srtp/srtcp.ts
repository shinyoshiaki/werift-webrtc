import { Session, Config } from "./session";
import { SrtcpContext } from "./context/srtcp";

export class SrtcpSession extends Session<SrtcpContext> {
  constructor(public config: Config) {
    super(SrtcpContext);

    this.start(
      config.keys.localMasterKey,
      config.keys.localMasterSalt,
      config.keys.remoteMasterKey,
      config.keys.remoteMasterSalt,
      config.profile
    );
  }

  decrypt = (buf: Buffer) => {
    const [decrypted] = this.remoteContext.decryptRTCP(buf);
    return decrypted;
  };

  encrypt(payload: Buffer) {
    const enc = this.localContext.encryptRTCP(payload);
    return enc;
  }
}
