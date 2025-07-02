import { SCTP_TSN_MODULO } from "./const";

export function tsnMinusOne(a: number) {
  return (a - 1) % SCTP_TSN_MODULO;
}

export function tsnPlusOne(a: number) {
  return (a + 1) % SCTP_TSN_MODULO;
}
