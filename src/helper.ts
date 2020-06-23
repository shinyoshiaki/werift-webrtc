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
