# PeerConnection negotiation transaction

## Invariant and ownership

The last pair of descriptions that reached `stable` is **current**. Its RTP
routes, BUNDLE owner, ICE selected pair, DTLS session and SCTP association
remain usable while another negotiation is pending. Packet driven counters,
consent timers and retransmission state belong to the live transport and are
never copied into an SDP snapshot. SSRC routes and receiver SSRC-to-track
entries learned from received packets (simulcast after RID stops) are marked
as learned; rollback restores the SDP-derived baseline and keeps learned
entries whose receiver and track survive the rollback. When a description
registers the same SSRC, the entry becomes description state again and loses
the learned mark.

An offer starts a transaction. The first current pair and the identities of
its transceivers, router entries, BUNDLE transports, ICE generations, DTLS
transports and SCTP association are the **rollback baseline**. It is captured
once. A later offer or pranswer replaces only the **pending** proposal; it
does not replace the baseline. Pending resources include newly created
transceivers and transports, candidate and EOC buckets, provisional RTP
routes and new SCTP associations. A final answer is the only commit boundary
for the current pair. A pranswer can run provisional traffic without changing
the last stable pair.

An event delivered to an application is irreversible. The transaction records
the description revision, ICE ufrag and object identity that produced it.
Rollback detaches or closes the pending object, but cannot retract the event or
an application reference. A repeated description must not emit another track,
candidate, EOC or DataChannel event for the same receiver transition, ICE
generation or SCTP association and stream ID.

## Lifecycle

| Phase | Preconditions | Postconditions and failure |
| --- | --- | --- |
| begin | stable or first offer | Capture baseline once; assign transaction ID and revision. No current transport is stopped. The transaction opens when a description is applied. `createOffer` in stable only records the baseline snapshot that `setLocalDescription` of that offer adopts (so MIDs it assigned revert on rollback); an unapplied offer leaves no open transaction, and a remote offer captures its own baseline. |
| replace/update | active transaction | Retire old pending-only resources and candidate buckets. Keep baseline and emitted-event history. A byte-identical description is idempotent. |
| validate | parsed proposal | For a local offer, reject any SDP other than the last `createOffer` result with `InvalidModificationError` (W3C `setLocalDescription`; local SDP munging is not supported). The compared value is W3C `[[LastCreatedOffer]]`: only `createOffer` replaces it, so a peer that never created an offer rejects every explicit offer, including one created by another peer. The separately invalidated copy used by a parameterless `setLocalDescription` does not relax this check. Check signaling transition, unique MID, m-line order and reuse, exact MID match of every answer m-line and BUNDLE member (no prefix or suffix matching), BUNDLE membership and tag, codec/rejection (a remote answer or pranswer m-line must keep a codec under the same rule `setRemoteRTP` applies, so RTX whose `apt` codec is missing counts as no codec), ICE credentials, DTLS role/fingerprint and SCTP port before live mutation. An answer or pranswer whose `setup` would change the role of a connecting or connected DTLS association is rejected with `InvalidModificationError` (RFC 8842 section 5.5); a new association prepared for the proposal (BUNDLE split owner) and non-tag BUNDLE members are exempt. Failure leaves previous pending revision and current untouched. |
| prepare | validated proposal | Allocate any new transport and media objects under pending ownership; prepare may fail and must clean only the newly allocated objects. A local (replacement) offer stages its transports before the previous pending offer is replaced, and `createOffer` never discards the transports of an applied pending offer, so a preparation failure leaves the previous pending description, transaction and signaling state intact. |
| commit | validated final answer and successful prepare | Switch BUNDLE routing, ICE generation, DTLS parameters, SCTP binding and RTP/router, then publish the current descriptions and `stable`. No fallible validation is allowed after the switch. Start remaining asynchronous connect work and report later failures on that generation. |
| cleanup | commit or rollback finished | Stop orphan pending resources; keep only current ownership and event deduplication needed for future revisions. A transport created during the transaction is remembered until it closes or a commit decides whether it is still bound; `close()` drops every such reference and the `createOffer` snapshot. |
| rollback | active pending transaction | Stop provisional communication, discard pending candidates/EOC and resources, restore the first baseline and publish `stable`. Already delivered events remain delivered. |

