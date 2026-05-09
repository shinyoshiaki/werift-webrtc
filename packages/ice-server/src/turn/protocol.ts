import { randomBytes, randomUUID } from "crypto";

import type { Address } from "../../../common/src";

import {
  type StunServerAction,
  type StunServerDatagram,
  StunServerProtocol,
  type StunServerProtocolOptions,
  type StunTransport,
} from "../protocol";
import type { AttributePair } from "../stun/attributes";
import {
  classes,
  isComprehensionRequiredAttribute,
  isStunMessage,
  methods,
} from "../stun/const";
import { Message, parseMessage } from "../stun/message";
import { makeTurnIntegrityKey } from "./auth";
import {
  decodeChannelData,
  encodeChannelData,
  isChannelData,
  splitTurnTcpFrames,
} from "./frame";

type TurnAuthMethod =
  | typeof methods.ALLOCATE
  | typeof methods.REFRESH
  | typeof methods.CREATE_PERMISSION
  | typeof methods.CHANNEL_BIND;

export interface TurnServerClientPacket extends StunServerDatagram {
  clientId: string;
}

export interface TurnServerTcpChunk {
  clientId: string;
  data: Buffer;
  remoteAddress: Address;
  localAddress?: Address;
}

export interface TurnServerRelayPacket {
  relayId: string;
  data: Buffer;
  remoteAddress: Address;
  localAddress: Address;
}

export interface TurnServerRelayBound {
  allocationId: string;
  relayId: string;
  relayedAddress: Address;
}

export interface TurnServerRelayBindFailure {
  allocationId: string;
  errorCode?: number;
  reason?: string;
}

export interface TurnServerClientClosed {
  clientId: string;
}

export type TurnServerAction =
  | {
      type: "send-client";
      clientId: string;
      transport: StunTransport;
      remoteAddress: Address;
      data: Buffer;
    }
  | {
      type: "send-relay";
      relayId: string;
      remoteAddress: Address;
      data: Buffer;
    }
  | {
      type: "bind-relay";
      allocationId: string;
      relayId: string;
    }
  | {
      type: "close-relay";
      relayId: string;
    }
  | {
      type: "close-client";
      clientId: string;
    }
  | {
      type: "schedule-timeout";
      at: number;
    }
  | {
      type: "ignore";
      reason:
        | "binding-indication"
        | "malformed"
        | "non-request"
        | "non-stun"
        | "unknown-channel"
        | "unknown-client"
        | "unknown-relay"
        | "unsupported-indication"
        | "unsupported-method";
    };

export interface TurnServerProtocolOptions
  extends Pick<StunServerProtocolOptions, "fingerprint" | "software"> {
  realm?: string;
  allocationLifetime?: number;
  permissionLifetime?: number;
  channelLifetime?: number;
  nonceLifetime?: number;
  maxAllocations?: number;
  getPassword?: (username: string, realm: string) => string | undefined;
  now?: () => number;
}

type ClientEndpoint = {
  clientId: string;
  transport: StunTransport;
  remoteAddress: Address;
  localAddress?: Address;
};

type AuthenticatedRequestContext = TurnServerClientPacket & {
  integrityKey: Buffer;
  message: Message;
  username: string;
};

type PendingAllocate = {
  client: ClientEndpoint;
  integrityKey: Buffer;
  message: Message;
};

type TurnPermission = {
  peerAddress: Address;
  expiresAt: number;
};

type TurnChannelBinding = {
  peerAddress: Address;
  number: number;
  expiresAt: number;
};

type TurnAllocation = {
  id: string;
  relayId: string;
  username: string;
  client: ClientEndpoint;
  mappedAddress: Address;
  lifetime: number;
  expiresAt?: number;
  relayedAddress?: Address;
  pendingAllocate?: PendingAllocate;
  permissions: Map<string, TurnPermission>;
  channelsByNumber: Map<number, TurnChannelBinding>;
  channelsByPeer: Map<string, TurnChannelBinding>;
};

type NonceState = {
  value: Buffer;
  expiresAt: number;
};

