export function setBit(
  bits: { ref: number },
  value: number,
  i: number,
  length: number = 1
) {
  const shift = 8 - (i + length);
  bits.ref |= value << shift;
}

export function getBit(bits: number, i: number, length: number = 1) {
  let bin = bits.toString(2).split("");
  bin = [...Array(8 - bin.length).fill("0"), ...bin];
  const s = bin.slice(i, i + length).join("");
  const v = parseInt(s, 2);
  return v;
}
