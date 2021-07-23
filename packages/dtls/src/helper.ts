export function enumerate<T>(arr: T[]): [number, T][] {
  return arr.map((v, i) => [i, v]);
}

export function divide(from: string, split: string): [string, string] {
  const arr = from.split(split);
  return [arr[0], arr.slice(1).join(split)];
}

export const dumpBuffer = (data: Buffer) =>
  "0x" +
  data
    .toString("hex")
    .replace(/(.)(.)/g, "$1$2 ")
    .split(" ")
    .filter((s) => s != undefined && s.length > 0)
    .join(",0x");

export const getObjectSummary = (obj: any) =>
  Object.entries({ ...obj }).reduce((acc: {}, [key, value]) => {
    if (typeof value === "number" || typeof value === "string") {
      acc[key] = value;
    }
    if (Buffer.isBuffer(value)) {
      acc[key] = dumpBuffer(value);
    }
    return acc;
  }, {});