const DEFAULT_ALLOCATION_LIFETIME = 600;
const DEFAULT_PERMISSION_LIFETIME = 300;
const DEFAULT_CHANNEL_LIFETIME = 600;
const DEFAULT_NONCE_LIFETIME = 3600;
const DEFAULT_MAX_ALLOCATIONS = 256;
const UDP_TRANSPORT = 17;

export class TurnServerProtocol {
  readonly realm: string;
  readonly bindingProtocol: StunServerProtocol;

  private readonly fingerprint: "never" | "if-present" | "always";
  private readonly software?: string;
  private readonly allocationLifetime: number;
  private readonly permissionLifetime: number;
  private readonly channelLifetime: number;
  private readonly nonceLifetime: number;
  private readonly maxAllocations: number;
  private readonly getPassword: (
    username: string,
    realm: string,
  ) => string | undefined;
  private readonly nowProvider?: () => number;
  private readonly allocations = new Map<string, TurnAllocation>();
  private readonly allocationIdByClientId = new Map<string, string>();
  private readonly allocationIdByRelayId = new Map<string, string>();
  private readonly nonces = new Map<string, NonceState>();
  private readonly tcpBuffers = new Map<string, Buffer>();

  constructor(options: TurnServerProtocolOptions = {}) {
    this.realm = options.realm ?? "werift-ice-server";
    this.software = options.software;
    this.fingerprint = options.fingerprint ?? "if-present";
    this.allocationLifetime =
      options.allocationLifetime ?? DEFAULT_ALLOCATION_LIFETIME;
    this.permissionLifetime =
      options.permissionLifetime ?? DEFAULT_PERMISSION_LIFETIME;
    this.channelLifetime = options.channelLifetime ?? DEFAULT_CHANNEL_LIFETIME;
    this.nonceLifetime = options.nonceLifetime ?? DEFAULT_NONCE_LIFETIME;
    this.maxAllocations = options.maxAllocations ?? DEFAULT_MAX_ALLOCATIONS;
    this.getPassword = options.getPassword ?? (() => undefined);
    this.nowProvider = options.now;
    this.bindingProtocol = new StunServerProtocol({
      software: this.software,
      fingerprint: this.fingerprint,
    });
  }

  get nextTimeoutAt() {
    return this.computeNextTimeoutAt();
  }

  handleClientDatagram(input: TurnServerClientPacket): TurnServerAction[] {
    return this.finalizeActions(this.handleClientPacket(input));
  }

  handleTcpChunk(input: TurnServerTcpChunk): TurnServerAction[] {
    const now = this.now();
    const actions = this.cleanupExpired(now);
    const buffer = Buffer.concat([
      this.tcpBuffers.get(input.clientId) ?? Buffer.alloc(0),
      input.data,
    ]);
    const { frames, malformed, rest } = splitTurnTcpFrames(buffer);
    if (malformed) {
      this.tcpBuffers.delete(input.clientId);
      actions.push({
        type: "close-client",
        clientId: input.clientId,
      });
      return this.finalizeActions(actions, now);
    }
    this.tcpBuffers.set(input.clientId, rest);

    for (const frame of frames) {
      actions.push(
        ...this.handleClientPacket({
          clientId: input.clientId,
          data: frame,
          remoteAddress: input.remoteAddress,
          localAddress: input.localAddress,
          transport: "tcp",
        }),
      );
    }

    return this.finalizeActions(actions, now);
  }

  handleRelayPacket(input: TurnServerRelayPacket): TurnServerAction[] {
    const now = this.now();
    const actions = this.cleanupExpired(now);
    const allocation = this.getRelayAllocation(input.relayId);
    if (!allocation || !allocation.relayedAddress) {
      actions.push({
        type: "ignore",
        reason: "unknown-relay",
      });
      return this.finalizeActions(actions, now);
    }

    const channel = this.getChannelBinding(
      allocation,
      input.remoteAddress,
      now,
    );
    const permission = this.getPermission(allocation, input.remoteAddress, now);
    if (!channel && !permission) {
      actions.push({
        type: "ignore",
        reason: "unknown-channel",
      });
      return this.finalizeActions(actions, now);
    }

    const data = channel
      ? encodeChannelData(channel.number, input.data)
      : new Message(methods.DATA, classes.INDICATION)
          .setAttribute("XOR-PEER-ADDRESS", input.remoteAddress)
          .setAttribute("DATA", input.data).bytes;

    actions.push(this.sendClient(allocation.client, data));
    return this.finalizeActions(actions, now);
  }

