import type { AddressInfo } from "net";
import type { Address, Transport } from "../../../common/src";
import type { Connection } from "../../../ice/src";

export class IceTransport implements Transport {
  closed: boolean = false;
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
    this.closed = true;
    this.ice.close();
  }
}

export const createIceTransport = (ice: Connection) => new IceTransport(ice);
