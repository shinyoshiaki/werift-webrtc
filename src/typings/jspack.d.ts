declare module "jspack/jspack" {
  export function Pack(s: string, arr: any[]): Buffer {}
  export function Unpack(s: string, buf: Buffer): any[] {}
}
