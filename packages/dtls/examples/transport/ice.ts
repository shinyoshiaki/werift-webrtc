import { Connection } from "../../../ice/src";
import { Transport } from "../../src";
export class IceTransport implements Transport {
  constructor(private ice: Connection) {
    ice.onData.subscribe((buf) => {
      if (this.onData) this.onData(buf);
    });
  }
  onData?: (buf: Buffer) => void;

  readonly send = this.ice.send;

  close() {
    this.ice.close();
  }
}

export const createIceTransport = (ice: Connection) => new IceTransport(ice);
