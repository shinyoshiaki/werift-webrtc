declare module "jspack" {
  interface Jspack {
    Pack(s: string, arr: any[]): number[];
    Unpack(s: string, buf: Buffer): number[];
  }
  declare let jspack: Jspack;
  export { jspack };
}
