import { AddressInfo } from "net";
import { Address, Transport } from "../../../common/src";
import { Connection } from "../../../ice/src";

export class IceTransport implements Transport {
  constructor(private ice: Connection) {
    ice.onData.subscribe((buf) => {
      if (this.onData) this.onData(buf);
    });
  }
  onData: (data: Buffer, addr?: Address) => void = () => {};

  send = async (data: Buffer) => {
    await this.ice.send(data);
  };

  get address() {
    return {} as AddressInfo;
  }

  type = "ice";

  async close() {
    this.ice.close();
  }
}

export const createIceTransport = (ice: Connection) => new IceTransport(ice);