`createOffer`, `createAnswer`, `setLocalDescription`, `setRemoteDescription`
and `addIceCandidate` share one operations chain (W3C). A `createOffer` called
while an earlier `setLocalDescription(offer)` is still running therefore
creates its offer only after that one is applied, and cannot turn the offer
being applied into a stale one. Parameterless `setLocalDescription` creates
its description inside its own queued operation.

The ordered operations are `begin → replace/update → validate → prepare →
commit → cleanup` or `begin → … → rollback → cleanup`. A synchronous failure
before commit leaves the previously published current and pending descriptions
and live session intact. Should applying a remote description still throw
after validation, the operation undoes its own changes before it rejects: a
remote offer rolls its transaction back to `stable` (a replacement offer has
already released the previous proposal, so it cannot be restored), and an
answer or pranswer restores the checkpoint taken when it began, keeping the
pending offer. Applying a remote description runs in two phases so this
undo never has to reach live transports: first every m-line updates the
restorable media, router and SCTP state; only after all of them succeed are
the staged ICE restart switched (final answer), remote ICE/DTLS parameters,
candidates, EOC and DTLS roles applied, and an application-stopped
transceiver's sender and receiver stopped. A failure in the first phase
therefore keeps the committed ICE generation, selected pair and DTLS/SCTP
bindings (the checkpoint also rebinds SCTP to its DTLS transport).
Candidates that `addIceCandidate` queued before any remote description are
checked against the incoming description during validation, before any
state change and before any application event (`onRemoteTransceiverAdded`,
`onTrack`) fires. The implicit rollback of a local offer yields a task after
publishing `stable`, so handlers observe that state before the remote offer
moves the connection to `have-remote-offer`. One
that the description cannot place (unknown `sdpMid`, out-of-range
`sdpMLineIndex`, unmatched ufrag, unparsable) rejects `setRemoteDescription`
before anything is committed, and leaves the queue so a retry of the same
description succeeds; the valid queued candidates are applied after the
description is published.

A trickled candidate belongs to the ICE generation of its ufrag, given either
as the `usernameFragment` property or as the `ufrag` token of the candidate
string; both forms are routed identically (current or pending generation),
and a candidate whose two values disagree is rejected with `OperationError`. The
current or pending generation is chosen by the ufrag of the m-line the
candidate targets (`sdpMid`, else `sdpMLineIndex`), not of any m-line: in a
partial BUNDLE split one m-line can keep the current ufrag while another
moves to a new one within the same pending description.

During a remote re-offer, a trickled candidate for an m-line whose ufrag is
unchanged belongs to both the pending proposal and the live ICE generation.
It is recorded in the pending SDP and, unless the live generation already
signalled end-of-candidates (RFC 8838), also in the current SDP and handed to
the live checklist exactly once. A rollback keeps it, because the generation
it belongs to stays current. The same applies to candidates and
end-of-candidates carried in the body of a same-ufrag re-offer or pranswer
that keeps the current transports: once every fallible step has passed, they
reach the live generation before any answer, without duplicates, and nothing
is added after that generation's end-of-candidates.

End-of-candidates ends an ICE generation on its transport. When it arrives for
one BUNDLE m-line, every m-line that shares the transport and ufrag (the rest
of the group) is marked complete in that SDP, so the tag and the non-tag
m-lines agree. A candidate for a transport whose generation already ended is
neither written to the current SDP nor handed to the live checklist, so after
a rollback the current SDP lists only candidates the live generation accepted. The
same alignment applies to a pending remote SDP (an end-of-candidates trickled
during a re-offer marks every m-line of that generation in it) and to any
remote description applied later that repeats an ended generation, so the
SDP committed by an answer, or kept by a rollback, matches the live transport.
Only the generation that ended counts: a pending ICE restart ufrag on the same
transport stays open. An end-of-candidates written in the SDP body of any
BUNDLE m-line, including a non-tag one, ends the shared generation the same
way as a trickled one; it is applied after every m-line's candidates so it
cannot close the transport before the tag's candidates arrive.

