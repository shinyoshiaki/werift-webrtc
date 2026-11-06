import type { RtpHeader } from "../rtp/rtp";
import { SrtpContext } from "./context/srtp";
import { type Config, Session } from "./session";

export class SrtpSession extends Session<SrtpContext> {
  public config: Config;

  constructor(config: Config) {
    super(SrtpContext);
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
    const [decrypted] = this.remoteContext.decryptRtp(buf);
    return decrypted;
  };

  encrypt(payload: Buffer, header: RtpHeader) {
    return this.localContext.encryptRtp(payload, header);
  }
}
