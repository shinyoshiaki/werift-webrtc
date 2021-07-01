export class BitWriter {
  value = 0;

  constructor(private bitLength: number) {}

  set(size: number, startIndex: number, value: number) {
    value &= (1 << size) - 1;
    this.value |= value << (this.bitLength - size - startIndex);

    return this;
  }
}

export function getBit(bits: number, startIndex: number, length: number = 1) {
  let bin = bits.toString(2).split("");
  bin = [...Array(8 - bin.length).fill("0"), ...bin];
  const s = bin.slice(startIndex, startIndex + length).join("");
  const v = parseInt(s, 2);
  return v;
}

export function paddingByte(bits: number) {
  const dec = bits.toString(2).split("");
  return [...[...Array(8 - dec.length)].map(() => "0"), ...dec].join("");
}
