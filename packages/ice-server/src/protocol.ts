import type { Address } from "../../common/src";

import type { AttributePair } from "./stun/attributes";
import {
  classes,
  isComprehensionRequiredAttribute,
  isStunMessage,
  methods,
} from "./stun/const";
import { Message, parseMessage } from "./stun/message";

export type StunTransport = "udp" | "tcp" | "tls" | "dtls";

export interface StunServerDatagram {
  data: Buffer;
  remoteAddress: Address;
  localAddress?: Address;
  transport: StunTransport;
}

export type StunServerAction =
  | {
      type: "send";
      data: Buffer;
      remoteAddress: Address;
    }
  | {
      type: "ignore";
      reason:
        | "non-stun"
        | "malformed"
        | "binding-indication"
        | "non-request"
        | "unsupported-method";
    };

export interface StunRequestContext extends StunServerDatagram {
  message: Message;
}

export type StunRequestAuthResult =
  | {
      ok: true;
      attributes?: AttributePair[];
    }
  | {
      ok: false;
      errorCode: number;
      reason: string;
      attributes?: AttributePair[];
    };

export interface StunServerProtocolOptions {
  software?: string;
  fingerprint?: "never" | "if-present" | "always";
  authenticateRequest?: (context: StunRequestContext) => StunRequestAuthResult;
}

export class StunServerProtocol {
  private readonly software?: string;
  private readonly fingerprint: "never" | "if-present" | "always";
  private readonly authenticateRequest?: (
    context: StunRequestContext,
  ) => StunRequestAuthResult;

  constructor(options: StunServerProtocolOptions = {}) {
    this.software = options.software;
    this.fingerprint = options.fingerprint ?? "if-present";
    this.authenticateRequest = options.authenticateRequest;
  }

  handleDatagram(input: StunServerDatagram): StunServerAction[] {
    if (!isStunMessage(input.data)) {
      return [
        {
          type: "ignore",
          reason: "non-stun",
        },
      ];
    }

    const request = parseMessage(input.data);
    if (!request) {
      return [
        {
          type: "ignore",
          reason: "malformed",
        },
      ];
    }

    if (request.messageClass === classes.INDICATION) {
      return [
        {
          type: "ignore",
          reason: "binding-indication",
        },
      ];
    }

    if (request.messageClass !== classes.REQUEST) {
      return [
        {
          type: "ignore",
          reason: "non-request",
        },
      ];
    }

    const context: StunRequestContext = {
      ...input,
      message: request,
    };
    const unknownAttributes = [
      ...new Set(
        request.unknownAttributeTypes.filter(isComprehensionRequiredAttribute),
      ),
    ].sort((left, right) => left - right);
    if (unknownAttributes.length > 0) {
      return [
        this.sendAction(
          this.errorResponse(context, 420, "Unknown Attribute", [
            ["UNKNOWN-ATTRIBUTES", unknownAttributes],
          ]),
          input.remoteAddress,
        ),
      ];
    }

    if (request.messageMethod !== methods.BINDING) {
      return [
        this.sendAction(
          this.errorResponse(context, 400, "Bad Request"),
          input.remoteAddress,
        ),
      ];
    }

    const authResult = this.authenticateRequest?.(context);
    if (authResult?.ok === false) {
      return [
        this.sendAction(
          this.errorResponse(
            context,
            authResult.errorCode,
            authResult.reason,
            authResult.attributes,
          ),
          input.remoteAddress,
        ),
      ];
    }

    return [
      this.sendAction(
        this.successResponse(context, authResult?.attributes),
        input.remoteAddress,
      ),
    ];
  }

  private sendAction(
    message: Message,
    remoteAddress: Address,
  ): StunServerAction {
    return {
      type: "send",
      data: message.bytes,
      remoteAddress,
    };
  }

  private successResponse(
    context: StunRequestContext,
    attributes: AttributePair[] = [],
  ) {
    const response = new Message(
      methods.BINDING,
      classes.RESPONSE,
      context.message.transactionId,
    );
    response.setAttribute("XOR-MAPPED-ADDRESS", context.remoteAddress);
    this.addDefaultAttributes(response, context, attributes);
    return response;
  }

  private errorResponse(
    context: StunRequestContext,
    errorCode: number,
    reason: string,
    attributes: AttributePair[] = [],
  ) {
    const response = new Message(
      context.message.messageMethod,
      classes.ERROR,
      context.message.transactionId,
    );
    response.setAttribute("ERROR-CODE", [errorCode, reason]);
    this.addDefaultAttributes(response, context, attributes);
    return response;
  }

  private addDefaultAttributes(
    response: Message,
    context: StunRequestContext,
    attributes: AttributePair[],
  ) {
    for (const [key, value] of attributes) {
      response.setAttribute(key, value);
    }

    if (this.software) {
      response.setAttribute("SOFTWARE", this.software);
    }

    if (this.shouldAddFingerprint(context.message)) {
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
}
