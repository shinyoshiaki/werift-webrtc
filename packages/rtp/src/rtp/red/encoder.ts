import { uint32Add } from "../../../../common/src";
import { Red } from "./packet";

export class RedEncoder {
  private cache: { block: Buffer; timestamp: number; blockPT: number }[] = [];
  cacheSize = 10;

  constructor(public distance = 1) {}

  push(payload: { block: Buffer; timestamp: number; blockPT: number }) {
    this.cache.push(payload);
    if (this.cache.length > this.cacheSize) {
      this.cache.shift();
    }
  }

  build() {
    const red = new Red();
    const redundantPayloads = this.cache.slice(-(this.distance + 1));

    const presentPayload = redundantPayloads.pop();
    if (!presentPayload) {
      return red;
    }

    redundantPayloads.forEach((redundant) => {
      red.blocks.push({
        block: redundant.block,
        blockPT: redundant.blockPT,
        timestampOffset: uint32Add(
          presentPayload.timestamp,
          -redundant.timestamp
        ),
      });
    });
    red.blocks.push({
      block: presentPayload.block,
      blockPT: presentPayload.blockPT,
    });
    return red;
  }
}