  handleRelayBound(input: TurnServerRelayBound): TurnServerAction[] {
    const now = this.now();
    const actions = this.cleanupExpired(now);
    const allocation = this.allocations.get(input.allocationId);
    if (!allocation || allocation.relayId !== input.relayId) {
      actions.push({
        type: "ignore",
        reason: "unknown-relay",
      });
      return this.finalizeActions(actions, now);
    }

    if (!allocation.pendingAllocate) {
      actions.push({
        type: "ignore",
        reason: "unknown-relay",
      });
      return this.finalizeActions(actions, now);
    }

    allocation.relayedAddress = input.relayedAddress;
    allocation.expiresAt = now + allocation.lifetime * 1000;
    const pending = allocation.pendingAllocate;
    allocation.pendingAllocate = undefined;

    const response = this.successResponse(
      pending.message,
      methods.ALLOCATE,
      [
        ["XOR-RELAYED-ADDRESS", input.relayedAddress],
        ["XOR-MAPPED-ADDRESS", allocation.mappedAddress],
        ["LIFETIME", allocation.lifetime],
      ],
      pending.integrityKey,
    );
    actions.push(this.sendClient(pending.client, response.bytes));
    return this.finalizeActions(actions, now);
  }

  handleRelayBindFailure(
    input: TurnServerRelayBindFailure,
  ): TurnServerAction[] {
    const now = this.now();
    const actions = this.cleanupExpired(now);
    const allocation = this.allocations.get(input.allocationId);
    if (!allocation?.pendingAllocate) {
      actions.push({
        type: "ignore",
        reason: "unknown-relay",
      });
      return this.finalizeActions(actions, now);
    }

    const pending = allocation.pendingAllocate;
    this.deleteAllocation(allocation);
    const response = this.errorResponse(
      pending.message,
      input.errorCode ?? 508,
      input.reason ?? "Insufficient Capacity",
      [],
      pending.integrityKey,
    );
    actions.push(this.sendClient(pending.client, response.bytes));
    return this.finalizeActions(actions, now);
  }

  handleClientClosed(input: TurnServerClientClosed): TurnServerAction[] {
    const now = this.now();
    const actions = this.cleanupExpired(now);
    this.tcpBuffers.delete(input.clientId);
    const allocation = this.getClientAllocation(input.clientId);
    if (allocation) {
      actions.push(...this.deleteAllocation(allocation));
    }
    return this.finalizeActions(actions, now);
  }

  handleTimer(now = this.now()): TurnServerAction[] {
    return this.finalizeActions(this.cleanupExpired(now), now);
  }

