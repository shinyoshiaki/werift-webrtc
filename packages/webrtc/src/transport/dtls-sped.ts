const spedEnabled = new WeakMap<object, true>();

/** PeerConfig.sped — not a public RTCDtlsTransport option. */
export function markDtlsTransportSped(transport: object): void {
  spedEnabled.set(transport, true);
}

export function isDtlsTransportSped(transport: object): boolean {
  return spedEnabled.has(transport);
}
