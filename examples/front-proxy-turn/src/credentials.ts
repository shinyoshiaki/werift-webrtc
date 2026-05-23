import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { SharedFrontProxyKv } from "./kv";

export type TurnCredentials = {
  backendId: string;
  username: string;
  password: string;
};

export class CredentialIssuer {
  constructor(
    private readonly secret: string,
    private readonly kv: SharedFrontProxyKv,
  ) {}

  issue(backendId: string): TurnCredentials {
    const random = randomBytes(12).toString("base64url");
    const unsigned = `${backendId}.${random}`;
    const mac = this.mac(unsigned);
    const username = `${unsigned}.${mac}`;
    this.kv.setUsernameBackend(username, backendId);
    return {
      backendId,
      username,
      password: this.passwordForUsername(username)!,
    };
  }

  backendIdFromUsername(username: string) {
    if (!this.isValidUsername(username)) {
      return;
    }
    return username.split(".", 1)[0];
  }

  passwordForUsername(username: string) {
    if (!this.isValidUsername(username)) {
      return;
    }
    return createHmac("sha256", this.secret)
      .update(`password:${username}`)
      .digest("base64url");
  }

  private isValidUsername(username: string) {
    const parts = username.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      return false;
    }
    const unsigned = `${parts[0]}.${parts[1]}`;
    const expected = Buffer.from(this.mac(unsigned));
    const actual = Buffer.from(parts[2]);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  private mac(unsigned: string) {
    return createHmac("sha256", this.secret)
      .update(unsigned)
      .digest("base64url")
      .slice(0, 22);
  }
}
