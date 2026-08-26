import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { Address, Transport } from "../../../common/src";
import {
  CipherContext,
  type DtlsClient,
  type DtlsServer,
  DtlsVersion,
  HashAlgorithm,
  NamedCurveAlgorithm,
  SignatureAlgorithm,
} from "../../../dtls/src";
import { DirectHandshakeCarrier } from "../../../dtls/src/carrier/direct";
import {
  createDtlsClientInternal,
  createDtlsServerInternal,
} from "../../../dtls/src/internal";
import { Candidate, Connection } from "../../../ice/src";
import { attachSpedToConnection } from "../../../ice/src/internal/sped";
import { IceSpedTransport } from "../../src/transport/sped";
import { resolvePionIceAgentBin as resolvePionIceAgentBinFromInput } from "./resolve-pion-ice-agent-bin";

const toolDir = join(__dirname, "../../../ice/tools/pion-ice-agent");
const localBin = join(toolDir, "pion-ice-agent");

function tryBuildLocalPionIceAgent(): string | undefined {
  try {
    execFileSync("go", ["build", "-o", localBin, "."], {
      cwd: toolDir,
      stdio: "pipe",
    });
    return existsSync(localBin) ? localBin : undefined;
  } catch {
    return undefined;
  }
}

function resolvePionIceAgentBin(): string | undefined {
  return resolvePionIceAgentBinFromInput({
    override: process.env.WERIFT_PION_ICE_AGENT,
    required: process.env.WERIFT_PION_ICE_AGENT_REQUIRED === "1",
    autoBuild: process.env.WERIFT_PION_ICE_AGENT_AUTO_BUILD === "1",
    localBin,
    exists: existsSync,
    tryBuildLocal: tryBuildLocalPionIceAgent,
  });
}

const bin = resolvePionIceAgentBin();
const describePion = bin ? describe : describe.skip;

type AgentLine = {
  type: string;
  ufrag?: string;
  pwd?: string;
  candidate?: string;
  data?: string;
  error?: string;
};

class PionIceAgent {
  readonly candidates: string[] = [];
  ufrag = "";
  pwd = "";
  onDatagram?: (bytes: Buffer) => void;
  private readonly child;
  private readonly gathered: Promise<void>;
  private readonly connected: Promise<void>;
  private resolveGathered!: () => void;
  private resolveConnected!: () => void;
  private rejectGathered!: (error: Error) => void;
  private rejectConnected!: (error: Error) => void;

  constructor(binary: string) {
    this.gathered = new Promise<void>((resolve, reject) => {
      this.resolveGathered = resolve;
      this.rejectGathered = reject;
    });
    this.connected = new Promise<void>((resolve, reject) => {
      this.resolveConnected = resolve;
      this.rejectConnected = reject;
    });
    this.child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.on("error", (error) => this.fail(error));
    createInterface({ input: this.child.stderr! }).on("line", () => {});
    createInterface({ input: this.child.stdout! }).on("line", (text) => {
      let msg: AgentLine;
      try {
        msg = JSON.parse(text) as AgentLine;
      } catch {
        this.fail(new Error(`pion-ice-agent: ${text}`));
        return;
      }
      if (msg.type === "error") {
        this.fail(new Error(msg.error ?? "pion-ice-agent"));
        return;
      }
      if (msg.type === "local-auth") {
        this.ufrag = msg.ufrag ?? "";
        this.pwd = msg.pwd ?? "";
        return;
      }
      if (msg.type === "candidate" && msg.candidate) {
        this.candidates.push(msg.candidate);
        return;
      }
      if (msg.type === "gathering-complete") {
        this.resolveGathered();
        return;
      }
      if (msg.type === "connected") {
        this.resolveConnected();
        return;
      }
      if (msg.type === "datagram" && msg.data) {
        this.onDatagram?.(Buffer.from(msg.data, "hex"));
      }
    });
  }

  private fail(error: Error) {
    this.rejectGathered(error);
    this.rejectConnected(error);
  }

  waitGathered() {
    return this.gathered;
  }

  waitConnected() {
    return this.connected;
  }

  send(msg: Record<string, string>) {
    this.child.stdin!.write(`${JSON.stringify(msg)}\n`);
  }

  sendDatagram(bytes: Buffer) {
    this.send({ type: "datagram", data: bytes.toString("hex") });
  }

  async close() {
    try {
      this.send({ type: "close" });
    } catch {
      // ignore
    }
    this.child.kill();
  }
}

class PionIceTransport implements Transport {
  closed = false;
  type = "pion-ice";
  readonly peerAuthenticated = true;
  onData: (data: Buffer, addr: Address) => void = () => {};

  constructor(private readonly agent: PionIceAgent) {
    agent.onDatagram = (bytes) => {
      this.onData(bytes, ["127.0.0.1", 1]);
    };
  }

  get address() {
    return { address: "127.0.0.1", port: 1, family: "IPv4" as const };
  }

  readonly send = async (data: Buffer) => {
    this.agent.sendDatagram(data);
  };

  async close() {
    this.closed = true;
  }
}

function candidateToPion(candidate: Candidate) {
  return candidate
    .toSdp()
    .replace(/ generation \d+/g, "")
    .replace(/ ufrag \S+/g, "");
}

