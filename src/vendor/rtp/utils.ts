export function setBit(
  bits: { v: number },
  value: number,
  i: number,
  bit: number = 1
) {
  const shift = 8 - (i + bit);
  bits.v |= value << shift;
}
