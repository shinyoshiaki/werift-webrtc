export function appendUint8Array(
  data1: Uint8Array,
  data2: Uint8Array
): Uint8Array {
  const temp = new Uint8Array(data1.length + data2.length);
  temp.set(data1);
  temp.set(data2, data1.length);

  return temp;
}
