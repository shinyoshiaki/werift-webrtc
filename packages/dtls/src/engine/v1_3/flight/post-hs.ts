import { KeyUpdate } from "../../../handshake/message/tls13/keyUpdate";
import { createEpochProtection } from "../../../record/v1_3/record";
import { Dtls13HandshakeFinished } from "./finished";

/** Post-handshake KeyUpdate + ACK gating (both roles). */
export abstract class Dtls13PostHandshake extends Dtls13HandshakeFinished {
  protected onKeyUpdate(body: Buffer) {
    const ku = KeyUpdate.deSerialize(body);
    // Peer sent KeyUpdate under their old write keys (= our current read epoch).
    // Keep the previous epoch's readKeys installed for late retransmits; do NOT
    // overwrite writeEpoch.readKeys (that would clobber independent key state).
    // If next read epoch collides with a pending local KeyUpdate write epoch,
    // merge into the existing entry so writeKeys are not wiped.
    if (this.role === "client") {
      this.serverAppTraffic = this.keySchedule.updateTrafficSecret(
        this.serverAppTraffic!,
      );
      const nextEpoch = this.nextAppEpoch(this.readEpoch);
      const ep = this.epochs.get(nextEpoch) ?? createEpochProtection(nextEpoch);
      ep.readKeys = this.keySchedule.trafficKeys(this.serverAppTraffic);
      this.installEpoch(nextEpoch, ep);
      this.readEpoch = nextEpoch;
    } else {
      this.clientAppTraffic = this.keySchedule.updateTrafficSecret(
        this.clientAppTraffic!,
      );
      const nextEpoch = this.nextAppEpoch(this.readEpoch);
      const ep = this.epochs.get(nextEpoch) ?? createEpochProtection(nextEpoch);
      ep.readKeys = this.keySchedule.trafficKeys(this.clientAppTraffic);
      this.installEpoch(nextEpoch, ep);
      this.readEpoch = nextEpoch;
    }
    this.pruneStaleEpochs();
    // Same as Finished: RX layer notes this record, then sendAck() (RFC 9147 §8).
    // Do NOT sendAck here — the current KeyUpdate is not in the ACK list yet.
    this.ackAfterCurrentRecord = true;
    // Response KeyUpdate must not stand in for ACK; send only after we ACK peer.
    if (ku.requestUpdate) {
      this.keyUpdateResponseAfterAck = true;
    }
  }

  /** Next application epoch after KeyUpdate (skip reserved epoch 1). */
  protected nextAppEpoch(current: number): number {
    let n = current + 1;
    if (n === 1) n = 2;
    return n;
  }

  /** RFC 9147 post-handshake KeyUpdate (public). */
  async keyUpdate(requestUpdate = false): Promise<void> {
    if (!this.connected) throw new Error("not connected");
    if (this.pendingKeyUpdateWrite) {
      throw new Error("KeyUpdate already in progress; wait for peer ACK");
    }
    // RFC 9147 §8: send KeyUpdate under *current* write keys; do not send with
    // the new keys until this KeyUpdate flight is ACK'd.
    const sendEpoch = this.writeEpoch;
    const ku = new KeyUpdate(requestUpdate);
    this.messageSeq += 1;
    ku.messageSeq = this.messageSeq;
    const frag = ku.toFragment();
    frag.message_seq = ku.messageSeq;
    await this.sendHandshakeFlight([frag], sendEpoch, true);

    const currentTraffic =
      this.role === "client" ? this.clientAppTraffic! : this.serverAppTraffic!;
    const nextTrafficSecret =
      this.keySchedule.updateTrafficSecret(currentTraffic);
    const nextEpoch = this.nextAppEpoch(this.writeEpoch);
    // Install write keys only on the pending epoch. Do NOT copy old read keys
    // onto this write epoch — that mixes key directions across epochs and can
    // decrypt peer records under the wrong epoch during KeyUpdate races.
    // Read keys stay on readEpoch (or are installed by onKeyUpdate when the
    // peer advances their write).
    const ep = this.epochs.get(nextEpoch) ?? createEpochProtection(nextEpoch);
    ep.writeKeys = this.keySchedule.trafficKeys(nextTrafficSecret);
    // Preserve any readKeys already installed by a concurrent peer KeyUpdate
    // for the same epoch number; never invent them from the previous epoch.
    this.installEpoch(nextEpoch, ep);
    this.pendingKeyUpdateWrite = {
      nextWriteEpoch: nextEpoch,
      nextTrafficSecret,
    };
    // writeEpoch intentionally unchanged — app data still uses old keys
  }
}
