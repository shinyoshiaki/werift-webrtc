declare module "jspack" {
  interface Jspack {
    Pack(s: string, arr: any[]): Buffer;
    Unpack(s: string, buf: Buffer): any[];
  }
  const jspack: Jspack;
  export { jspack };
}
