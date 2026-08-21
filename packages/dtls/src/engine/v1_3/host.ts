/**
 * Host object for DTLS 1.3 flight / record functions (`this` parameter).
 *
 * {@link Dtls13Connection} extends {@link Dtls13ConnectionBase} (single level)
 * and assigns these methods from the flight/record modules. Functions must not
 * form another class inheritance chain.
 */
import type { FragmentedHandshake } from "../../record/message/fragment";
import type { Dtls13ConnectionBase } from "./connection-base";

export interface Dtls13HostMethods {
  sendHandshakeFlight(
    fragments: FragmentedHandshake[],
    epoch: number,
    retransmittable: boolean,
    dest?: [string, number],
  ): Promise<void>;
  rebuildPendingFlightFromRecords(): void;
  consumeSendBudget(len: number, dest?: [string, number]): boolean;
  sendWithBudget(record: Buffer, dest?: [string, number]): Promise<boolean>;
  computeRetransmitRtoMs(): number;
  scheduleRetransmit(): void;
  doRetransmit(): Promise<void>;
  maxAckRecordsForMtu(): number;
  sendAck(opts?: { allowEmpty?: boolean }): Promise<void>;
  sendEmptyAck(): Promise<void>;
  sendFatalAlert(description: number, dest?: [string, number]): Promise<void>;
  alertDescForHandshakeError(err: Error): number;
  failAuthenticatedHandshake(err: Error): Promise<void>;
  sendProtocolVersionAlert(dest?: [string, number]): Promise<void>;
  noteHandshakeRecordForAck(epoch: number, sequenceNumber: number): boolean;
  noteReplayForAck(epoch: number, sequenceNumber: number): boolean;

  handleDatagram(
    data: Buffer,
    addr?: [string, number] | { address?: string; port?: number } | string,
  ): void;
  handleDatagramAsync(
    data: Buffer,
    peerKey?: string,
    peerAddr?: [string, number],
  ): Promise<void>;
  processDatagramRecords(data: Buffer): Promise<void>;
  finishHandshakeRecordAck(
    epoch: number,
    sequenceNumber: number,
  ): Promise<void>;
  hasProtectedWriteKeys(): boolean;
  handleAck(content: Buffer, receivedEpoch: number): void;
  processHandshakeBytes(raw: Buffer, epoch: number): Promise<boolean>;
  enqueueHandshake(hs: FragmentedHandshake, epoch: number): Promise<void>;
  resolveEpochCandidates(
    low: number,
  ): import("../../record/v1_3/record").EpochProtection[];
  onPlaintextRecordAsync(rec: {
    contentType: number;
    epoch: number;
    sequenceNumber: number;
    fragment: Buffer;
  }): Promise<boolean>;
  onCiphertextRecordAsync(rec: {
    contentType: number;
    epoch: number;
    sequenceNumber: number;
    content: Buffer;
  }): Promise<boolean>;
  handleAlert(
    fragment: Buffer,
    receivedEpoch: number,
    sequenceNumber?: number,
  ): void;
  isAllowedHandshake(msgType: number, epoch: number): boolean;
  evictExpiredFragments(): void;
  reassemble(hs: FragmentedHandshake): FragmentedHandshake | null;
  buildHelloRetryRequestBody(
    group: number | undefined,
    cookie?: Buffer,
  ): Buffer;
  validateClientHelloAfterHrr(
    ch1Body: Buffer,
    ch2: import("../../handshake/message/client/hello").ClientHello,
    ch2Body: Buffer,
  ): void;

  isExpectedHandshakeType(msgType: number): boolean;
  dispatchHandshake(hs: FragmentedHandshake, epoch: number): Promise<void>;

  sendClientHello(hrrGroup?: number): Promise<void>;
  buildClientHelloExtensions(): import("../../typings/domain").Extension[];
  onClientHello(body: Buffer, messageSeq: number): Promise<void>;
  onServerHello(body: Buffer, messageSeq: number): Promise<void>;
  onEncryptedExtensions(body: Buffer): Promise<void>;
  onCertificateRequest(body: Buffer): Promise<void>;
  onCertificate(body: Buffer): Promise<void>;
  onCertificateVerify(body: Buffer): Promise<void>;
  onFinished(body: Buffer, epoch: number): Promise<void>;
  onServerFinished(body: Buffer, epoch: number): Promise<void>;
  onClientFinished(body: Buffer, epoch: number): Promise<void>;
  onKeyUpdate(body: Buffer): void;
  keyUpdate(requestUpdate?: boolean): Promise<void>;
  nextAppEpoch(current: number): number;
  sendHelloRetryRequest(
    group: number | undefined,
    withCookie: boolean,
    clientHelloBody: Buffer,
    peerKeyForAttempt?: string,
  ): Promise<void>;
  sendServerFlight(): Promise<void>;
}

export type Dtls13Host = Dtls13ConnectionBase & Dtls13HostMethods;
