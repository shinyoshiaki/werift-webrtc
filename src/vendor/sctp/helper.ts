import Event from "rx.mini";

export function enumerate<T>(arr: T[]): [number, T][] {
  return arr.map((v, i) => [i, v]);
}

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export function assignClassProperties(ctx: any, props: any) {
  Object.keys(props).forEach((key: string) => {
    ctx[key] = props[key];
  });
}

export type Unpacked<T> = T extends { [K in keyof T]: infer U } ? U : never;

export function createEventsFromList(list: any) {
  return list.reduce((acc, cur) => {
    acc[cur] = new Event();
    return acc;
  }, {} as any);
}
