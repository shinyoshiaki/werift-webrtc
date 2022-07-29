import { Connection } from "../../../ice/src";
import { Transport } from "../../src";
export class IceTransport implements Transport {

  readonly send: any = {};
  private ice: any = {};

  constructor(_ice: Connection) {
    this.ice = _ice;
    this.send = this.ice.send;
    _ice.onData.subscribe((buf) => {
      if (this.onData) this.onData(buf);
    });
  }
  onData?: (buf: Buffer) => void;

  close() {
    this.ice.close();
  }
}

export const createIceTransport = (ice: Connection) => new IceTransport(ice);
