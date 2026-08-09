import type { Extension } from "../../typings/domain";

/** Extension type supported_versions = 43 */
export const SUPPORTED_VERSIONS_TYPE = 43;

/**
 * ClientHello: versions list (length-prefixed byte list of uint16 versions).
 * ServerHello / HRR: single selected version (uint16).
 */
export class SupportedVersions {
  static type = SUPPORTED_VERSIONS_TYPE;

  constructor(
    public versions: number[],
    public selected?: number,
  ) {}

  static forClient(versions: number[]): SupportedVersions {
    return new SupportedVersions(versions);
  }

  static forServer(selected: number): SupportedVersions {
    return new SupportedVersions([], selected);
  }

  static fromData(data: Buffer, isServerHello: boolean): SupportedVersions {
    if (isServerHello) {
      // ServerHello / HRR: exactly one uint16 selected version (no trailing)
      if (data.length !== 2) {
        throw new Error(
          `supported_versions: ServerHello/HRR must be exactly 2 bytes (got ${data.length})`,
        );
      }
      return SupportedVersions.forServer(data.readUInt16BE(0));
    }
    // ClientHello: versions<2..254> as length-prefixed even list, exact length
    if (data.length < 1) {
      throw new Error("supported_versions: truncated client");
    }
    const len = data.readUInt8(0);
    if (len % 2 !== 0) {
      throw new Error("supported_versions: client versions length must be even");
    }
    // At least one version (2 bytes); empty list is invalid wire for a present extension
    if (len < 2) {
      throw new Error(
        "supported_versions: client versions list must be at least 2 bytes",
      );
    }
    if (data.length !== 1 + len) {
      throw new Error(
        `supported_versions: client list length mismatch (declared ${len}, total ${data.length})`,
      );
    }
    const versions: number[] = [];
    for (let i = 0; i < len; i += 2) {
      versions.push(data.readUInt16BE(1 + i));
    }
    return SupportedVersions.forClient(versions);
  }

  serializeClientData(): Buffer {
    const buf = Buffer.alloc(1 + this.versions.length * 2);
    buf.writeUInt8(this.versions.length * 2, 0);
    this.versions.forEach((v, i) => buf.writeUInt16BE(v, 1 + i * 2));
    return buf;
  }

  serializeServerData(): Buffer {
    if (this.selected === undefined) {
      throw new Error("supported_versions: no selected version");
    }
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(this.selected, 0);
    return buf;
  }

  get clientExtension(): Extension {
    return { type: SupportedVersions.type, data: this.serializeClientData() };
  }

  get serverExtension(): Extension {
    return { type: SupportedVersions.type, data: this.serializeServerData() };
  }
}