An answer leaves the MID of an m-line it rejects (offered with port 0, or
whose transceiver is stopping or stopped) out of its BUNDLE group, as
RFC 8843 section 7.3.3 requires. werift also writes `inactive` m-lines with
port 0; those are not rejections and stay in the group. A failed asynchronous ICE check or DTLS/SCTP handshake
is a transport failure, not a description validation failure.

## Signaling transitions

| State | Local input | Remote input |
| --- | --- | --- |
| stable | offer → have-local-offer | offer → have-remote-offer |
| have-local-offer | replacement offer → have-local-offer; rollback → stable | pranswer → have-remote-pranswer; answer → stable; offer → implicit rollback then have-remote-offer |
| have-remote-offer | pranswer → have-local-pranswer; answer → stable | replacement offer → have-remote-offer; rollback → stable |
| have-local-pranswer | replacement pranswer → have-local-pranswer; answer → stable | rollback → stable; offer → implicit rollback then have-remote-offer |
| have-remote-pranswer | rollback → stable; replacement offer → have-local-offer | replacement pranswer → have-remote-pranswer; answer → stable |
| closed | none | none |

## Mutation matrix

`C` is current, `P` pending/provisional, `K` final answer commit and `R`
rollback cleanup. M = media/transceiver/router, B = BUNDLE owner, I = ICE,
D = DTLS, S = SCTP, Cnd = candidate/EOC, E = events. A current session keeps
running through every pending row.

| Flow | M | B | I | D | S | Cnd | E |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Initial offer/answer | P objects and provisional routes; K publishes | P owner; K binds | P generation; K retains | P handshake; K retains | P association; K retains | P ufrag bucket; K retains | Remote track and gathering can fire before K |
| Local re-offer/remote answer | C routes until K; P codec/direction | C owner until K | C pair until K | C session until K | C association until K | P and C buckets by ufrag | Only real receiver transitions notify |
| Remote re-offer/local answer | C routes until K; P codec/direction | C owner until K | C pair until K | C session until K | C association until K | P and C buckets by ufrag | Remote offer track may notify |
| Offer/pranswer/final answer | P negotiated RTP may run; final K can differ | C owner retained; P routing | P checks and nomination may run | P handshake after ICE | New P association may run | P ufrag bucket | Provisional events are permanent history |
| Replacement offer/pranswer | Retire old P; retain C | Retire old P; retain C | Drop old P checks | Stop old P handshake | Close old P association | Drop old P bucket | Do not repeat identical events |
| Rollback or implicit rollback | R detaches P, restores C | R restores C owner | R stops P, preserves C pair | R preserves C session | R closes P, preserves C | R drops P bucket | Close/statechange may fire; no event retraction |
| ICE restart commit/rollback | C routes until K/R | C owner until K/R | P credentials, checklist and pair; K switches or R drops | C session and DTLS role retained; no second handshake | C association remains live during P | P ufrag distinct from C | Candidates labeled by generation |
| BUNDLE split/merge/tag change | P MID routes, K switches | P owner table; K/R selects | P transport per owner | P binding per owner | P application binding | Route by MID and owner | Notify after owner selection |
| Reject/stop/reuse m-line | C route until K; K unregisters/stops | Shared C owner persists | Shared C pair persists | Shared C session persists | Unrelated C association persists | Rejected MID receives no candidate | Track transitions only |
| SCTP parameter re-offer | C media | C owner | C pair | C session | P port/limit/MID; reject unsupported existing port change before mutation | C bucket | Existing channels remain live |
| Validation failure | C and preceding P unchanged | Same | Same | Same | Same | Same | No new events |
| Duplicate SDP/candidate/EOC | No new objects/routes | No change | No new checklist | No change | No new association | One candidate/EOC per generation | No duplicate delivery |

