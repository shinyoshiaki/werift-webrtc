import type { Dtls13Host } from "../host";

/**
 * Finished dispatch: client verifies server Finished (then sends Flight 5);
 * server verifies client Finished.
 */
export async function onFinished(
  this: Dtls13Host,
  body: Buffer,
  epoch: number,
): Promise<void> {
  if (this.role === "client") {
    await this.onServerFinished(body, epoch);
  } else {
    await this.onClientFinished(body, epoch);
  }
}
