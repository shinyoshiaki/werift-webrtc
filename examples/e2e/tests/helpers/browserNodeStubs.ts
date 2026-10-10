/** Browser-side stubs so Vite can import packages/common without Node dgram/net. */
export function createSocket() {
  throw new Error("Node dgram is not available in the browser");
}

export function connect() {
  throw new Error("Node net is not available in the browser");
}