describePion("released Pion ICE agent SPED fallback", () => {
  test("werift SPED probe → Pion Binding に DATA 無し → 同一 ClientHello で DTLS 1.3", async () => {
    const agent = new PionIceAgent(bin!);
    const ice = new Connection(true, { useIpv6: false });
    ice.stunServer = undefined;
    const handshakeDtls: Buffer[] = [];
    const spedData: Buffer[] = [];
    let client: DtlsClient | undefined;
    let server: DtlsServer | undefined;
    try {
      await agent.waitGathered();
      await ice.gatherCandidates();
      expect(agent.candidates.length).toBeGreaterThan(0);
      expect(ice.localCandidates.length).toBeGreaterThan(0);

      agent.send({
        type: "remote-auth",
        ufrag: ice.localUsername,
        pwd: ice.localPassword,
      });
      for (const candidate of ice.localCandidates) {
        agent.send({
          type: "candidate",
          candidate: candidateToPion(candidate),
        });
      }

      ice.remoteUsername = agent.ufrag;
      ice.remotePassword = agent.pwd;
      for (const candidate of agent.candidates) {
        await ice.addRemoteCandidate(Candidate.fromSdp(candidate));
      }
      await ice.addRemoteCandidate(undefined);

      for (const protocol of (ice as unknown as { protocols: any[] })
        .protocols) {
        const sendStun = protocol.sendStun.bind(protocol);
        const sendData = protocol.sendData.bind(protocol);
        protocol.sendStun = async (message: any, addr: Address) => {
          const value = message.getRawAttributeValue?.(0xc070) as
            | Buffer
            | undefined;
          if (value && value.length > 0) {
            spedData.push(Buffer.from(value));
          }
          return sendStun(message, addr);
        };
        protocol.sendData = async (data: Buffer, addr?: Address) => {
          const copy = Buffer.from(data);
          if (copy[0] === 22) {
            handshakeDtls.push(copy);
          }
          return sendData(copy, addr);
        };
      }

      const { certPem, keyPem, signatureHash } =
        await CipherContext.createSelfSignedCertificateWithKey(
          {
            signature: SignatureAlgorithm.ecdsa_3,
            hash: HashAlgorithm.sha256_4,
          },
          NamedCurveAlgorithm.secp256r1_23,
        );

      const iceTransport = new IceSpedTransport(ice);
      const carrier = new DirectHandshakeCarrier(iceTransport);
      carrier.setWireSendEnabled(false);
      carrier.setRetransmissionMode("external");
      const handle = attachSpedToConnection(ice, {
        inject: async (bytes, peer, generation) => {
          if (ice.generation !== generation) {
            return;
          }
          await carrier.inject(bytes, peer ? [peer[0], peer[1]] : undefined);
        },
        onFallbackFlight: async () => {
          carrier.setWireSendEnabled(true);
        },
        onHandshakeComplete: () => {
          carrier.setWireSendEnabled(true);
          iceTransport.markApplicationReady();
        },
        setRetransmissionMode: (mode) => carrier.setRetransmissionMode(mode),
        updateRtt: (rttMs) => carrier.updateRtt(rttMs),
        setMtu: (mtu) => carrier.setMtu(mtu),
      });
      iceTransport.setRuntime(handle.runtime);
      carrier.events.onFlightCreated = (_flightId, packets) => {
        handle.onFlightCreated(
          packets.map((packet) => Buffer.from(packet.bytes)),
        );
      };

      const pionTransport = new PionIceTransport(agent);
      server = createDtlsServerInternal({
        cert: certPem,
        key: keyPem,
        signatureHash,
        transport: pionTransport,
        protocolVersions: [DtlsVersion.V1_3],
        extendedMasterSecret: true,
        certificateRequest: true,
        peerIdentityMode: "authenticated-single-peer",
        addressValidation: "none",
      });
      client = createDtlsClientInternal({
        cert: certPem,
        key: keyPem,
        signatureHash,
        transport: iceTransport,
        protocolVersions: [DtlsVersion.V1_3],
        extendedMasterSecret: true,
        peerIdentityMode: "authenticated-single-peer",
        addressValidation: "ice-authenticated",
        handshakeCarrier: carrier,
      });

      const handshake = Promise.all([
        new Promise<void>((resolve, reject) => {
          client!.onConnect.once(() => resolve());
          client!.onError.once(reject);
        }),
        new Promise<void>((resolve, reject) => {
          server!.onConnect.once(() => resolve());
          server!.onError.once(reject);
        }),
      ]);

      // Act: ClientHello を L1 に載せ、Pion 無 DATA 応答で fallback する
      const connecting = client.connect();
      agent.send({ type: "end-of-candidates" });
      await Promise.all([ice.connect(), agent.waitConnected(), handshake]);
      await connecting;
      handle.onHandshakeComplete();

      // Assert: SPED に載った ClientHello と raw fallback が同一で DTLS 1.3 完了
      const embedded = spedData[0];
      expect(embedded).toBeDefined();
      expect(handshakeDtls.length).toBeGreaterThan(0);
      expect(handshakeDtls.some((bytes) => bytes.equals(embedded!))).toBe(true);
      expect(handle.session.peerSupport).toBe("unsupported");
    } finally {
      client?.close();
      server?.close();
      await ice.close();
      await agent.close();
    }
  }, 40_000);
});
