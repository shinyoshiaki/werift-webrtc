import { Connection, serverReflexiveCandidate } from "./ice";
import { StunProtocol } from "./stun/protocol";
import { Address } from "./types/model";

export async function getGlobalIp(stunServer?: Address) {
  const connection = new Connection(true, {
    stunServer: stunServer ?? ["stun.l.google.com", 19302],
  });
  await connection.gatherCandidates();

  const protocol = new StunProtocol(connection);
  protocol.localCandidate = connection.localCandidates[0];
  await protocol.connectionMade(true);
  const candidate = await serverReflexiveCandidate(protocol, [
    "stun.l.google.com",
    19302,
  ]);

  await connection.close();
  await protocol.close();

  return candidate?.host;
}

export function normalizeFamilyNodeV18(family: string | number): 4 | 6 {
  if (family === "IPv4") return 4;
  if (family === "IPv6") return 6;

  return family as 4 | 6;
}
