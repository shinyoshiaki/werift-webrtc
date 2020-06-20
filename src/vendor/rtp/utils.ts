export function assignClassProperties(ctx: any, props: any) {
  Object.keys(props).forEach((key: string) => {
    ctx[key] = props[key];
  });
}
