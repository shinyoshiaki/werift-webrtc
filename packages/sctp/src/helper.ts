import Event from "rx.mini";

export function enumerate<T>(arr: T[]): [number, T][] {
  return arr.map((v, i) => [i, v]);
}

export type Unpacked<T> = T extends { [K in keyof T]: infer U } ? U : never;

export function createEventsFromList<T extends any>(list: readonly T[]) {
  return list.reduce((acc: any, cur: T) => {
    acc[cur] = new Event();
    return acc;
  }, {});
}
