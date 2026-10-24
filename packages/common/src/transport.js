var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? (o, m, k, k2) => {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = { enumerable: true, get: () => m[k] };
        }
        Object.defineProperty(o, k2, desc);
      }
    : (o, m, k, k2) => {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? (o, v) => {
        Object.defineProperty(o, "default", { enumerable: true, value: v });
      }
    : (o, v) => {
        o["default"] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  (() => {
    var ownKeys = (o) => {
      ownKeys =
        Object.getOwnPropertyNames ||
        ((o) => {
          var ar = [];
          for (var k in o) if (Object.hasOwn(o, k)) ar[ar.length] = k;
          return ar;
        });
      return ownKeys(o);
    };
    return (mod) => {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null)
        for (var k = ownKeys(mod), i = 0; i < k.length; i++)
          if (k[i] !== "default") __createBinding(result, mod, k[i]);
      __setModuleDefault(result, mod);
      return result;
    };
  })();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TlsTransport = exports.TcpTransport = exports.UdpTransport = void 0;
const dgram_1 = require("dgram");
const net = __importStar(require("node:net"));
const tls = __importStar(require("node:tls"));
const node_net_1 = require("node:net");
const log_1 = require("./log");
const network_1 = require("./network");
const log = (0, log_1.debug)("werift-ice:packages/ice/src/transport.ts");
const DEFAULT_CONNECT_TIMEOUT_MS = 8000;
class UdpTransport {
  constructor(socketType, options = {}) {
    Object.defineProperty(this, "socketType", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: socketType,
    });
    Object.defineProperty(this, "options", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: options,
    });
    Object.defineProperty(this, "type", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: "udp",
    });
    Object.defineProperty(this, "socket", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "rinfo", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "onData", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: () => {},
    });
    Object.defineProperty(this, "closed", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: false,
    });
    Object.defineProperty(this, "send", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: async (data, addr) => {
        if (addr && !net.isIP(addr[0])) {
          // if address is not resolved, need to use send callback to handle dns failure.
          return new Promise((r, f) => {
            this.socket.send(data, addr[1], addr[0], (error) => {
              if (error) {
                log("send error", addr, data);
                f(error);
              } else {
                r();
              }
            });
          });
        } else {
          addr = addr ?? [this.rinfo?.address, this.rinfo?.port];
          // a preestablished remote address does not need a callback to verify dns.
          // this is faster because event loop is not used per packet.
          this.socket.send(data, addr[1], addr[0]);
        }
      },
    });
    Object.defineProperty(this, "close", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: () =>
        new Promise((r) => {
          this.closed = true;
          this.socket.once("close", r);
          try {
            this.socket.close();
          } catch (error) {
            r();
          }
        }),
    });
    this.socket = (0, dgram_1.createSocket)(socketType);
    this.socket.on("message", (data, info) => {
      if ((0, network_1.normalizeFamilyNodeV18)(info.family) === 6) {
        [info.address] = info.address.split("%"); // example fe80::1d3a:8751:4ffd:eb80%wlp82s0
      }
      this.rinfo = info;
      try {
        this.onData(data, [info.address, info.port]);
      } catch (error) {
        log("onData error", error);
      }
    });
  }
  static async init(type, options = {}) {
    const transport = new UdpTransport(type, options);
    await transport.init();
    return transport;
  }
  async init() {
    const address = (0, network_1.interfaceAddress)(
      this.socketType,
      this.options.interfaceAddresses,
    );
    if (this.options.port) {
      this.socket.bind({ port: this.options.port, address });
    } else if (this.options.portRange) {
      const port = await (0, network_1.findPort)(
        this.options.portRange[0],
        this.options.portRange[1],
        this.socketType,
        this.options.interfaceAddresses,
      );
      this.socket.bind({ port, address });
    } else {
      this.socket.bind({ address });
    }
    await new Promise((r) => this.socket.once("listening", r));
  }
  get address() {
    return this.socket.address();
  }
  /** IP family of the bound socket: 4 for udp4, 6 for udp6. */
  get addressFamily() {
    return this.socketType === "udp6" ? 6 : 4;
  }
  get host() {
    return this.socket.address().address;
  }
  get port() {
    return this.socket.address().port;
  }
}
exports.UdpTransport = UdpTransport;
class TcpTransport {
  constructor(addr, options = {}) {
    Object.defineProperty(this, "type", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: "tcp",
    });
    Object.defineProperty(this, "stream", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "send", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: async (data, addr) => {
        await this.stream.send(data, addr);
      },
    });
    Object.defineProperty(this, "close", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: async () => {
        await this.stream.close();
      },
    });
    this.stream = new StreamTransport(
      "tcp",
      () => (0, node_net_1.connect)({ port: addr[1], host: addr[0] }),
      undefined,
      options.connectTimeoutMs,
    );
  }
  static async init(addr, options = {}) {
    const transport = new TcpTransport(addr, options);
    try {
      await transport.init();
      return transport;
    } catch (error) {
      await transport.close();
      throw error;
    }
  }
  async init() {
    await this.stream.waitForConnect();
  }
  get address() {
    return this.stream.address;
  }
  get remoteAddress() {
    return this.stream.remoteAddress;
  }
  get closed() {
    return this.stream.closed;
  }
  get onData() {
    return this.stream.onData;
  }
  set onData(handler) {
    this.stream.onData = handler;
  }
}
exports.TcpTransport = TcpTransport;
class TlsTransport {
  constructor(addr, options = {}, streamOptions = {}) {
    Object.defineProperty(this, "type", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: "tls",
    });
    Object.defineProperty(this, "stream", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "send", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: async (data, addr) => {
        await this.stream.send(data, addr);
      },
    });
    Object.defineProperty(this, "close", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: async () => {
        await this.stream.close();
      },
    });
    this.stream = new StreamTransport(
      "tls",
      () =>
        tls.connect({
          ...options,
          host: addr[0],
          port: addr[1],
        }),
      undefined,
      streamOptions.connectTimeoutMs,
    );
  }
  static async init(addr, options = {}, streamOptions = {}) {
    const transport = new TlsTransport(addr, options, streamOptions);
    try {
      await transport.init();
      return transport;
    } catch (error) {
      await transport.close();
      throw error;
    }
  }
  async init() {
    await this.stream.waitForConnect();
  }
  get address() {
    return this.stream.address;
  }
  get remoteAddress() {
    return this.stream.remoteAddress;
  }
  get closed() {
    return this.stream.closed;
  }
  get onData() {
    return this.stream.onData;
  }
  set onData(handler) {
    this.stream.onData = handler;
  }
}
exports.TlsTransport = TlsTransport;
class StreamTransport {
  constructor(
    type,
    createClient,
    connectEvent = type === "tls" ? "secureConnect" : "connect",
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  ) {
    Object.defineProperty(this, "createClient", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: createClient,
    });
    Object.defineProperty(this, "connectEvent", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: connectEvent,
    });
    Object.defineProperty(this, "connectTimeoutMs", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: connectTimeoutMs,
    });
    Object.defineProperty(this, "type", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "connecting", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "client", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "onData", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: () => {},
    });
    Object.defineProperty(this, "closed", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: false,
    });
    Object.defineProperty(this, "rejectConnecting", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "send", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: async (data, addr) => {
        void addr;
        await this.connecting;
        await new Promise((resolve, reject) => {
          this.client.write(data, (err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });
      },
    });
    Object.defineProperty(this, "close", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: async () => {
        this.closed = true;
        this.rejectConnecting?.(new Error(`${this.type} transport closed`));
        this.client?.destroy();
      },
    });
    this.type = type;
    this.connect();
  }
  connect() {
    if (this.closed) {
      return;
    }
    if (this.client) {
      this.client.destroy();
    }
    const client = this.createClient();
    this.client = client;
    this.connecting = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.off(this.connectEvent, onConnect);
        client.off("error", onConnectError);
        this.rejectConnecting = undefined;
        error ? reject(error) : resolve();
      };
      const onConnect = () => {
        settle();
      };
      const onConnectError = (error) => {
        this.closed = true;
        settle(error);
        client.destroy();
      };
      const timer = setTimeout(() => {
        this.closed = true;
        settle(
          new Error(
            `${this.type} connect timed out after ${this.connectTimeoutMs}ms`,
          ),
        );
        client.destroy();
      }, this.connectTimeoutMs);
      this.rejectConnecting = (error) => settle(error);
      client.once(this.connectEvent, onConnect);
      client.once("error", onConnectError);
    });
    client.on("data", (data) => {
      this.onData(data, this.remoteAddress);
    });
    client.on("error", (error) => {
      log(`${this.type} transport error`, error);
    });
  }
  async waitForConnect() {
    await this.connecting;
  }
  get address() {
    return {};
  }
  /** The peer the stream is connected to, once connected. */
  get remoteAddress() {
    const { remoteAddress, remotePort } = this.client;
    if (!remoteAddress || !remotePort) {
      return undefined;
    }
    return [stripZoneId(remoteAddress), remotePort];
  }
}
/** Strip an IPv6 zone identifier, e.g. fe80::1%eth0 -> fe80::1. */
function stripZoneId(address) {
  return address.split("%")[0];
}
//# sourceMappingURL=transport.js.map