For a first negotiation there is no current transport to protect. Remote offer
receipt may create a transceiver and deliver `ontrack` before an answer. A
remote-only transceiver removed by rollback loses its MID and is excluded from
the peer's transceiver collection unless the application attached a local
track. The application may still hold its object reference. A subsequent new
offer may create a new object and a new legitimate notification.

Rollback reverses SDP-driven `stopping` and `stopped` changes. An application
`stop()` call made during pending negotiation remains effective, including
when the same transceiver was already marked stopping by SDP processing.
Application-added transceivers remain in the collection after rollback even
when they have no local track; their identity, direction and sender are not
part of the SDP rollback baseline.

A stopping transceiver is offered and answered as a rejected (zero port)
m-line (JSEP 5.2.2, 5.3.1); the final answer marks it stopped and unregisters
its routes. werift also writes an `inactive` m-line with a zero port, so a
zero-port answer stops only a transceiver the application is stopping; any
other one keeps `currentDirection` `inactive`. A transceiver added later
recycles the m-line of a stopped transceiver with a new MID instead of
appending one. When a remote offer recycles an m-line, the transceiver that
owned it is marked stopped and its routes are removed as SDP-driven, reversible
changes; its sender and receiver stop at the final answer.

ICE credentials change only on an ICE restart. A transport created after
rollback discarded every live transport inherits the last local credentials,
so a description created before the rollback still matches its transport.

A dynamic payload type keeps its codec for the session (RFC 3264 section
8.3.2). A remote offer, pranswer or answer that remaps a payload type of a
current, non-rejected m-line is rejected in validate, so in-flight current RTP
is never decoded with a pending codec. New payload types of a pending
description may be added to a receiver; the rollback baseline holds each
receiver's codec and RTX-SSRC tables and rollback restores them exactly.

A BUNDLE split prepares a separate ICE/DTLS transport for its new owner while
the previously shared transport stays connected. This also applies to a local
offer whose BUNDLE group was changed before `setLocalDescription`; the pending
local SDP is refreshed with the new owner's own ICE credentials and candidates.
The new owner is a new DTLS association, so its offer uses `actpass` and the
answerer picks the opposite of the offered setup (RFC 8842). Each transport
takes the DTLS role of its own m-line, not of the first m-line. The m-line that
moves away brings its new ufrag to its own transport; the transport it leaves
is not treated as an ICE restart.

For pranswer, non-`inactive` agreed m-lines may send and receive RTP/RTCP.
Pending ICE may gather, check and nominate; DTLS may start after ICE; a new
SCTP association and DCEP may become active. Existing RTP routes, selected
pair, DTLS and SCTP remain available alongside them. The final answer is
validated afresh and can differ from every earlier pranswer. Replaced or
rolled-back provisional resources are stopped. Existing DataChannels stay on
their committed association; channels opened on a pending-only association
close when it is discarded. Application-created unattached channels remain
application objects for a later negotiation.

