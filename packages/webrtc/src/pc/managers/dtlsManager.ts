import { debug } from "../../imports/common";
import type { SrtpProfile } from "../../imports/rtp";
import type { RtpRouter } from "../../media";
import { type RTCCertificate, RTCDtlsTransport } from "../../transport/dtls";
import type { RTCIceTransport } from "../../transport/ice";
import type { PeerConfig } from "../util";

const log = debug("werift:webrtc/dtlsManager");

/**
 * DTLS Manager
 * Handles DTLS (Datagram Transport Layer Security) related operations
 */
export class DtlsManager {
  private transports: RTCDtlsTransport[] = [];
  private certificate?: RTCCertificate;

  constructor() {}

  /**
   * Create a new DTLS transport
   */
  createDtlsTransport(
    config: Required<PeerConfig>,
    iceTransport: RTCIceTransport,
    router: RtpRouter,
    srtpProfiles: SrtpProfile[] = [],
  ): RTCDtlsTransport {
    // Check if we should reuse an existing transport with the same ICE transport
    const existingTransport = this.findTransportByIceTransport(iceTransport.id);
    if (existingTransport) {
      return existingTransport;
    }

    const dtlsTransport = new RTCDtlsTransport(
      config,
      iceTransport,
      router,
      this.certificate,
      srtpProfiles,
    );

    this.transports.push(dtlsTransport);
    return dtlsTransport;
  }

  /**
   * Set local certificate for all transports
   */
  async setupCertificate() {
    if (!this.certificate) {
      this.certificate = await RTCDtlsTransport.SetupCertificate();
    }

    // Update all transports with the certificate
    for (const dtlsTransport of this.transports) {
      dtlsTransport.localCertificate = this.certificate;
    }

    return this.certificate;
  }

  /**
   * Get the certificate
   */
  getCertificate() {
    return this.certificate;
  }

  /**
   * Set the certificate
   */
  setCertificate(certificate: RTCCertificate) {
    this.certificate = certificate;

    // Update all transports with the new certificate
    for (const dtlsTransport of this.transports) {
      dtlsTransport.localCertificate = certificate;
    }
  }

  /**
   * Start a DTLS transport
   */
  async startDtlsTransport(transport: RTCDtlsTransport) {
    if (transport.state === "connected") {
      log("DTLS transport already connected");
      return;
    }

    await transport.start();
  }

  /**
   * Start all DTLS transports
   */
  async startAllDtlsTransports() {
    return Promise.allSettled(
      this.transports.map((transport) => this.startDtlsTransport(transport)),
    );
  }

  /**
   * Get all DTLS transports
   */
  getAllDtlsTransports() {
    return this.transports;
  }

  /**
   * Find a DTLS transport by ID
   */
  findTransportById(id: string) {
    return this.transports.find((t) => t.id === id);
  }

  /**
   * Find a DTLS transport by its ICE transport ID
   */
  findTransportByIceTransport(iceTransportId: string) {
    return this.transports.find((t) => t.iceTransport.id === iceTransportId);
  }

  /**
   * Remove a transport from the manager
   */
  removeTransport(id: string) {
    const index = this.transports.findIndex((t) => t.id === id);
    if (index >= 0) {
      this.transports.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Set DTLS role for a transport
   */
  setDtlsRole(transport: RTCDtlsTransport, role: "client" | "server") {
    transport.role = role;
  }

  /**
   * Set remote parameters from media description
   */
  setRemoteDtlsParams(transport: RTCDtlsTransport, params: any) {
    if (!params) return;
    transport.setRemoteParams(params);
  }

  /**
   * Stop all DTLS transports
   */
  async stopAllTransports() {
    await Promise.all(this.transports.map((transport) => transport.stop()));
    this.transports = [];
  }

  /**
   * Serialize to JSON for live migration
   */
  toJSON() {
    return {
      transportIds: this.transports.map((t) => t.id),
      certificate: this.certificate,
    };
  }

  /**
   * Restore from JSON for live migration
   */
  fromJSON(json: any, transportMap: Map<string, RTCDtlsTransport>) {
    if (json.certificate) {
      this.certificate = json.certificate;
    }

    // Restore transport references using the provided map
    if (json.transportIds && Array.isArray(json.transportIds)) {
      this.transports = json.transportIds
        .map((id) => transportMap.get(id))
        .filter((t) => t !== undefined) as RTCDtlsTransport[];
    }
  }
}
