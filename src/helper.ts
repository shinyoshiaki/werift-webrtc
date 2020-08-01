import Event from "rx.mini";

export function enumerate<T>(arr: T[]): [number, T][] {
  return arr.map((v, i) => [i, v]);
}

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export type Unpacked<T> = T extends { [K in keyof T]: infer U } ? U : never;

export function createEventsFromList(list: any) {
  return list.reduce((acc, cur) => {
    acc[cur] = new Event();
    return acc;
  }, {} as any);
}

export function divide(from: string, split: string): [string, string] {
  const arr = from.split(split);
  return [arr[0], arr.slice(1).join(split)];
}
