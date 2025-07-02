import { readFileSync } from "fs";
import type { Transport } from "../src/transport";

export function load(name: string) {
  return readFileSync("./tests/data/" + name);
}

export class MockTransport implements Transport {
  private peer?: MockTransport;
  public onData?: (buf: Buffer) => void;

  setPeer(peer: MockTransport) {
    this.peer = peer;
  }

  async send(buf: Buffer): Promise<void> {
    if (this.peer?.onData) {
      // Simulate async network delay
      await new Promise(resolve => setImmediate(resolve));
      this.peer.onData(buf);
    }
  }

  close(): void {
    this.onData = undefined;
    this.peer = undefined;
  }
}
