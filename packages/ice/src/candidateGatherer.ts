import { isIPv4 } from "net";
import { Candidate, candidateFoundation, candidatePriority } from "./candidate";
import {
  type IceOptions,
  isRelayOnlyGathering,
  serverReflexiveCandidate,
  type TurnServerOptions,
} from "./iceBase";
import { type Address, debug, interfaceAddress } from "./imports/common";
import { StunProtocol } from "./stun/protocol";
import { TcpActiveProtocol, TcpPassiveProtocol } from "./stun/tcpProtocol";
import { createStunOverTurnClient } from "./turn/protocol";
import type { Protocol } from "./types/model";

const log = debug("werift-ice : packages/ice/src/candidateGatherer.ts : log");

/** What the agent supplies to its `CandidateGatherer`. */
export type GatherHost = {
  options: () => IceOptions;
  iceLite: () => boolean;
  /** The local generation the candidates belong to (read when each is made). */
  generation: () => number;
  localUsername: () => string;
  /** The agent's sockets and TURN allocations; new ones are pushed to it. */
  protocols: () => Protocol[];
  stunServers: () => Address[];
  turnServers: () => Required<TurnServerOptions>[];
  /** `generation` is still being gathered (no restart replaced it, the agent is open). */
  isGathering: (generation: number) => boolean;
  /** Aborted by close(): a TURN allocation still running is released. */
  closing: () => AbortSignal;
  /** Listen to the socket's checks and data. */
  ensureProtocol: (protocol: Protocol) => void;
  /** Pair a socket gathered after the remote candidates arrived. */
  pairLocalProtocol: (protocol: Protocol) => void;
  /** Report a local candidate. */
  appendLocalCandidate: (candidate: Candidate) => void;
};

/**
 * Candidate gathering of one agent (RFC 8445 §5.1.1): a UDP socket per host
 * address (kept across ICE restarts), TCP passive / active candidates
 * (RFC 6544), server-reflexive candidates from every STUN server, and a relay
 * candidate from every TURN server.
 */
export class CandidateGatherer {
  /**
   * Server-reflexive candidates each UDP socket advertised in its last
   * gathering (one per distinct mapping its STUN servers returned).
   */
  private readonly reflexiveBySocket = new WeakMap<Protocol, Candidate[]>();
  private readonly host: GatherHost;

  constructor(host: GatherHost) {
    this.host = host;
  }

  /** The server-reflexive candidates `protocol` advertised in its last gathering. */
  reflexiveOf(protocol: Protocol): readonly Candidate[] {
    return this.reflexiveBySocket.get(protocol) ?? [];
  }