  private handleClientPacket(
    input: TurnServerClientPacket,
  ): TurnServerAction[] {
    const now = this.now();
    const actions = this.cleanupExpired(now);

    if (isChannelData(input.data)) {
      const channelData = decodeChannelData(input.data);
      if (!channelData) {
        actions.push({
          type: "ignore",
          reason: "malformed",
        });
        return actions;
      }

      const allocation = this.getClientAllocation(input.clientId);
      if (!allocation) {
        actions.push({
          type: "ignore",
          reason: "unknown-client",
        });
        return actions;
      }

      const binding = allocation.channelsByNumber.get(
        channelData.channelNumber,
      );
      if (!binding || binding.expiresAt <= now) {
        if (binding) {
          this.removeChannelBinding(allocation, binding);
        }
        actions.push({
          type: "ignore",
          reason: "unknown-channel",
        });
        return actions;
      }

      actions.push({
        type: "send-relay",
        relayId: allocation.relayId,
        remoteAddress: binding.peerAddress,
        data: channelData.data,
      });
      return actions;
    }

    if (!isStunMessage(input.data)) {
      actions.push({
        type: "ignore",
        reason: "non-stun",
      });
      return actions;
    }

    const message = parseMessage(input.data);
    if (!message) {
      actions.push({
        type: "ignore",
        reason: "malformed",
      });
      return actions;
    }

    if (message.messageClass === classes.INDICATION) {
      if (message.messageMethod === methods.BINDING) {
        actions.push({
          type: "ignore",
          reason: "binding-indication",
        });
        return actions;
      }
      if (message.messageMethod !== methods.SEND) {
        actions.push({
          type: "ignore",
          reason: "unsupported-indication",
        });
        return actions;
      }
      return [...actions, ...this.handleSendIndication(input, message, now)];
    }

    if (message.messageClass !== classes.REQUEST) {
      actions.push({
        type: "ignore",
        reason: "non-request",
      });
      return actions;
    }

    const unknownAttributes = [
      ...new Set(
        message.unknownAttributeTypes.filter(isComprehensionRequiredAttribute),
      ),
    ].sort((left, right) => left - right);
    if (unknownAttributes.length > 0) {
      actions.push(
        this.sendClient(
          this.clientEndpoint(input),
          this.errorResponse(message, 420, "Unknown Attribute", [
            ["UNKNOWN-ATTRIBUTES", unknownAttributes],
          ]).bytes,
        ),
      );
      return actions;
    }

    if (message.messageMethod === methods.BINDING) {
      return [...actions, ...this.handleBindingRequest(input)];
    }

    switch (message.messageMethod) {
      case methods.ALLOCATE:
        return [...actions, ...this.handleAllocateRequest(input, message, now)];
      case methods.REFRESH:
        return [...actions, ...this.handleRefreshRequest(input, message, now)];
      case methods.CREATE_PERMISSION:
        return [
          ...actions,
          ...this.handleCreatePermissionRequest(input, message, now),
        ];
      case methods.CHANNEL_BIND:
        return [
          ...actions,
          ...this.handleChannelBindRequest(input, message, now),
        ];
      default:
        actions.push(
          this.sendClient(
            this.clientEndpoint(input),
            this.errorResponse(message, 400, "Bad Request").bytes,
          ),
        );
        return actions;
    }
  }

  private handleBindingRequest(input: TurnServerClientPacket) {
    const stunActions = this.bindingProtocol.handleDatagram(input);
    return stunActions.map((action) => this.mapBindingAction(input, action));
  }

