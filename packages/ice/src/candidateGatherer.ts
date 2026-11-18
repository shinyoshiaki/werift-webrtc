import { isIPv4, isIPv6 } from "net";
import { Candidate, candidateFoundation, candidatePriority } from "./candidate";
import {
  classifyGatherError,
  type GatherErrorContext,
  IceCandidateErrorCode,
  type IceServerRef,
  isServerAnswer,
  pickReportedGatherError,
} from "./candidateError";
import { TransactionCancelled } from "./exceptions";
import {
  type IceOptions,
  isRelayOnlyGathering,
  type NormalizedTurnServer,
  queryServerReflexiveCandidate,
  type StunServerUrl,
} from "./iceBase";
import { type Address, debug, interfaceAddress } from "./imports/common";
import { getRouteSourceAddress } from "./internal/defaultRoute";
import { hostLocalPreferences } from "./internal/hostPreference";
import {
  type HostAddress,
  HostAddressBind,
  normalizeIp,
} from "./internal/resolveHostAddresses";
import { StunProtocol } from "./stun/protocol";
import { TcpActiveProtocol, TcpPassiveProtocol } from "./stun/tcpProtocol";
import { createStunOverTurnClient } from "./turn/protocol";
import type { Protocol } from "./types/model";

const log = debug("werift-ice : packages/ice/src/candidateGatherer.ts : log");

/** A failed STUN query / TURN allocation (see `Connection.onIceCandidateError`). */
type GatherFailure = { errorCode: number; errorText: string };

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
  turnServers: () => NormalizedTurnServer[];
  /**
   * The built-in default STUN server and the URL it is reported by, when
   * no STUN server is configured (see `DEFAULT_STUN_SERVER_URL`).
   */
  defaultStunServer: () => StunServerUrl | undefined;
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
  /** Report a failed STUN query / TURN allocation (`onIceCandidateError`). */
  emitCandidateError: (
    stale: () => boolean,
    generation: number,
    server: IceServerRef,
    failure: GatherFailure | undefined,
    local?: { address: string; port: number },
  ) => void;
  /** Report a STUN / TURN server that answered (`onIceServerReached`). */
  emitServerReached: (
    stale: () => boolean,
    generation: number,
    server: IceServerRef,
  ) => void;
};

/**
 * Candidate gathering of one agent (RFC 8445 §5.1.1): a UDP socket per host
 * address (kept across ICE restarts), TCP passive / active candidates
 * (RFC 6544), server-reflexive candidates from every STUN server (through
 * the host sockets and, in default mode, a wildcard socket per family), and
 * a relay candidate from every TURN server. Failed STUN / TURN servers are
 * reported through the host (`emitCandidateError`).
 */
export class CandidateGatherer {
  /**
   * Server-reflexive candidates each UDP socket advertised in its last
   * gathering (one per distinct mapping its STUN servers returned).
   */
  readonly reflexiveBySocket = new WeakMap<Protocol, Candidate[]>();
  /**
   * The wildcard UDP socket of each family (default mode with a STUN server).
   * It advertises no host candidate; its first server-reflexive candidate is
   * its local candidate. Kept across ICE restarts like the host sockets.
   */
  readonly wildcardProtocols = new Map<4 | 6, StunProtocol>();
  private readonly host: GatherHost;

  constructor(host: GatherHost) {
    this.host = host;
  }

