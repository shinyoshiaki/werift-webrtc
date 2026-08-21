import { Dtls13ClientFlight5 } from "./client/flight5";

/**
 * Finished dispatch: client verifies server Finished (then sends Flight 5);
 * server verifies client Finished.
 */
export abstract class Dtls13HandshakeFinished extends Dtls13ClientFlight5 {
  protected async onFinished(body: Buffer, epoch: number): Promise<void> {
    if (this.role === "client") {
      await this.onServerFinished(body, epoch);
    } else {
      await this.onClientFinished(body, epoch);
    }
  }
}
