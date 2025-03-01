import type { PeerConnectionContext } from "./peerConnectionContext";

export interface BaseManager {
  context: PeerConnectionContext;
  dispose(): void;
}

export interface ManagerConstructor {
  new (context: PeerConnectionContext): BaseManager;
}

export interface ManagerOptions {
  debug?: boolean;
}

// Common error type for managers
export class ManagerError extends Error {
  constructor(manager: string, message: string) {
    super(`[${manager}] ${message}`);
    this.name = "ManagerError";
  }
}