  /**
   * Gather the host (UDP, TCP), server-reflexive and relay candidates of
   * `addresses` for `generation`; each promise settles when its candidate
   * (or failure) is known. Candidates are reported as they are found
   * (`appendLocalCandidate`).
   */
  candidatePromises(addresses: string[], timeout: number, generation: number) {
    const candidatePromises: Promise<unknown>[] = [];
    // Each continuation below runs after an await: a socket or allocation it
    // opened for a replaced generation (or a closed agent) is closed, and
    // nothing is added to the current one.
    const stale = () => !this.host.isGathering(generation);
    const stunServers = this.host.stunServers();
    const turnServers = this.host.turnServers();
    const { interfaceAddresses } = this.host.options();
    const gatherIceLite = this.host.iceLite();
    const gatherRelayOnly = isRelayOnlyGathering(this.host.options());

    // TCP host candidates are kept per address like the UDP ones, but on
    // their own: a restart that turned useTcp on gathers them for addresses
    // whose UDP sockets were kept.
    const tcpAddresses = addresses.filter(
      (address) =>
        !this.host
          .protocols()
          .some(
            (protocol) =>
              protocol.localCandidate?.transport.toLowerCase() === "tcp" &&
              protocol.localIp === address,
          ),
    );
    addresses = addresses.filter((address) => {
      // ice restartで同じアドレスが追加されるのを防ぐ
      if (
        this.host.protocols().find((protocol) => protocol.localIp === address)
      ) {
        return false;
      }
      // A family bound to an interface address has one UDP host socket; its
      // localIp is the bound address, whose notation may differ (IPv6).
      if (
        interfaceAddress(socketTypeOf(address), interfaceAddresses) ===
          address &&
        this.host
          .protocols()
          .some(
            (protocol) =>
              protocol instanceof StunProtocol &&
              protocol.localCandidate?.type === "host" &&
              isIPv4(protocol.localCandidate.host) === isIPv4(address),
          )
      ) {
        return false;
      }
      return true;
    });
    // An ICE restart keeps its UDP sockets. They are not re-created above, but
    // their server-reflexive address is part of the new generation too, so
    // the STUN query below runs for them as well.
    const reusedStunProtocols = this.host
      .protocols()
      .filter(
        (protocol): protocol is StunProtocol =>
          protocol instanceof StunProtocol &&
          protocol.localCandidate?.type === "host" &&
          protocol.localCandidate.transport === "udp",
      );

    const localStunPromises = gatherRelayOnly
      ? []
      : addresses.map(async (address) => {
          // # create transport
          const protocol = new StunProtocol();
          this.host.ensureProtocol(protocol);
          const boundInterface = interfaceAddress(
            socketTypeOf(address),
            interfaceAddresses,
          );
          try {
            await protocol.connectionMade(
              isIPv4(address),
              this.host.options().portRange,
              interfaceAddresses,
            );
            if (stale()) {
              await protocol.close();
              return;
            }

            // # add host candidate
            // A socket bound to an interface address advertises that address:
            // the peer sends its checks there. A wildcard socket advertises
            // the gathered address (never 0.0.0.0 / ::).
            const [boundHost, boundPort] = protocol.getExtraInfo();
            let candidateHost = address;
            if (boundInterface) {
              candidateHost = stripZoneId(boundHost);
              if (candidateHost !== address) {
                log(
                  "host address differs from the bound interface address; advertise the bound one",
                  address,
                  candidateHost,
                );
              }
            }
            const candidateAddress: Address = [candidateHost, boundPort];

            protocol.localIp = candidateHost;
            this.host.protocols().push(protocol);

            log("protocol", protocol.localIp);

            protocol.localCandidate = new Candidate(
              candidateFoundation("host", "udp", candidateAddress[0]),
              1,
              "udp",
              candidatePriority("host", { transport: "udp" }),
              candidateAddress[0],
              candidateAddress[1],
              "host",
              undefined,
              undefined,
              undefined,
              this.host.generation(),
              this.host.localUsername(),
            );

            this.host.pairLocalProtocol(protocol);
            this.host.appendLocalCandidate(protocol.localCandidate);

            return protocol;
          } catch (error) {
            if (boundInterface) {
              // No host candidate for this family: advertising another
              // address than the socket's would mislead the peer.
              log(
                "failed to bind UDP socket to interface address",
                boundInterface,
                error,
              );
            } else {
              log("error protocol STUN", error);
            }
          }
        });

    if (!gatherRelayOnly) {
      candidatePromises.push(
        ...localStunPromises.map((localPromise) =>
          localPromise.then((protocol) => protocol?.localCandidate),
        ),
      );
    }

    if (!gatherRelayOnly && this.host.options().useTcp) {
      const tcpCandidatePromises = tcpAddresses.map(async (address) => {
        // Passive candidates open a listening TCP server; skip them when the
        // agent only makes outbound connections (tcpPassive === false). Active
        // candidates below still dial out, so direct TCP egress is unaffected.
        if (this.host.options().tcpPassive !== false) {
          const passiveProtocol = new TcpPassiveProtocol();
          this.host.ensureProtocol(passiveProtocol);
          await passiveProtocol.connectionMade(
            address,
            this.host.options().portRange,
          );
          if (stale()) {
            await passiveProtocol.close();
            return;
          }
          passiveProtocol.localIp = address;
          passiveProtocol.localCandidate = new Candidate(
            candidateFoundation("host", "tcp", address),
            1,
            "tcp",
            candidatePriority("host", {
              transport: "tcp",
              tcptype: "passive",
            }),
            address,
            passiveProtocol.listeningPort,
            "host",
            undefined,
            undefined,
            "passive",
            this.host.generation(),
            this.host.localUsername(),
          );
          this.host.protocols().push(passiveProtocol);
          this.host.appendLocalCandidate(passiveProtocol.localCandidate);
        }

        if (!gatherIceLite) {
          const activeProtocol = new TcpActiveProtocol();
          this.host.ensureProtocol(activeProtocol);
          await activeProtocol.connectionMade(address);
          if (stale()) {
            await activeProtocol.close();
            return;
          }
          activeProtocol.localIp = address;
          activeProtocol.localCandidate = new Candidate(
            candidateFoundation("host", "tcp", address),
            1,
            "tcp",
            candidatePriority("host", {
              transport: "tcp",
              tcptype: "active",
            }),
            address,
            9,
            "host",
            undefined,
            undefined,
            "active",
            this.host.generation(),
            this.host.localUsername(),
          );
          this.host.protocols().push(activeProtocol);
          this.host.pairLocalProtocol(activeProtocol);
          this.host.appendLocalCandidate(activeProtocol.localCandidate);
        }
      });

      candidatePromises.push(...tcpCandidatePromises);
    }

    // A server-reflexive query of one socket to one STUN server, bounded by
    // the STUN gather timeout; an unanswered one yields nothing.
    const queryReflexive = async (protocol: StunProtocol, server: Address) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const candidate = await Promise.race([
        serverReflexiveCandidate(protocol, server).catch((error) => {
          log("query STUN server", server, error);
          return undefined;
        }),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeout * 1000);
        }),
      ]);
      clearTimeout(timer);
      return candidate;
    };
    // RFC 8445 §5.1.3: a mapping equal to one the socket already advertised
    // (same base, same transport address) is redundant.
    const sameMapping = (a: Candidate, b: Candidate) =>
      a.host === b.host && a.port === b.port;

    if (!gatherIceLite && !gatherRelayOnly && stunServers.length > 0) {
      // Sockets kept across an ICE restart query every STUN server again.
      // The mappings they already advertised are in the new generation from
      // the start; a different fresh mapping (the NAT rebound) is added to
      // it, and the fresh mappings replace the kept ones for the next restart.
      const reusedReflexivePromises = reusedStunProtocols
        .filter((protocol) => isIPv4(protocol.localCandidate!.host))
        .map(async (protocol) => {
          const previous = this.reflexiveBySocket.get(protocol) ?? [];
          const advertised = [...previous];
          const fresh: Candidate[] = [];
          await Promise.all(
            stunServers.map(async (server) => {
              const candidate = await queryReflexive(protocol, server);
              if (!candidate || stale()) return;
              if (!fresh.some((known) => sameMapping(known, candidate))) {
                fresh.push(candidate);
              }
              if (advertised.some((known) => sameMapping(known, candidate))) {
                return;
              }
              advertised.push(candidate);
              this.host.appendLocalCandidate(candidate);
            }),
          );
          if (stale()) return;
          if (fresh.length > 0) this.reflexiveBySocket.set(protocol, fresh);
          return fresh.length > 0 ? fresh : previous;
        })
        .map((promise) =>
          promise.catch((error) => {
            log("query STUN server", error);
          }),
        );
      candidatePromises.push(...reusedReflexivePromises);

      // Every new IPv4 socket queries every STUN server in parallel.
      const stunCandidatePromises = localStunPromises.map(
        async (protocolPromise) => {
          const protocol = await protocolPromise;
          if (
            !protocol?.localCandidate ||
            !isIPv4(protocol.localCandidate.host)
          )
            return;
          const advertised: Candidate[] = [];
          await Promise.all(
            stunServers.map(async (server) => {
              const candidate = await queryReflexive(protocol, server);
              if (!candidate || stale()) return;
              if (advertised.some((known) => sameMapping(known, candidate))) {
                return;
              }
              advertised.push(candidate);
              this.reflexiveBySocket.set(protocol, advertised);
              this.host.appendLocalCandidate(candidate);
            }),
          ).catch((error) => {
            log("query STUN server", error);
          });
          return advertised;
        },
      );

      candidatePromises.push(...stunCandidatePromises);
    }

    if (!gatherIceLite) {
      // Every TURN server gets its own allocation, made with its own
      // credential and transport; one that fails does not stop the others.
      const turnCandidatePromises = turnServers.map((server) =>
        this.gatherRelayCandidate(server, gatherRelayOnly, stale).catch(
          (error) => {
            log("query TURN server", server.address, error);
          },
        ),
      );
      candidatePromises.push(...turnCandidatePromises);
    }

    return candidatePromises;
  }

  /**
   * Allocate on one TURN server and add its relay candidate. A UDP
   * allocation that fails falls back to TCP on the same server. An
   * allocation that completes for a replaced generation (or a closed agent)
   * is released.
   */
  private async gatherRelayCandidate(
    server: Required<TurnServerOptions>,
    relayOnly: boolean,
    stale: () => boolean,
  ) {
    const { address, username, password, transport } = server;
    const protocol = await createStunOverTurnClient(
      { address, username, password },
      {
        portRange: this.host.options().portRange,
        interfaceAddresses: this.host.options().interfaceAddresses,
        transport,
        tlsOptions: this.host.options().turnTlsOptions,
        connectTimeoutMs: (this.host.options().turnConnectTimeout ?? 8) * 1000,
        udpFamily: this.host.options().turnUdpFamily,
        signal: this.host.closing(),
      },
    ).catch(async (e) => {
      // close() cancelled the allocation: no TCP fallback.
      if (transport === "udp" && !this.host.closing().aborted) {
        return await createStunOverTurnClient(
          { address, username, password },
          {
            portRange: this.host.options().portRange,
            interfaceAddresses: this.host.options().interfaceAddresses,
            transport: "tcp",
            connectTimeoutMs:
              (this.host.options().turnConnectTimeout ?? 8) * 1000,
            signal: this.host.closing(),
          },
        );
      } else {
        throw e;
      }
    });
    if (stale()) {
      // The allocation never joins a generation: release it (and its
      // refresh timer) instead of keeping a second one alive.
      await protocol.close();
      return;
    }
    protocol.configuredTransport = transport;
    this.host.ensureProtocol(protocol);
    this.host.protocols().push(protocol);

    const candidateAddress = protocol.turn.relayedAddress;
    // The related address of a relay candidate is the address the TURN
    // server saw the agent at. A relay-only policy hides the agent's
    // addresses from the peer, so it advertises the unspecified address
    // and port 9 instead (RFC 8839 §5.1), in SDP and trickle alike.
    const relatedAddress: Address = relayOnly
      ? [isIPv4(candidateAddress[0]) ? "0.0.0.0" : "::", 9]
      : protocol.turn.mappedAddress;

    log("turn candidateAddress", candidateAddress);

    protocol.localCandidate = new Candidate(
      candidateFoundation("relay", "udp", candidateAddress[0]),
      1,
      "udp",
      candidatePriority("relay"),
      candidateAddress[0],
      candidateAddress[1],
      "relay",
      relatedAddress[0],
      relatedAddress[1],
      undefined,
      this.host.generation(),
      this.host.localUsername(),
    );
    // An allocation that completes after the remote candidates arrived
    // (early signaling, or an ICE restart that allocates afresh) pairs
    // with them; a connect() already running schedules the new pairs.
    this.host.pairLocalProtocol(protocol);
    this.host.appendLocalCandidate(protocol.localCandidate);

    return protocol.localCandidate;
  }
}

const socketTypeOf = (address: string) => (isIPv4(address) ? "udp4" : "udp6");

/** Candidates carry no IPv6 zone id (e.g. `fe80::1%eth0`). */
const stripZoneId = (address: string) => address.split("%")[0];
