import { getBit, paddingByte } from "../utils";

export const isKeyframe = (buf: Buffer) => {
  let index = 0;

  const x = getBit(buf[index], 0);
  const n = getBit(buf[index], 2);
  const s = getBit(buf[index], 3);
  const pid = getBit(buf[index], 5, 3);

  index++;

  if (x === 1) {
    const i = getBit(buf[index], 0);
    const l = getBit(buf[index], 1);
    const t = getBit(buf[index], 2);
    const k = getBit(buf[index], 3);

    index++;

    if (i) {
      const m = getBit(buf[index], 0);

      const _7 = paddingByte(getBit(buf[index], 1, 7));
      const _8 = paddingByte(buf[index + 1]);
      const pictureId = parseInt(_7 + _8, 2);

      if (m === 0) {
        index += 2;
      } else {
        index += 2;
      }
    }
  }

  if (s === 1 && pid === 0) {
    const size = getBit(buf[index], 0, 3);
    const h = getBit(buf[index], 3);
    const ver = getBit(buf[index], 4, 3);
    const p = getBit(buf[index], 7);

    const keyframe = p === 0;

    return keyframe;
  }

  return false;
};
