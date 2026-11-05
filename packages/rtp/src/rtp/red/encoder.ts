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

  /**
   * Serialized RED payload length if `payload` were pushed now, without
   * changing this encoder (a pacer needs the size before the packet is
   * committed).
   */
  serializedLengthWith(payload: {
    block: Buffer;
    timestamp: number;
    blockPT: number;
  }): number {
    const clone = new RedEncoder(this.distance);
    clone.cacheSize = this.cacheSize;
    clone.cache = [...this.cache];
    clone.push(payload);
    return clone.build().serialize().length;
  }

  build() {
    const red = new Red();
    const redundantPayloads = this.cache.slice(-(this.distance + 1));

    const presentPayload = redundantPayloads.pop();
    if (!presentPayload) {
      return red;
    }

    redundantPayloads.forEach((redundant) => {
      const timestampOffset = uint32Add(
        presentPayload.timestamp,
        -redundant.timestamp,
      );
      if (timestampOffset > Max14Uint) {
        return;
      }
      red.blocks.push({
        block: redundant.block,
        blockPT: redundant.blockPT,
        timestampOffset,
      });
    });
    red.blocks.push({
      block: presentPayload.block,
      blockPT: presentPayload.blockPT,
    });
    return red;
  }
}

const Max14Uint = (0x01 << 14) - 1;
