import { SrtcpContext } from "./context/srtcp";
import { type Config, Session } from "./session";

export class SrtcpSession extends Session<SrtcpContext> {
  public config: Config;

  constructor(config: Config) {
    super(SrtcpContext);
    this.config = config;

    this.start(
      config.keys.localMasterKey,
      config.keys.localMasterSalt,
      config.keys.remoteMasterKey,
      config.keys.remoteMasterSalt,
      config.profile,
    );
  }

  decrypt = (buf: Buffer) => {
    const [decrypted] = this.remoteContext.decryptRTCP(buf);
    return decrypted;
  };

  encrypt(rawRtcp: Buffer) {
    const enc = this.localContext.encryptRTCP(rawRtcp);
    return enc;
  }
}