  private handleAllocateRequest(
    input: TurnServerClientPacket,
    message: Message,
    now: number,
  ): TurnServerAction[] {
    const auth = this.authenticateRequest(input, message, methods.ALLOCATE);
    if ("response" in auth) {
      return [this.sendClient(this.clientEndpoint(input), auth.response.bytes)];
    }

    const requestedTransport = message.getAttributeValue("REQUESTED-TRANSPORT");
    if (requestedTransport === undefined) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(message, 400, "Bad Request", [], auth.integrityKey)
            .bytes,
        ),
      ];
    }

    if (requestedTransport >>> 24 !== UDP_TRANSPORT) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(
            message,
            442,
            "Unsupported Transport Protocol",
            [],
            auth.integrityKey,
          ).bytes,
        ),
      ];
    }

    const requestedAddressFamily = message.getAttributeValue(
      "REQUESTED-ADDRESS-FAMILY",
    );
    if (
      requestedAddressFamily !== undefined &&
      requestedAddressFamily !== 0x01
    ) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(
            message,
            440,
            "Address Family not Supported",
            [],
            auth.integrityKey,
          ).bytes,
        ),
      ];
    }

    if (
      message.getAttributeValue("EVEN-PORT") !== undefined ||
      message.getAttributeValue("RESERVATION-TOKEN") !== undefined
    ) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(
            message,
            508,
            "Insufficient Capacity",
            [],
            auth.integrityKey,
          ).bytes,
        ),
      ];
    }

    if (this.getClientAllocation(input.clientId)) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(
            message,
            437,
            "Allocation Mismatch",
            [],
            auth.integrityKey,
          ).bytes,
        ),
      ];
    }

    if (this.allocations.size >= this.maxAllocations) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(
            message,
            486,
            "Allocation Quota Reached",
            [],
            auth.integrityKey,
          ).bytes,
        ),
      ];
    }

    const allocationId = randomUUID();
    const relayId = randomUUID();
    const allocation: TurnAllocation = {
      id: allocationId,
      relayId,
      username: auth.username,
      client: this.clientEndpoint(auth),
      mappedAddress: auth.remoteAddress,
      lifetime: this.clampLifetime(message.getAttributeValue("LIFETIME")),
      pendingAllocate: {
        client: this.clientEndpoint(auth),
        integrityKey: auth.integrityKey,
        message,
      },
      permissions: new Map(),
      channelsByNumber: new Map(),
      channelsByPeer: new Map(),
    };
    this.allocations.set(allocationId, allocation);
    this.allocationIdByClientId.set(auth.clientId, allocationId);
    this.allocationIdByRelayId.set(relayId, allocationId);

    return [
      {
        type: "bind-relay",
        allocationId,
        relayId,
      },
    ];
  }

  private handleRefreshRequest(
    input: TurnServerClientPacket,
    message: Message,
    now: number,
  ): TurnServerAction[] {
    const auth = this.authenticateRequest(input, message, methods.REFRESH);
    if ("response" in auth) {
      return [this.sendClient(this.clientEndpoint(input), auth.response.bytes)];
    }

    const allocation = this.getClientAllocation(input.clientId);
    if (!allocation || allocation.username !== auth.username) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(
            message,
            437,
            "Allocation Mismatch",
            [],
            auth.integrityKey,
          ).bytes,
        ),
      ];
    }

    const requestedLifetime = message.getAttributeValue("LIFETIME");
    if (requestedLifetime === 0) {
      const actions = this.deleteAllocation(allocation);
      const response = this.successResponse(
        message,
        methods.REFRESH,
        [["LIFETIME", 0]],
        auth.integrityKey,
      );
      return [this.sendClient(auth, response.bytes), ...actions];
    }

    allocation.lifetime = this.clampLifetime(requestedLifetime);
    allocation.expiresAt = now + allocation.lifetime * 1000;
    const lifetimeSeconds = Math.max(
      0,
      Math.floor((allocation.expiresAt - now) / 1000),
    );
    return [
      this.sendClient(
        auth,
        this.successResponse(
          message,
          methods.REFRESH,
          [["LIFETIME", lifetimeSeconds]],
          auth.integrityKey,
        ).bytes,
      ),
    ];
  }

  private handleCreatePermissionRequest(
    input: TurnServerClientPacket,
    message: Message,
    now: number,
  ): TurnServerAction[] {
    const auth = this.authenticateRequest(
      input,
      message,
      methods.CREATE_PERMISSION,
    );
    if ("response" in auth) {
      return [this.sendClient(this.clientEndpoint(input), auth.response.bytes)];
    }

    const allocation = this.getClientAllocation(input.clientId);
    if (!allocation || allocation.username !== auth.username) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(
            message,
            437,
            "Allocation Mismatch",
            [],
            auth.integrityKey,
          ).bytes,
        ),
      ];
    }

    const peerAddress = message.getAttributeValue("XOR-PEER-ADDRESS");
    if (!peerAddress) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(message, 400, "Bad Request", [], auth.integrityKey)
            .bytes,
        ),
      ];
    }

    if (!hasSameAddressFamily(input.remoteAddress, peerAddress)) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(
            message,
            443,
            "Peer Address Family Mismatch",
            [],
            auth.integrityKey,
          ).bytes,
        ),
      ];
    }

    this.setPermission(allocation, peerAddress, now);
    return [
      this.sendClient(
        auth,
        this.successResponse(
          message,
          methods.CREATE_PERMISSION,
          [],
          auth.integrityKey,
        ).bytes,
      ),
    ];
  }

  private handleChannelBindRequest(
    input: TurnServerClientPacket,
    message: Message,
    now: number,
  ): TurnServerAction[] {
    const auth = this.authenticateRequest(input, message, methods.CHANNEL_BIND);
    if ("response" in auth) {
      return [this.sendClient(this.clientEndpoint(input), auth.response.bytes)];
    }

    const allocation = this.getClientAllocation(input.clientId);
    if (!allocation || allocation.username !== auth.username) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(
            message,
            437,
            "Allocation Mismatch",
            [],
            auth.integrityKey,
          ).bytes,
        ),
      ];
    }

    const channelNumber = message.getAttributeValue("CHANNEL-NUMBER");
    const peerAddress = message.getAttributeValue("XOR-PEER-ADDRESS");
    if (!channelNumber || !peerAddress) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(message, 400, "Bad Request", [], auth.integrityKey)
            .bytes,
        ),
      ];
    }

    if (channelNumber < 0x4000 || channelNumber > 0x7fff) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(message, 400, "Bad Request", [], auth.integrityKey)
            .bytes,
        ),
      ];
    }

    if (!hasSameAddressFamily(input.remoteAddress, peerAddress)) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(
            message,
            443,
            "Peer Address Family Mismatch",
            [],
            auth.integrityKey,
          ).bytes,
        ),
      ];
    }

    const peerKey = addressKey(peerAddress);
    const existingByNumber = allocation.channelsByNumber.get(channelNumber);
    if (
      existingByNumber &&
      addressKey(existingByNumber.peerAddress) !== peerKey
    ) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(message, 400, "Bad Request", [], auth.integrityKey)
            .bytes,
        ),
      ];
    }

    const existingByPeer = allocation.channelsByPeer.get(peerKey);
    if (existingByPeer && existingByPeer.number !== channelNumber) {
      return [
        this.sendClient(
          auth,
          this.errorResponse(message, 400, "Bad Request", [], auth.integrityKey)
            .bytes,
        ),
      ];
    }

    this.setPermission(allocation, peerAddress, now);
    const binding: TurnChannelBinding = {
      peerAddress,
      number: channelNumber,
      expiresAt: now + this.channelLifetime * 1000,
    };
    allocation.channelsByNumber.set(binding.number, binding);
    allocation.channelsByPeer.set(peerKey, binding);

    return [
      this.sendClient(
        auth,
        this.successResponse(
          message,
          methods.CHANNEL_BIND,
          [],
          auth.integrityKey,
        ).bytes,
      ),
    ];
  }

  private handleSendIndication(
    input: TurnServerClientPacket,
    message: Message,
    now: number,
  ): TurnServerAction[] {
    const allocation = this.getClientAllocation(input.clientId);
    if (!allocation) {
      return [
        {
          type: "ignore",
          reason: "unknown-client",
        },
      ];
    }

    const peerAddress = message.getAttributeValue("XOR-PEER-ADDRESS");
    const data = message.getAttributeValue("DATA");
    if (!peerAddress || !Buffer.isBuffer(data)) {
      return [
        {
          type: "ignore",
          reason: "malformed",
        },
      ];
    }

    if (!this.getPermission(allocation, peerAddress, now)) {
      return [
        {
          type: "ignore",
          reason: "unknown-channel",
        },
      ];
    }

    return [
      {
        type: "send-relay",
        relayId: allocation.relayId,
        remoteAddress: peerAddress,
        data,
      },
    ];
  }

  private authenticateRequest(
    input: TurnServerClientPacket,
    message: Message,
    method: TurnAuthMethod,
  ):
    | AuthenticatedRequestContext
    | {
        response: Message;
      } {
    const username = message.getAttributeValue("USERNAME");
    const realm = message.getAttributeValue("REALM");
    const nonce = message.getAttributeValue("NONCE");
    const hasIntegrity = message.getAttributeValue("MESSAGE-INTEGRITY");

    if (!username || realm !== this.realm || !nonce || !hasIntegrity) {
      return {
        response: this.unauthorizedResponse(message, 401, "Unauthorized"),
      };
    }

    const nonceState = this.nonces.get(nonce.toString("hex"));
    if (!nonceState || nonceState.expiresAt <= this.now()) {
      return {
        response: this.unauthorizedResponse(message, 438, "Stale Nonce"),
      };
    }

    const password = this.getPassword(username, this.realm);
    if (!password) {
      return {
        response: this.unauthorizedResponse(message, 401, "Unauthorized"),
      };
    }

    const integrityKey = makeTurnIntegrityKey(username, this.realm, password);
    const validated = parseMessage(input.data, integrityKey);
    if (!validated || validated.messageMethod !== method) {
      return {
        response: this.unauthorizedResponse(message, 401, "Unauthorized"),
      };
    }

    return {
      ...input,
      integrityKey,
      message: validated,
      username,
    };
  }

  private unauthorizedResponse(
    request: Message,
    errorCode: number,
    reason: string,
  ) {
    return this.errorResponse(request, errorCode, reason, [
      ["REALM", this.realm],
      ["NONCE", this.issueNonce()],
    ]);
  }

  private successResponse(
    request: Message,
    method: methods,
    attributes: AttributePair[] = [],
    integrityKey?: Buffer,
  ) {
    const response = new Message(
      method,
      classes.RESPONSE,
      request.transactionId,
    );
    this.addResponseAttributes(response, request, attributes, integrityKey);
    return response;
  }

  private errorResponse(
    request: Message,
    errorCode: number,
    reason: string,
    attributes: AttributePair[] = [],
    integrityKey?: Buffer,
  ) {
    const response = new Message(
      request.messageMethod,
      classes.ERROR,
      request.transactionId,
    );
    response.setAttribute("ERROR-CODE", [errorCode, reason]);
    this.addResponseAttributes(response, request, attributes, integrityKey);
    return response;
  }

  private addResponseAttributes(
    response: Message,
    request: Message,
    attributes: AttributePair[],
    integrityKey?: Buffer,
  ) {
    for (const [key, value] of attributes) {
      response.setAttribute(key, value);
    }

    if (this.software) {
      response.setAttribute("SOFTWARE", this.software);
    }

    if (integrityKey) {
      response.addMessageIntegrity(integrityKey);
    }

    if (this.shouldAddFingerprint(request)) {
      response.addFingerprint();
    }
  }

  private shouldAddFingerprint(request: Message) {
    switch (this.fingerprint) {
      case "always":
        return true;
      case "if-present":
        return request.getAttributeValue("FINGERPRINT") !== undefined;
      default:
        return false;
    }
  }

  private issueNonce() {
    const value = randomBytes(16);
    this.nonces.set(value.toString("hex"), {
      value,
      expiresAt: this.now() + this.nonceLifetime * 1000,
    });
    return value;
  }

  private sendClient(client: ClientEndpoint, data: Buffer): TurnServerAction {
    return {
      type: "send-client",
      clientId: client.clientId,
      transport: client.transport,
      remoteAddress: client.remoteAddress,
      data,
    };
  }

  private mapBindingAction(
    input: TurnServerClientPacket,
    action: StunServerAction,
  ): TurnServerAction {
    if (action.type === "send") {
      return this.sendClient(this.clientEndpoint(input), action.data);
    }

    return action;
  }

  private clientEndpoint(input: TurnServerClientPacket): ClientEndpoint {
    return {
      clientId: input.clientId,
      transport: input.transport,
      remoteAddress: input.remoteAddress,
      localAddress: input.localAddress,
    };
  }

  private getClientAllocation(clientId: string) {
    const allocationId = this.allocationIdByClientId.get(clientId);
    return allocationId ? this.allocations.get(allocationId) : undefined;
  }

  private getRelayAllocation(relayId: string) {
    const allocationId = this.allocationIdByRelayId.get(relayId);
    return allocationId ? this.allocations.get(allocationId) : undefined;
  }

  private setPermission(
    allocation: TurnAllocation,
    peerAddress: Address,
    now: number,
  ) {
    allocation.permissions.set(permissionKey(peerAddress), {
      peerAddress,
      expiresAt: now + this.permissionLifetime * 1000,
    });
  }

  private getPermission(
    allocation: TurnAllocation,
    peerAddress: Address,
    now: number,
  ) {
    const key = permissionKey(peerAddress);
    const permission = allocation.permissions.get(key);
    if (!permission) {
      return undefined;
    }
    if (permission.expiresAt <= now) {
      allocation.permissions.delete(key);
      return undefined;
    }
    return permission;
  }

  private getChannelBinding(
    allocation: TurnAllocation,
    peerAddress: Address,
    now: number,
  ) {
    const key = addressKey(peerAddress);
    const binding = allocation.channelsByPeer.get(key);
    if (!binding) {
      return undefined;
    }
    if (binding.expiresAt <= now) {
      this.removeChannelBinding(allocation, binding);
      return undefined;
    }
    return binding;
  }

  private removeChannelBinding(
    allocation: TurnAllocation,
    binding: TurnChannelBinding,
  ) {
    allocation.channelsByNumber.delete(binding.number);
    allocation.channelsByPeer.delete(addressKey(binding.peerAddress));
  }

  private deleteAllocation(allocation: TurnAllocation): TurnServerAction[] {
    this.allocations.delete(allocation.id);
    this.allocationIdByClientId.delete(allocation.client.clientId);
    this.allocationIdByRelayId.delete(allocation.relayId);
    return [
      {
        type: "close-relay",
        relayId: allocation.relayId,
      },
    ];
  }

  private cleanupExpired(now: number) {
    const actions: TurnServerAction[] = [];

    for (const [key, nonce] of [...this.nonces]) {
      if (nonce.expiresAt <= now) {
        this.nonces.delete(key);
      }
    }

    for (const allocation of [...this.allocations.values()]) {
      if (allocation.expiresAt && allocation.expiresAt <= now) {
        actions.push(...this.deleteAllocation(allocation));
        continue;
      }

      for (const [permissionKey, permission] of [...allocation.permissions]) {
        if (permission.expiresAt <= now) {
          allocation.permissions.delete(permissionKey);
        }
      }

      for (const binding of [...allocation.channelsByNumber.values()]) {
        if (binding.expiresAt <= now) {
          this.removeChannelBinding(allocation, binding);
        }
      }
    }

    return actions;
  }

  private computeNextTimeoutAt() {
    let next: number | undefined;

    for (const nonce of this.nonces.values()) {
      next =
        next === undefined ? nonce.expiresAt : Math.min(next, nonce.expiresAt);
    }

    for (const allocation of this.allocations.values()) {
      if (allocation.expiresAt !== undefined) {
        next =
          next === undefined
            ? allocation.expiresAt
            : Math.min(next, allocation.expiresAt);
      }
      for (const permission of allocation.permissions.values()) {
        next =
          next === undefined
            ? permission.expiresAt
            : Math.min(next, permission.expiresAt);
      }
      for (const binding of allocation.channelsByNumber.values()) {
        next =
          next === undefined
            ? binding.expiresAt
            : Math.min(next, binding.expiresAt);
      }
    }

    return next;
  }

  private finalizeActions(actions: TurnServerAction[], now = this.now()) {
    const nextTimeoutAt = this.computeNextTimeoutAt();
    if (nextTimeoutAt !== undefined) {
      actions.push({
        type: "schedule-timeout",
        at: Math.max(now, nextTimeoutAt),
      });
    }
    return actions;
  }

  private clampLifetime(requestedLifetime?: number) {
    if (!requestedLifetime || requestedLifetime <= 0) {
      return this.allocationLifetime;
    }
    return Math.min(requestedLifetime, this.allocationLifetime);
  }

  private now() {
    return this.nowProvider?.() ?? Date.now();
  }
}

function addressKey(address: Address) {
  return `${address[0]}:${address[1]}`;
}

function permissionKey(address: Address) {
  return address[0];
}

function hasSameAddressFamily(left: Address, right: Address) {
  return isIpv6Address(left[0]) === isIpv6Address(right[0]);
}

function isIpv6Address(address: string) {
  return address.includes(":");
}
