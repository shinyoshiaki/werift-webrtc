import { type Socket, createSocket } from "dgram";
import { randomPort } from "./index";

/**
 * Bind a fresh UDP socket for RTP injection.
 * Handlers are long-lived singletons shared across vitest retries, so sockets
 * must be recreated rather than re-bound after close / previous bind.
 */
export async function openUdpSource(
  previous?: Socket,
): Promise<{ udp: Socket; port: number }> {
  if (previous) {
    previous.removeAllListeners();
    try {
      previous.close();
    } catch {
      // already closed
    }
  }
  const port = await randomPort();
  const udp = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      udp.off("error", onError);
      udp.off("listening", onListening);
    };
    udp.once("error", onError);
    udp.once("listening", onListening);
    udp.bind(port);
  });
  return { udp, port };
}

export function closeUdpSource(udp?: Socket) {
  if (!udp) return;
  udp.removeAllListeners();
  try {
    udp.close();
  } catch {
    // already closed
  }
}
