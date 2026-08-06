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
      if (data.length < 2)
        throw new Error("supported_versions: truncated server");
      return SupportedVersions.forServer(data.readUInt16BE(0));
    }
    if (data.length < 1)
      throw new Error("supported_versions: truncated client");
    const len = data.readUInt8(0);
    if (data.length < 1 + len || len % 2 !== 0) {
      throw new Error("supported_versions: invalid client list");
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
