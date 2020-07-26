import { Transport } from "../transport";
import { Session, Config } from "./session";
import { SrtcpContext } from "./context/srtcp";

export class SrtcpSession extends Session<SrtcpContext> {
  constructor(transport: Transport, public config: Config) {
    super(transport, SrtcpContext);

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
    const [decrypted] = this.remoteContext.decryptRTCP(buf);
    return decrypted;
  };
}