`createDataChannel` is an application operation, like `stop()`. An SCTP
transport that carries a `createDataChannel` call is marked as
application-owned. When rollback finds such a transport that is not in the
baseline and whose association has not started, it keeps the transport and
its channels. Rollback only clears the MID, m-line index, remote port and
remote message size that the rolled-back description set. The next offer
carries `m=application` again, and the channels open once it is answered. An
SCTP transport that a description created, or an association that already
ran under the pending description, is stopped as before. A transport created
during the transaction that no binding holds at commit (for example the data
channel's own transport after BUNDLE moved SCTP to the tag) is stopped at
commit.

Restart credentials that an applied offer carries belong to that offer until
it is answered, replaced or rolled back. A later `createOffer()` that is not
applied cannot drop them: without `iceRestart` it only discards credentials
an earlier unapplied `createOffer` staged, and with `iceRestart` it reuses the
pending offer's credentials (JSEP 5.2.1). The final answer switches exactly
the generation of the applied offer, so the current local SDP and the live
ICE credentials agree.

An ICE restart (changed ufrag/pwd without a transport topology change) keeps
the existing ICE and DTLS transports and their DTLS association, as RFC 8842
and JSEP require and as browsers expect: a restart must not renegotiate the
DTLS role or start a second handshake. The existing ICE transport stages the
restart credentials. During pranswer that transport runs a provisional ICE
generation beside the selected current pair: the pranswer (or pending offer)
credentials, candidates, trickle and EOC feed a separate checklist whose
bucket is selected by the pending ufrag, incoming checks for the staged ufrag
are answered and recorded there only, and nomination is kept as provisional.
The current pair, consent and DTLS session keep carrying RTP and SCTP. A
replacement pranswer resets that checklist, rollback discards it, and the
final answer activates the staged credentials on that transport. A remote
restart is detected per BUNDLE owner that keeps its live transport, by
comparing the owner's proposed ufrag with that transport's committed remote
ufrag; only those transports stage restart credentials. The staged-credential and
provisional-generation methods of `IceConnection` are optional: a custom
implementation without them still restarts ICE at the final answer, but cannot
run provisional checks during pranswer. Only a BUNDLE owner
change creates a separate pending ICE/DTLS transport.

A remote re-offer whose BUNDLE plan would move an established SCTP association
to another DTLS transport is rejected in validate, before a replacement retires
the earlier pending offer; the earlier offer can still be answered.

Trickle with an explicit `usernameFragment` targets the matching current or
pending remote generation; without one it targets the latest applicable
generation. MID takes precedence over m-line index. Null or empty candidate
is EOC for the selected sections. Pre-SRD buffering remains the public werift
behavior. Candidate and EOC mutations are idempotent within a generation; an
old-generation callback may update only that generation and cannot be carried
into a replacement generation. Upstream WPT-only stricter behavior belongs in
`tools/wpt-runner` wrappers.

MIDs and m-line indexes that `createOffer` assigns are provisional until that
offer is applied. When a remote offer opens the transaction instead, the
assignments of every unapplied `createOffer` since the last transaction are
reverted for transceivers the session never negotiated, so they cannot collide
with the remote m-lines. Applying a replacement local offer (or an offer after
a remote pranswer) restores the baseline and then re-applies the assignments
that offer was created with. An answer or pranswer gives a current direction
only to transceivers with an m-line in it; one the application added after the
offer stays unnegotiated.

## Routing keys

The router and receivers resolve RTP by keys that the current session and a
pending proposal share: payload type, RTP header extension ID, SSRC, RTX SSRC
and MID+RID. One rule covers all of them. A pending remote offer or pranswer
may **add** keys, which take effect at once so provisional RTP can flow, but a
key the current session already uses keeps its current value until the final
answer commits. A conflicting value is either rejected before any mutation or
staged and switched at commit; rollback drops what was staged and restores
what the pending description added.

| Key | Where | Conflicting proposal | Basis |
| --- | --- | --- | --- |
| Payload type → codec | receiver codec table | Remap rejected (`InvalidModificationError`); fmtp-only change of the same codec staged until commit | RFC 3264 §8.3.2 |
| Header extension ID → URI | router `extIdUriMap` (shared by all m-lines) | ID remapped to another URI rejected; a URI moved to a new ID is an addition (old ID keeps parsing) | RFC 8285 §7; Chrome rejects "RTP extension ID reassignment" |
| SSRC → receiver | router `ssrcTable` | SSRC moved to another m-line staged: current RTP keeps its receiver until commit | Chrome accepts the move |
| RTX SSRC → media SSRC | receiver RTX table | Changed pairing staged until commit | Chrome accepts the change |
| MID+RID → receiver | router `ridTable` | RIDs are scoped to their m-line (RFC 8851), so another m-line reusing RID names is a new key, not a conflict | RFC 8851 |
| Sender SSRC → sender | router `ssrcTable` | Application state (`addTransceiver`), not description state: rollback keeps the route of every live sender, including one added while the description was pending | — |
| Remote track for SSRC/RID | receiver `tracks` | Only added for new keys; the current track of a key is never replaced | — |
| RTCP feedback of a payload type | receiver codec table | A changed `a=rtcp-fb` of a current payload type is staged until commit; NACK / TWCC / PLI follow the codec of each packet, not the lowest payload type; a PLI request for an SSRC follows the live receive codec of the payload type that SSRC carries, never a codec kept on its (reused) track | — |

The RID lookup uses the MID header extension when the packet carries it and
otherwise the first m-line with that RID. The sender keeps its committed codec
and header extension IDs while a re-offer is pending; werift never remaps its
own extension IDs. A remote pranswer may apply its send parameters
provisionally (codec, header extensions, RTX / RED payload types, MID, RID);
the baseline holds the complete set and rollback restores it. Transport-cc
feedback is not started by a pending description: the receiver starts it from
a packet whose codec negotiated it, or when the answer commits, and a feedback
object a pending description started is stopped on rollback. A transceiver
created for a remote offer is not an application operation: it does not make
negotiation needed and never takes over an inactive transceiver's slot.

## ICE generation boundaries

A restart keeps the ICE transport's sockets. The ICE package keeps the
generations apart on them:

- The new generation queries STUN again on the kept sockets; if no answer
  arrives in time, the socket's previous server-reflexive candidate is
  advertised again instead of being dropped. A description therefore never
  stops listing a candidate its generation already advertised.
- A late check addressed to an earlier ufrag (consent on the old pair) does not
  relabel the live host candidate with that ufrag.
- A check still in flight when the restart reset the checklist cannot select a
  pair of the discarded checklist.
- Restart credentials an applied offer or pranswer signalled stay until that
  description is answered, replaced or rolled back; `createOffer` /
  `createAnswer` reuse them instead of generating new ones.
- A provisional check counts only for the checklist it was sent for: a
  response that arrives after a replacement pranswer (new remote credentials)
  or after its pair left the checklist is ignored, and an incoming check from
  other remote credentials than the current provisional ones creates no pair.
- `restartIce()` records the local ufrags of the current and the pending
  local description to replace (W3C `[[LocalIceCredentialsToReplace]]`). Every `createOffer` restarts ICE while
  the request stands; a rollback or glare keeps it, and it clears only when an
  answer commits local credentials outside that set.
- Remote end-of-candidates completes a generation (RFC 8838), live or
  provisional: a later candidate of it reaches neither the SDP (current or
  pending) nor any checklist, and its mDNS name is not resolved. A candidate
  that arrived before end-of-candidates and is still resolving its mDNS name
  is kept; the generation completes after it. A resolution that finishes
  after an ICE restart or a replacement pranswer is dropped.

## Test coverage

`tests/integrate/negotiationTransactionUtils.ts` holds the shared Arrange
utilities and the test-only `assertNegotiationInvariants(pc)`. In every
signaling state it checks MID uniqueness, router endpoints and receiver codec
tables against current SDP, BUNDLE owner, MID and mLineIndex, the live ICE
generation (credentials, candidates, EOC, checklist membership of the selected
pair, no provisional generation in stable), DTLS role and fingerprint, SCTP
MID, mLineIndex, owner transport and parameters, and that every transport
that left use is closed. `negotiationTransactionMatrix.test.ts` runs the
transition matrix with each peer once as the offerer and calls the helper after
every description and candidate operation, then verifies RTP and DataChannel
traffic in both directions.
The helper also checks the routing keys above against the live tables in every
signaling state: each SSRC, RTX pair and MID+RID of the current remote SDP
resolves to the current receiver (with its track), no extmap ID the router
knows contradicts the current SDP, and no staged route survives in `stable`.

`negotiationTransactionProperty.test.ts` is a seeded property test. Each step
is a random negotiation episode (offer / pranswer / answer / rollback /
replacement, ICE restart, new audio m-line, audio BUNDLE split/merge,
end-of-candidates) or a remote-only routing-key mutation (RTX pairing, extmap
URI moved to a new ID, which then rolls back, or an extmap ID remap, which must
be rejected without state change). The helper runs after every operation and
real RTP (video, audio) and DataChannel traffic is checked after every step.
`negotiationTransactionRouting.test.ts` covers each routing key and
`negotiationTransactionRegression.test.ts` turns what the property test and
the pre-review self-review found into deterministic cases.
CI replays a fixed seed set plus the seeds that found bugs; a deeper local
search uses `WERIFT_NEGOTIATION_FUZZ_SEEDS`, `WERIFT_NEGOTIATION_FUZZ_STEPS`
and `WERIFT_NEGOTIATION_FUZZ_SEED`, and a failure prints its seed and
operations. Before asking for review, run a deeper search and a self-review
that lists every path writing live tables while a description is pending.

## m-line rejection, stop and reuse (issue 705)

The m-line rules of `docs/design/705-media-rejection-and-removetrack.md` run
inside this transaction:

- A remote offer or pranswer m-line without a common codec, or with port 0 for
  a known MID, only marks `pendingRejection`; the current pipeline keeps
  running. The flag, `rejected` and the track notification state are part of
  the baseline, so rollback restores them. The local answer commits the
  rejection (release, router unregistration); a remote answer with port 0
  stops the m-line after every fallible step.
- A remote answer or pranswer must share a codec with the pending local offer
  (`InvalidAccessError`, checked in validate). A remote pranswer or answer
  replaces what earlier pranswers of the same offer staged: staged routes and
  receive values are dropped before it applies, so the commit switches only to
  what the latest description carries.
- Every BUNDLE group counts, not only the first: the owner (tag) of each
  group decides the transport of its members for staged topology, candidate
  delivery and the DTLS role, and the answer keeps each negotiated tag first.
- Transport ownership: for a first negotiation and for answers, each offered
  BUNDLE group shares one transport and an m-line outside every group gets its
  own transport with its own ICE credentials, whatever `bundlePolicy` is. A
  transport created only for that ownership is dropped on rollback. A re-offer
  or pranswer on a live session keeps every current owner on its transport and
  prepares a changed topology for the answer (see BUNDLE split above), so a
  re-offer that moves an established member out of its group (RFC 8843
  section 7.5) is staged rather than rejected.
- A remote answer that moves an m-line sharing a transport in the local offer
  out of that BUNDLE group with other ICE credentials is rejected before
  mutation (RFC 8843 section 7.3.2).
- An application `addTransceiver` reuses only a same-kind position whose
  rejection or stop is committed; a transceiver for a remote offer replaces
  only a stopped transceiver at its index. Neither takes an inactive one.
- The answerer's `stop()` answers `inactive` and negotiates port 0 in its own
  next offer. `negotiationneeded` is coalesced per task and fires only for
  changes the last committed local offer did not carry.

## Scope and known constraints

The transition table, the mutation matrix and the property test's operation
catalog define what this design guarantees. A new combination outside them
(another subsystem, operation or interop target) is handled as a follow-up,
not as a change of this contract. Known constraints:

- Interoperability is verified with Chrome only.
- A DataChannel created on an already connected session without an SCTP
  association does not open after renegotiation (existing since `develop`).
- The header extension ID map is shared by the whole PeerConnection. m-lines
  on separate (non-BUNDLE) transports that map one ID to different URIs are
  not supported; only a remap of an ID the current session uses is rejected.
- A remote offer may associate an unassociated transceiver the application
  created with `addTransceiver` (W3C reuses only `addTrack` ones); this is
  existing werift behavior.
- The ICE layer drops the old selected pair when a restart commits; RTP pauses
  until the new generation nominates a pair.
- Codec order and dynamic payload types in the configuration may be adjusted
  to a sender track's codec while a remote description is applied; this only
  affects later offers, not current RTP, and rollback does not undo it.
- A transceiver displaced by m-line recycling is marked stopped when the
  recycling offer is applied (its current m-line is already rejected, so no
  current traffic uses it); rollback restores it.
- `createOffer` fills empty codec and header extension lists of a transceiver;
  these are defaults, not negotiated state, and stay after an unapplied offer.