  /**
   * The gathering work of one generation.
   *
   * - `primary`: what gathering waits for. The host sockets, the TURN
   *   allocations and the server-reflexive queries of the representative
   *   sockets: the wildcard socket of each family and the host socket of
   *   the default-route address (every host socket when the family has
   *   neither).
   * - `background`: the server-reflexive queries of the other host sockets,
   *   complete once `primary` has settled. Their candidates trickle after
   *   gathering returns; end-of-candidates (`localCandidatesEnd`) waits for
   *   them. A network interface whose address cannot reach the STUN server
   *   so no longer delays gathering.
   */
  candidatePromises(
    hostAddresses: HostAddress[],
    timeout = 5,
    generation = this.host.generation(),
    defaultRoutes: Promise<string[]> = Promise.resolve([]),
  ): {
    primary: Promise<unknown>[];
    background: { query: Promise<unknown>; settled: boolean }[];
  } {
    const primary: Promise<unknown>[] = [];
    // Filled while the primary work runs; complete once it has settled.
    const background: { query: Promise<unknown>; settled: boolean }[] = [];
    // Each continuation below runs after an await: a socket or allocation it
    // opened for a replaced generation (or a closed agent) is closed, and
    // nothing is added to the current one.
    const stale = () => !this.host.isGathering(generation);
    const stunServers = this.host.stunServers();
    const turnServers = this.host.turnServers();
    const { interfaceAddresses } = this.host.options();
    const gatherIceLite = this.host.iceLite();
    const gatherRelayOnly = isRelayOnlyGathering(this.host.options());
    // Local preferences over the whole host list (the sockets an ICE restart
    // keeps included), so they stay distinct across generations.
    const localPreferenceOf = defaultRoutes.then((routes) => {
      const preferences = hostLocalPreferences(hostAddresses, routes);
      return new Map(
        hostAddresses.map(({ address }, i) => [
          normalizeIp(address),
          preferences[i],
        ]),
      );
    });

    // TCP host candidates are kept per address like the UDP ones, but on
    // their own: a restart that turned useTcp on gathers them for addresses
    // whose UDP sockets were kept.
    const tcpAddresses = hostAddresses
      .map(({ address }) => address)
      .filter(
        (address) =>
          !this.host
            .protocols()
            .some(
              (protocol) =>
                protocol.localCandidate?.transport.toLowerCase() === "tcp" &&
                protocol.localIp === address,
            ),
      );
    const addresses = hostAddresses.filter(({ address }) => {
      // ice restartで同じアドレスが追加されるのを防ぐ
      // (localIp is the bound address, whose IPv6 notation may differ)
      if (
        this.host
          .protocols()
          .find(
            (protocol) =>
              protocol.localIp !== undefined &&
              normalizeIp(protocol.localIp) === normalizeIp(address),
          )
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
      : addresses.map(async ({ address, bind, bindAddress }) => {
          // # create transport
          const protocol = new StunProtocol();
          this.host.ensureProtocol(protocol);
          // An explicit interface address or an enumerated local address is
          // bound to, so packets of the socket leave from the advertised
          // address (a wildcard socket's source follows the routing table).
          const boundInterface =
            bind === HostAddressBind.explicit
              ? interfaceAddress(socketTypeOf(address), interfaceAddresses)
              : bind === HostAddressBind.enumerated
                ? bindAddress
                : undefined;
          try {
            await protocol.connectionMade(
              isIPv4(address),
              this.host.options().portRange,
              interfaceAddresses,
              bind === HostAddressBind.enumerated ? { bindAddress } : {},
            );
            const localPreference = (await localPreferenceOf).get(
              normalizeIp(address),
            );
            if (stale()) {
              await protocol.close();
              return;
            }

            // # add host candidate
            // A socket bound to an address advertises the bound address: the
            // peer sends its checks there and the socket's packets leave from
            // it. A wildcard socket advertises the gathered address (never
            // 0.0.0.0 / ::).
            const [boundHost, boundPort] = protocol.getExtraInfo();
            let candidateHost = address;
            if (boundInterface) {
              candidateHost = stripZoneId(boundHost);
              if (normalizeIp(candidateHost) !== normalizeIp(address)) {
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
              candidatePriority("host", {
                transport: "udp",
                localPreference,
              }),
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
              // No host candidate for this address: advertising it from
              // another (wildcard) socket would mislead the peer. Candidates
              // of the other addresses are gathered independently.
              log(
                "failed to bind UDP socket to host address",
                boundInterface,
                error,
              );
            } else {
              log("error protocol STUN", error);
            }
          }
        });

    if (!gatherRelayOnly) {
      primary.push(
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

      primary.push(...tcpCandidatePromises);
    }

    // The application's names of the STUN servers this gathering queries;
    // the built-in default one, in no configuration, gets a synthesized URL.
    const defaultStunServer = this.host.defaultStunServer();
    const stunServerUrls: StunServerUrl[] = [
      ...(this.host.options().stunServerUrls ?? []),
      ...(defaultStunServer ? [defaultStunServer] : []),
    ];
    const stunServerRef = (server: Address): IceServerRef => {
      const urls = [
        ...new Set(
          stunServerUrls
            .filter(
              (entry) =>
                entry?.address?.[0] === server[0] &&
                entry.address[1] === server[1],
            )
            .map((entry) => entry.url),
        ),
      ];
      return urls.length > 0
        ? { kind: "stun", address: server, urls }
        : { kind: "stun", address: server };
    };
    const stunContext: GatherErrorContext = { kind: "stun" };

    // W3C: a 701 means no host candidate reached the server. Every socket
    // path (a kept socket, a new socket) settles each STUN server once; a
    // server none of them reached (no answer, no error response) is
    // reported once, with the first such failure, when the last path
    // settled. A server's error response is reported per socket at once.
    type StunServerOutcome = {
      pending: number;
      reached: boolean;
      unreached?: {
        failure: { errorCode: number; errorText: string };
        local?: { address: string; port: number };
      };
    };
    const stunOutcomes = new Map<Address, StunServerOutcome>();
    const hostStunPathCount =
      reusedStunProtocols.filter((protocol) =>
        isIPv4(protocol.localCandidate!.host),
      ).length + localStunPromises.length;
    const defaultMode = !interfaceAddresses?.udp4 && !interfaceAddresses?.udp6;
    const wildcardFamilies = ([4, 6] as const).filter(
      (family) =>
        defaultMode &&
        (family === 4
          ? this.host.options().useIpv4
          : this.host.options().useIpv6) &&
        this.reflexiveServersOf(family).length > 0,
    );
    for (const server of stunServers) {
      const wildcardPaths = wildcardFamilies.filter((family) =>
        this.reflexiveServersOf(family).some(
          (candidate) =>
            candidate[0] === server[0] && candidate[1] === server[1],
        ),
      ).length;
      stunOutcomes.set(server, {
        pending: hostStunPathCount + wildcardPaths,
        reached: false,
      });
    }
    const settleStunServer = (
      server: Address,
      outcome: StunServerOutcome["unreached"] | "reached" | "skipped",
    ) => {
      const state = stunOutcomes.get(server);
      if (!state || state.pending === 0) return;
      state.pending--;
      if (outcome === "reached") state.reached = true;
      else if (outcome && outcome !== "skipped") {
        if (!state.unreached || (!state.unreached.local && outcome.local)) {
          state.unreached = outcome;
        }
      }
      if (state.pending === 0 && !state.reached && state.unreached) {
        this.host.emitCandidateError(
          stale,
          generation,
          stunServerRef(server),
          state.unreached.failure,
          state.unreached.local,
        );
      }
    };
    /**
     * One counted path toward `servers`: settles every one of them `query`
     * did not settle (a socket that does not query: an IPv6 socket, one
     * that failed to open, a stale generation). Called synchronously while
     * the paths are set up, so stunPaths holds every path.
     */
    const stunPaths: Promise<unknown>[] = [];
    const settlingStunServers = <T>(
      query: (settled: Set<Address>) => Promise<T>,
      servers = stunServers,
    ) => {
      const settled = new Set<Address>();
      const path = (async () => {
        try {
          return await query(settled);
        } finally {
          for (const server of servers) {
            if (!settled.has(server)) settleStunServer(server, "skipped");
          }
        }
      })();
      stunPaths.push(path.catch(() => undefined));
      return path;
    };
    /**
     * Backstop once every path ended: a server still pending (a path that
     * was counted but never settled it) is judged now, so its 701 is not
     * lost to a counting mismatch.
     */
    const judgeRemainingStunServers = () => {
      void Promise.allSettled(stunPaths).then(() => {
        for (const [server, state] of stunOutcomes) {
          if (state.pending === 0) continue;
          log("STUN server still pending after every path ended", server);
          state.pending = 1;
          settleStunServer(server, "skipped");
        }
      });
    };

    // A server-reflexive query of one socket to one STUN server, bounded by
    // the STUN gather timeout; an unanswered or failed one yields nothing.
    // The first of its failure and the timeout decides, a late result is
    // ignored; the outcome settles the server for this socket (above).
    const queryReflexive = async (
      protocol: StunProtocol,
      server: Address,
      settled?: Set<Address>,
    ) => {
      const local = protocol.localCandidate
        ? {
            address: protocol.localCandidate.host,
            port: protocol.localCandidate.port,
          }
        : undefined;
      // The first of the query's outcome and the timeout settles it.
      let settledQuery = false;
      // Assigned in the callbacks below (not narrowed by the initializer).
      let outcome = "skipped" as
        | StunServerOutcome["unreached"]
        | "reached"
        | "skipped";
      const fail = (failure: { errorCode: number; errorText: string }) => {
        if (failure.errorCode === IceCandidateErrorCode.SERVER_NOT_REACHED) {
          outcome = { failure, local };
          return;
        }
        // The server answered: it was reached, its error is reported now.
        outcome = "reached";
        this.host.emitCandidateError(
          stale,
          generation,
          stunServerRef(server),
          failure,
          local,
        );
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const candidate = await Promise.race([
        queryServerReflexiveCandidate(
          protocol,
          server,
          this.wildcardBaseOf(protocol),
        ).then(
          (candidate): Candidate | undefined => {
            if (!settledQuery) outcome = "reached";
            settledQuery = true;
            return candidate;
          },
          (error) => {
            log("query STUN server", server, error);
            if (!settledQuery) {
              settledQuery = true;
              const failure = classifyGatherError(error, stunContext);
              if (failure) fail(failure);
              // Answers without a reportable STUN error still prove reachability.
              else if (isServerAnswer(error)) outcome = "reached";
            }
            return undefined;
          },
        ),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            if (settledQuery) return;
            settledQuery = true;
            log("query STUN server timed out", server);
            fail({
              errorCode: IceCandidateErrorCode.SERVER_NOT_REACHED,
              errorText: "STUN binding request timed out",
            });
            resolve(undefined);
          }, timeout * 1000);
        }),
      ]);
      clearTimeout(timer);
      if (outcome === "reached") {
        this.host.emitServerReached(stale, generation, stunServerRef(server));
      }
      if (settled) {
        settled.add(server);
        settleStunServer(server, outcome);
      }
      return candidate;
    };
    // RFC 8445 §5.1.3: a mapping equal to one the socket already advertised
    // (same base, same transport address) is redundant.
    const sameMapping = (a: Candidate, b: Candidate) =>
      a.host === b.host && a.port === b.port;

    if (!gatherIceLite && !gatherRelayOnly && stunServers.length > 0) {
      // # wildcard sockets
      // In the default mode (no interfaceAddresses) every family with a STUN
      // server gets one more UDP socket bound to the wildcard address. It
      // advertises no host candidate; the OS picks its route, so it maps
      // even when the only way out is an interface the host sockets do not
      // cover, and it receives whatever reaches its port (a DNAT to another
      // local address, an address added after gathering).
      const wildcardReady = new Map<4 | 6, Promise<boolean>>();
      for (const family of wildcardFamilies) {
        const kept = this.wildcardProtocols.get(family);
        if (kept && this.host.protocols().includes(kept)) {
          // Kept across an ICE restart: queried again with the reused sockets.
          wildcardReady.set(family, Promise.resolve(true));
          continue;
        }
        // One still opening for a replaced generation is not reused.
        if (kept) {
          this.wildcardProtocols.delete(family);
          void kept.close().catch(() => {});
        }
        const wildcardServers = this.reflexiveServersOf(family);
        const query = settlingStunServers(
          (settled) =>
            this.gatherWildcardReflexive(
              family,
              (protocol, server) => queryReflexive(protocol, server, settled),
              sameMapping,
              stale,
            ),
          wildcardServers,
        );
        wildcardReady.set(
          family,
          query.then(({ bound }) => bound),
        );
        primary.push(query);
      }

      // Sockets kept across an ICE restart query every STUN server again.
      // The mappings they already advertised are in the new generation from
      // the start; a different fresh mapping (the NAT rebound) is added to
      // it, and the fresh mappings replace the kept ones for the next restart.
      const reflexiveOfReused = (protocol: StunProtocol) =>
        settlingStunServers(async (settled) => {
          const previous = this.reflexiveBySocket.get(protocol) ?? [];
          const advertised = [...previous];
          const fresh: Candidate[] = [];
          await Promise.all(
            this.reflexiveServersOf(protocol).map(async (server) => {
              const candidate = await queryReflexive(protocol, server, settled);
              if (!candidate || stale()) return;
              if (!fresh.some((known) => sameMapping(known, candidate))) {
                fresh.push(candidate);
              }
              if (advertised.some((known) => sameMapping(known, candidate)))
                return;
              advertised.push(candidate);
              this.host.appendLocalCandidate(candidate);
            }),
          );
          if (stale()) return;
          if (fresh.length > 0) this.reflexiveBySocket.set(protocol, fresh);
          return fresh.length > 0 ? fresh : previous;
        }, this.reflexiveServersOf(protocol)).catch((error) => {
          log("query reused STUN socket", error);
        });

      // The queries of a new socket; its path (settlingStunServers) is
      // opened before the socket is, see newHosts.
      const reflexiveOfNew = async (
        protocol: StunProtocol,
        settled: Set<Address>,
      ) => {
        const advertised: Candidate[] = [];
        await Promise.all(
          stunServers.map(async (server) => {
            const candidate = await queryReflexive(protocol, server, settled);
            if (!candidate || stale()) return;
            if (advertised.some((known) => sameMapping(known, candidate)))
              return;
            advertised.push(candidate);
            this.reflexiveBySocket.set(protocol, advertised);
            this.host.appendLocalCandidate(candidate);
          }),
        ).catch((error) => {
          log("query new STUN socket", error);
        });
        return advertised;
      };

      // A kept wildcard socket is a representative: gathering waits for it.
      const reusedWildcards = [...this.wildcardProtocols.values()].filter(
        (protocol) => this.host.protocols().includes(protocol),
      );
      primary.push(...reusedWildcards.map(reflexiveOfReused));

      // The host sockets' queries start at once. The representative ones
      // (the default-route address; every socket when the family has neither
      // a wildcard socket nor a default-route socket) are waited for, the
      // others run in the background.
      type HostQuery = { protocol: StunProtocol; query: Promise<unknown> };
      const track = (protocol: StunProtocol, query: Promise<unknown>) => {
        const entry = { protocol, query, settled: false };
        void query.finally(() => {
          entry.settled = true;
        });
        return entry;
      };
      const reusedHosts: HostQuery[] = reusedStunProtocols
        .filter((protocol) => isIPv4(protocol.localCandidate!.host))
        .map((protocol) => track(protocol, reflexiveOfReused(protocol)));
      // Every new socket is counted for every STUN server (stunOutcomes),
      // so its path opens now, before the socket does: a socket that does
      // not query (IPv6, failed to open) settles them as skipped.
      const newHosts = Promise.all(
        localStunPromises.map((protocolPromise) => {
          let resolveEntry!: (entry: HostQuery | undefined) => void;
          const entry = new Promise<HostQuery | undefined>((resolve) => {
            resolveEntry = resolve;
          });
          settlingStunServers(async (settled) => {
            const protocol = await Promise.resolve(protocolPromise).catch(
              () => undefined,
            );
            if (
              !protocol?.localCandidate ||
              !isIPv4(protocol.localCandidate.host)
            ) {
              resolveEntry(undefined);
              return;
            }
            const query = reflexiveOfNew(protocol, settled);
            resolveEntry(track(protocol, query));
            await query;
          }).catch((error) => {
            resolveEntry(undefined);
            log("query new STUN socket", error);
          });
          return entry;
        }),
      );
      judgeRemainingStunServers();
      primary.push(
        (async () => {
          const queries = [
            ...reusedHosts,
            ...(await newHosts).filter((entry) => entry !== undefined),
          ] as (HostQuery & { settled: boolean })[];
          const routes = (await defaultRoutes).map(normalizeIp);
          const defaultRouteQueries = queries.filter(({ protocol }) =>
            routes.includes(normalizeIp(protocol.localCandidate!.host)),
          );
          const representative =
            defaultRouteQueries.length > 0 || (await wildcardReady.get(4))
              ? defaultRouteQueries
              : queries;
          // Filled before this primary work settles: gatherCandidates()
          // reads it then.
          background.push(
            ...queries.filter((entry) => !representative.includes(entry)),
          );
          await Promise.allSettled(representative.map(({ query }) => query));
        })(),
      );
    }

    if (!gatherIceLite) {
      // Every TURN server gets its own allocation, made with its own
      // credential and transport; one that fails does not stop the others.
      // A TURN allocation has its own UDP socket, bound to the wildcard
      // address unless interfaceAddresses binds the family: the OS picks
      // its route as for the wildcard STUN socket.
      const turnCandidatePromises = turnServers.map((server) =>
        this.gatherRelayCandidate(
          server,
          gatherRelayOnly,
          stale,
          generation,
        ).catch((error) => {
          log("query TURN server", server.address, error);
        }),
      );
      primary.push(...turnCandidatePromises);
    }

    return { primary, background };
  }

  /**
   * Open the wildcard socket of `family` and query the STUN servers from it.
   * Its first server-reflexive candidate becomes the socket's local
   * candidate: the socket joins the agent and pairs with the remote
   * candidates (its checks leave through the NAT mapping it advertised).
   * A socket that maps nothing is closed.
   */
  private async gatherWildcardReflexive(
    family: 4 | 6,
    queryReflexive: (
      protocol: StunProtocol,
      server: Address,
    ) => Promise<Candidate | undefined>,
    sameMapping: (a: Candidate, b: Candidate) => boolean,
    stale: () => boolean,
  ): Promise<{ bound: boolean }> {
    const protocol = new StunProtocol();
    try {
      // No interfaceAddresses / bindAddress: the wildcard address.
      await protocol.connectionMade(
        family === 4,
        this.host.options().portRange,
      );
    } catch (error) {
      log("failed to bind the wildcard UDP socket", family, error);
      return { bound: false };
    }
    if (stale()) {
      await protocol.close();
      return { bound: true };
    }
    this.wildcardProtocols.set(family, protocol);

    const advertised: Candidate[] = [];
    await Promise.all(
      this.reflexiveServersOf(family).map(async (server) => {
        const candidate = await queryReflexive(protocol, server);
        if (!candidate || stale() || !this.isWildcardProtocol(protocol)) return;
        if (advertised.some((known) => sameMapping(known, candidate))) {
          return;
        }
        advertised.push(candidate);
        this.reflexiveBySocket.set(protocol, advertised);
        if (!protocol.localCandidate) {
          protocol.localCandidate = candidate;
          protocol.localIp = family === 4 ? "0.0.0.0" : "::";
          this.host.ensureProtocol(protocol);
          this.host.protocols().push(protocol);
          this.host.pairLocalProtocol(protocol);
        }
        this.host.appendLocalCandidate(candidate);
      }),
    );
    if (!protocol.localCandidate) {
      if (this.wildcardProtocols.get(family) === protocol) {
        this.wildcardProtocols.delete(family);
      }
      await protocol.close();
    }
    return { bound: true };
  }

  /** Whether `protocol` is a wildcard socket (advertises no host candidate). */
  isWildcardProtocol(protocol: Protocol) {
    for (const wildcard of this.wildcardProtocols.values()) {
      if (wildcard === protocol) return true;
    }
    return false;
  }

  /**
   * Whether the wildcard socket should check `remoteCandidate`: only a path
   * no host socket covers. When the OS routes to the remote address from an
   * address a UDP host socket is bound to, that socket checks the same path
   * (through a NAT as its own server-reflexive address), while the wildcard
   * socket's packets would leave from an address it does not advertise and
   * make the peer learn a peer-reflexive candidate. Without a route the
   * socket cannot reach the address either.
   */
  async wildcardPathUncovered(remoteCandidate: Candidate) {
    const source = await getRouteSourceAddress(remoteCandidate.host);
    if (!source) return false;
    return !this.host
      .protocols()
      .some(
        (protocol) =>
          protocol instanceof StunProtocol &&
          protocol.localCandidate?.type === "host" &&
          protocol.localCandidate.transport === "udp" &&
          normalizeIp(protocol.localCandidate.host) === normalizeIp(source),
      );
  }

  /** The base of a wildcard socket's server-reflexive candidates. */
  private wildcardBaseOf(protocol: StunProtocol) {
    if (!this.isWildcardProtocol(protocol)) return undefined;
    const [host, port] = protocol.getExtraInfo();
    return {
      host: isIPv6(stripZoneId(host)) ? "::" : "0.0.0.0",
      port,
      transport: "udp",
      component: 1,
    };
  }

  /**
   * The STUN servers a socket (or the wildcard socket of a family) queries:
   * every server for IPv4 (as the IPv4 host sockets always did), only the
   * IPv6 literal servers for the IPv6 wildcard socket.
   */
  private reflexiveServersOf(target: StunProtocol | 4 | 6) {
    const family =
      typeof target === "number"
        ? target
        : this.isWildcardProtocol(target) &&
            isIPv6(stripZoneId(target.getExtraInfo()[0]))
          ? 6
          : 4;
    return family === 4
      ? this.host.stunServers()
      : this.host.stunServers().filter(([host]) => isIPv6(host));
  }

  /**
   * Allocate on one TURN server and add its relay candidate. A UDP
   * allocation that fails falls back to TCP on the same server. An
   * allocation that completes for a replaced generation (or a closed agent)
   * is released. A failed allocation (both attempts, for the fallback) is
   * reported once (onIceCandidateError) before it rejects.
   */
  private async gatherRelayCandidate(
    server: NormalizedTurnServer,
    relayOnly: boolean,
    stale: () => boolean,
    generation = this.host.generation(),
  ) {
    const { address, username, password, transport } = server;
    // Failures of the attempts at this server (UDP, then TCP fallback), and
    // whether any attempt got an answer from it (reached, even without a
    // STUN error code to report).
    const failures: ({ errorCode: number; errorText: string } | undefined)[] =
      [];
    let answered = false;
    const recordFailure = (
      error: unknown,
      attemptTransport: "udp" | "tcp" | "tls",
    ) => {
      if (isServerAnswer(error)) answered = true;
      failures.push(
        classifyGatherError(error, {
          kind: "turn",
          transport: attemptTransport,
          // Masked out of the server's reason phrase.
          secrets: [username, password],
        }),
      );
    };
    const ref: IceServerRef = {
      kind: "turn",
      address,
      transport,
      ...(server.urls ? { urls: [...server.urls] } : {}),
    };
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
    )
      .catch(async (e) => {
        recordFailure(e, transport);
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
          ).catch((fallbackError) => {
            recordFailure(fallbackError, "tcp");
            throw fallbackError;
          });
        }
        throw e;
      })
      .catch((error) => {
        // A cancelled attempt (close) is not a failure of the server.
        if (
          error instanceof TransactionCancelled ||
          this.host.closing().aborted
        ) {
          throw error;
        }
        const reported = pickReportedGatherError(failures);
        const reachedServer =
          answered ||
          (reported !== undefined &&
            reported.errorCode !== IceCandidateErrorCode.SERVER_NOT_REACHED);
        // A server that answered is never reported as 701 (an attempt that
        // was not answered does not make it unreached).
        if (
          reported &&
          (reported.errorCode !== IceCandidateErrorCode.SERVER_NOT_REACHED ||
            !reachedServer)
        ) {
          this.host.emitCandidateError(stale, generation, ref, reported);
        }
        if (reachedServer) this.host.emitServerReached(stale, generation, ref);
        throw error;
      });
    if (stale()) {
      // The allocation never joins a generation: release it (and its
      // refresh timer) instead of keeping a second one alive.
      await protocol.close();
      return;
    }
    this.host.emitServerReached(stale, generation, ref);
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
const stripZoneId = (address: string) => address.split("%")[0];
