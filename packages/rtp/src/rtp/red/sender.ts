import { uint32Add } from "../../../../common/src";
import { Red } from "./packet";

export class RedSender {
  cache: { buffer: Buffer; timestamp: number }[] = [];
  cacheSize = 10;

  constructor(public blockPT: number, public distance = 1) {}

  push(payload: { buffer: Buffer; timestamp: number }) {
    this.cache.push(payload);
    if (this.cache.length > this.cacheSize) {
      this.cache.shift();
    }
  }

  build() {
    const redundantPayloads = this.cache.slice(-(this.distance + 1));
    const presentPayload = redundantPayloads.pop()!;

    const red = new Red();
    redundantPayloads.forEach((redundant) => {
      red.payloads.push({
        bin: redundant.buffer,
        blockPT: this.blockPT,
        timestampOffset: uint32Add(
          presentPayload.timestamp,
          -redundant.timestamp
        ),
      });
    });
    red.payloads.push({ bin: presentPayload.buffer, blockPT: this.blockPT });
    return red;
  }
}
