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
| commit | validated final answer and successful prepare | Switch BUNDLE routing, ICE generation, DTLS parameters, SCTP binding and RTP/router, then publish the current descriptions and `stable`. No fallible validation is allowed after the switch. Start remaining asynchronous connect work and report later failures on that generation; ICE checks start only for a generation that has not run them (the first negotiation, a committed restart); running checks are awaited and an established, completed or failed generation is not checked again. A running DTLS handshake is awaited (the connection reports `connected` only after it), never started again. Candidates and end-of-candidates trickled on any member m-line of a BUNDLE group go to the shared transport's generation. End-of-candidates ends one generation: on the current description, a transport and ufrag; on a pending proposal (a restart offer's new ufrag), the proposal's own BUNDLE owner (group tag or the m-line itself) and ufrag, before any transport is prepared. It marks every MID of that generation complete and a later candidate of it on another MID is ignored (RFC 8838 section 14); an m-line the proposal splits off stays open even with the same credentials (RFC 8839 section 5.4). Applying a created description later or again follows the description reuse contract below. An applied description the gathering refreshes keeps the generation it applied (credentials, candidates, end-of-candidates). Preparing transports (the owners `createAnswer()` prepares, a local offer's staging) checks after every gather whether the peer was closed meanwhile; if so it stops the transports it created and fails with `InvalidStateError`. A description operation checks for `close()` after every await and after every signaling event a handler could close from (the `stable` of an implicit rollback included); once closed it changes nothing more, skips its failure recovery and fails with `InvalidStateError`, and a closed connection creates no transport. A restart's background gathering belongs to its generation: once a later restart or `close()` replaces it, its sockets and TURN allocation close and it signals no candidates, end-of-candidates or `complete`. |
| cleanup | commit or rollback finished | Stop orphan pending resources; keep only current ownership and event deduplication needed for future revisions. A transport created during the transaction is remembered until it closes or a commit decides whether it is still bound; `close()` drops every such reference and the `createOffer` snapshot. |
| rollback | active pending transaction | Stop provisional communication, discard pending candidates/EOC and resources, restore the first baseline and publish `stable`. Already delivered events remain delivered. Rolling back a first negotiation (a connection made at its pranswer included) resets `connectionState` and `iceConnectionState` to `new`; a remote-created transceiver the application keeps returns to the state it was created with. A DTLS association a first pranswer connected keeps its role at the final answer. |

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

## Description reuse contract

A created description may be applied later or again: after other
descriptions were created, after a rollback, after the session became stable,
or as a replacement. Applying it is built only from the SDP and the
description's generation record, never from state kept elsewhere:

- **Generation records.** `createOffer()` records, with its SDP, the
  transceiver each MID was created for (`RTCPeerConnection.createdOffer`).
  Each ICE restart generation a created offer or answer carries is registered
  on its transport by ufrag (`RTCIceTransport.localGenerationFor`); the
  latest created offer and the latest created answer each keep theirs until
  a newer description of the same kind replaces it, whatever is applied,
  rolled back or committed meanwhile (its own commit or another generation's
  does not end it). The codecs come from the SDP itself.
- **Apply = proposal, then writes.** `setLocalDescription` parses the SDP,
  plans the MID / m-line assignments from the SDP and the record (transceivers, and the SCTP transport for the application m-line), validates
  the credentials of every m-line against its transport (the live ones or a
  registered generation) and stages the new transports the topology needs.
  Nothing live or transactional is written before all of this passed, so a
  failure there leaves the peer exactly as it was. Only then are pending
  descriptions retired, the assignments written and each transport switched
  to the generation the description carries (an ICE restart to those
  credentials on the kept sockets). The transports an owner reuses are those
  live when the offer is installed.

Rules: (a) an application W3C requires to accept is accepted; (b) one
develop accepted and then communicated with is not regressed (it is
accepted and communicates); (c) anything else is refused with
`InvalidModificationError` (or the exception the specification names) and
changes nothing. "develop" below is measured with
`tools/negotiation-diff/scenarios.ts` on develop 71b6ddbf.

| Order of operations | Result | Basis |
| --- | --- | --- |
| answer saved, `createOffer()` (not applied), the saved answer applied | accept | (a) the answer is still [[LastCreatedAnswer]]; develop: accepted, communicates |
| answer created again (also with an unapplied restart offer created in between), the first one applied | accept | (b) develop: accepted, communicates (werift, like develop, does not compare an answer with [[LastCreatedAnswer]]) |
| unapplied restart offer (`createOffer({ iceRestart })`, or `restartIce()` + `createOffer()`), then the saved answer applied | accept | (a) [[LastCreatedAnswer]] unchanged; develop accepted but lost the session (it restarted ICE at `createOffer`) |
| offer created while a remote offer was pending, applied after `stable` | accept | (a) it is [[LastCreatedOffer]]; develop: accepted, communicates |
| the same offer re-applied after its rollback (no restart / restart / restart with new media) | accept | (a) rollback does not change [[LastCreatedOffer]]; develop: accepted, communicates |
| a restart offer re-applied (after its rollback, or after it committed once) once the peer committed another restart | accept (restarts to the offer's credentials) | (a) and (b): develop accepted and communicates (it made the credentials live at `createOffer`) |
| the latest offer re-applied after its answer made the session stable | accept | (a) and (b): develop accepted, communicates |
| `have-remote-pranswer`: replaced by the same offer or a new one; also after a first pranswer connected | accept (the remote pranswer is rolled back first) | ticket 2.1 transition table (werift extension: JSEP 5.5 / W3C reject a local offer in this state with `InvalidStateError`, and develop does) |
| the peer's previous answer (fewer m-lines) applied to a new local offer | accept; the m-lines it leaves out are rejected | (b) develop: accepted, the session communicates (RFC 3264 §6 asks for the offer's m-line count; found by the develop comparison) |
| a stale offer (a newer one was created) | reject `InvalidModificationError`, nothing changes | W3C: sdp is not [[LastCreatedOffer]]; develop rejects too |
| a munged local offer | reject `InvalidModificationError`, nothing changes | W3C: sdp is not [[LastCreatedOffer]]; develop rejects too |
| glare: the polite peer takes the remote offer | accept (implicit rollback) | W3C implicit rollback of `have-local-offer`; develop: accepted, communicates |

A reuse order the table does not list is a follow-up (see Scope).

### Comparing with develop (local)

`tools/negotiation-diff` drives two peers through the public API only:
`run.ts` runs seeded operation sequences (unapplied `createOffer` /
`createAnswer` after `iceRestart`, `addTransceiver`, `setCodecPreferences`
or `restartIce()`, saved descriptions applied from a pool, rollback,
re-application, pranswer, glare, trickle and end-of-candidates) and writes
one JSONL record per operation (resolve or reject with the error name,
signaling states, RTP per track and DataChannel both ways when stable);
`compare.ts` reports where develop accepted and then communicated but HEAD
rejected or lost communication; `scenarios.ts` measures the rows above.
Never check out develop in the active worktree:

    git worktree add --detach /tmp/werift-develop origin/develop
    # share the dependencies: link node_modules (root and packages/*)
    npx tsx --tsconfig ./tsconfig.json tools/negotiation-diff/run.ts \
      --root /tmp/werift-develop --seeds 200 --steps 12 --out /tmp/develop.jsonl
    npx tsx --tsconfig ./tsconfig.json tools/negotiation-diff/run.ts \
      --root ../.. --seeds 200 --steps 12 --out /tmp/head.jsonl
    npx tsx tools/negotiation-diff/compare.ts /tmp/develop.jsonl /tmp/head.jsonl

CI runs only the fixed-seed property test, whose description-pool episodes
check the same contract with an atomicity oracle (a refused operation leaves
both peers' snapshot identical).

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

Restart credentials are registered generations (see the description reuse
contract): creating a description only changes which generation the next
SDP carries, and applying a description selects the one its SDP carries. A
new offer reuses the generation of the applied pending offer (JSEP 5.2.1),
unless `restartIce()` was called while it was pending (its credentials are
then in W3C `[[LocalIceCredentialsToReplace]]` and the offer gets new ones),
and an answer created again for the same remote offer reuses the earlier
answer's (JSEP 5.3.1), whatever was created in between. The final answer switches
exactly the generation of the applied description, so the current local SDP
and the live ICE credentials agree.

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
| RTCP feedback of a payload type | receiver codec table | A changed `a=rtcp-fb` of a current payload type is staged until commit; NACK / TWCC / PLI follow the codec of each packet, not the lowest payload type; a PLI request for an SSRC follows the live receive codec of the payload type that SSRC carries (it needs `nack pli`, RFC 4585), never a codec kept on its (reused) track | — |

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
generations apart on them.

**Provisional generation.** While an ICE restart of an established transport
is negotiated, a second checklist (the provisional generation) runs beside the
live one on the same sockets. It only exchanges STUN checks; RTP and
DataChannel stay on the live selected pair. It follows the live checklist's rules:
`filterCandidatePair` decides which pairs it forms, an ICE-lite agent only
answers its checks, a controlling full agent nominates toward an ICE-lite
peer by regular nomination (a check with USE-CANDIDATE on the first pair that
succeeded), and an error response (a 487 role conflict) to a check addressed
to the staged ufrag is signed with the staged password.

- Created when the restart credentials are staged: by `createOffer()` while a
  `restartIce()` request stands (offerer), or by `createAnswer()` for a remote
  offer that changes the ufrag of a live transport (answerer). It then holds
  only the local credentials and already answers checks for that ufrag.
- Fed with the peer's credentials, candidates and end-of-candidates by the
  pranswer: a remote pranswer on the offerer, the remote offer when the
  answerer applies its own pranswer. Trickled candidates of that generation
  follow. A replacement pranswer restarts its checklist (new revision).
- Checks start when the pranswer is applied (`connectPending`); the
  controlling side nominates a provisional pair. The live selected pair and the
  send target never change.
- Ends at the final answer, which recreates the live ICE agent with the staged
  credentials and checks the answered generation from scratch (the provisional
  nomination is not carried over), or at rollback / a replacement offer /
  creating a description that selects another generation, which stops its
  checks and keeps the live generation (the generation itself stays
  registered while its description record does). A first negotiation and transports created for the proposal
  (BUNDLE split, pending-only) have no provisional generation; they connect
  normally from the pranswer.

Further rules:

- Candidates of a restart generation are fixed when its offer or answer is
  created: the kept sockets' host candidates and the server-reflexive address
  each had. The commit re-advertises exactly these, synchronously, and never
  waits for a server, so checks of the new generation start at once. Without
  ICE servers the description carries end-of-candidates. With STUN or TURN
  servers it carries neither the relay candidate nor end-of-candidates: after
  the commit the generation keeps gathering in the background (a fresh STUN
  query whose changed mapping is added, and a new TURN allocation that
  replaces the previous one, which closes, so a restart recovers from a dead
  allocation), trickles what it adds and then end-of-candidates. A
  description never stops listing a candidate its generation already
  advertised.
- The successful check that nominates a pair is its initial consent (RFC 7675
  section 5.1): data may flow as soon as the pair is selected. Gathering that
  finishes after checks began does not overwrite the connection state.
- A transport that has no generation yet (a new m-line created beside a
  restart) does not stage the restart; its first gathering has fresh
  credentials.
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
  after an ICE restart or a replacement pranswer is dropped. End-of-candidates
  is recorded on every m-line of the transport's BUNDLE group, laid out on the
  committed transports for the current description.
- Description operations record a remote candidate in the SDP and route it,
  then hand it to the ICE agent without waiting: an mDNS name that takes
  seconds to resolve (or never resolves) does not hold `addIceCandidate`,
  later candidates or description operations.

## Code layout

`RTCPeerConnection` (`src/peerConnection.ts`) keeps the public API and the
order of each description operation; each concern lives in its own module.
`src/negotiation/` holds the negotiation subsystems it drives, `src/api/` the
public configuration and event types it re-exports.

| Module | Responsibility |
| --- | --- |
| `negotiationTransaction.ts` | Lifecycle of the baseline, checkpoints, commit and rollback; resources a proposal created (`ProposalResources`) |
| `negotiation/descriptionValidation.ts` | Local / remote description checks before any mutation |
| `negotiation/remoteMediaApplication.ts` | Remote m-lines: transceiver association, BUNDLE transport ownership, RTP / SCTP acceptance, planned transport updates |
| `negotiation/bundleTopology.ts` | BUNDLE tags of every group, staged topology for local and remote offers, shared-transport checks |
| `negotiation/remoteCandidates.ts` | Trickle ICE: routing candidates and end-of-candidates to their generation, pre-SRD queue |
| `negotiation/transportActivation.ts` | Connecting live and provisional transports, activating staged parameters, retiring a first provisional connection |
| `negotiation/negotiationNeeded.ts` | `negotiationneeded` coalescing and change sequence numbers |
| `negotiation/iceRestartRequest.ts` | `restartIce()` request until a negotiation replaces the credentials |
| `negotiation/internalState.ts` | Negotiation state types, the MID+RID route key and application `stop()` provenance (internal, not exported) |
| `api/peerConfig.ts` / `api/peerConnectionEvents.ts` | Configuration types, defaults and validation; event types |

Each component owns the snapshot of its own reversible state and the rule
for restoring it; the transaction only composes them. A new piece of
negotiation state is added to its component's pair, not to the transaction:

| Component | Snapshot / restore | Kept across rollback |
| --- | --- | --- |
| `RTCRtpTransceiver` | `snapshotNegotiationState` / `restoreNegotiationState` (with its sender and receiver) | an application `stop()` made during the transaction |
| `RTCRtpReceiver` | `snapshotNegotiationState` / `restoreNegotiationState` | SSRCs learned from RID packets whose track survives |
| `TransceiverManager` | `snapshotNegotiationState` / `restoreNegotiationState` (order, track notification, removal of proposal-created transceivers) | transceivers the application uses (`heldByApplication`) |
| `RtpRouter` | `snapshotRoutes` / `restoreRoutes` | packet-learned SSRC routes, every live sender's own route |
| `SctpTransportManager` | `snapshotNegotiationState` / `restoreNegotiationState` | an application-created SCTP transport whose association never ran |

## Effective values while pending

Which description a live value follows while a negotiation is pending. Rules:
**current** (the committed value stays live), **provisional** (the latest
applied pranswer, local or remote, is live until the final answer or
rollback), **both** (current stays live and the pending description adds
what does not conflict; conflicts are staged until commit), **reject** (the
change is refused before any live mutation). The final answer always commits
its own values (it can differ from every pranswer) and rollback always
returns to the baseline. A first negotiation has no current value: its
pranswer is live (provisional) for every row.

| Value | Remote offer | Pranswer / replacement pranswer | Final answer | Rollback | Checked by |
| --- | --- | --- | --- | --- | --- |
| ICE credentials, candidates, EOC | current | both: a provisional generation beside the selected current pair (ICE generation boundaries); a replacement restarts its checklist | commit; changed remote credentials restart the checks and keep the local credentials the offer described | current | helper `assertIceGenerations`; Scen (ice, rollback) "local ICE restart then %s" |
| DTLS role / fingerprint | current | current association kept; a new association (BUNDLE split owner) is provisional; a role change of a connecting / connected association (also one a first pranswer connected) is rejected | commit (same rule) | current | helper `assertDtlsBindings`; Scen (reject) "a local answer that flips the DTLS setup of a connected association is rejected" |
| Receive codec / RTCP feedback | both | both | commit | current | helper `assertRouterAndCodecs`; Routing (`negotiationTransactionRouting.test.ts`) |
| Send codec (sender parameters) | current (the offer only proposes) | provisional on both sides | commit | current | helper `expectedLive("sendCodec")`; Model (scene) "a pranswer sends with its codec on both sides until %s" |
| Direction (`currentDirection`, sending) | current | provisional: an `inactive` / `recvonly` pranswer stops sending | commit | current | helper `expectedLive("direction")`; Scen (commit, rollback) "an inactive pranswer stops sending until a sendrecv %s"; Scen (commit) "replacement pranswer and a different final answer" |
| BUNDLE owner / transport | current | both: current owners stay, a split owner is provisional | commit | current | helper `assertDescriptionBindings`; Matrix "BUNDLE split, tag change and merge route RTP by MID" |
| SCTP port | current | reject a change of an existing association (also one a first pranswer started) | reject (same) | current | helper `assertSctpBinding`; Scen (reject) "an existing SCTP port change is rejected before mutating the association" |
| SCTP max-message-size | current | provisional (W3C updates the data max message size at answer and pranswer, local or remote) | commit | current | helper `expectedLive("remoteMaxMessageSize")`; Scen (commit, rollback) "renegotiation max-message-size follows offer, pranswers and %s" |
| Header extension IDs | both (new IDs); remap of a current ID rejected | both; remap rejected | commit | current | helper `assertRouteTables`; Model (oracle reject: a remap of a current header extension ID) |
| Remote SSRC routes | both (conflicts staged) | both; the routes a replaced pranswer alone added are dropped, and its track is taken over by the next SSRC the description gives that receiver | commit (a current SSRC the answer omits stays routed, as on `develop`) | current | helper `assertEffectiveValues` (pranswer SSRCs route) |

`expectedLive(snapshot, field)` in the test utilities encodes the
provisional / current columns for direction, send codec and max-message-size
and replaces a uniform "live = current SDP" check; the other rows are checked
by the helper functions listed.

## Peer-diversity mutations

`tools/negotiation-diff/mutations.ts` rewrites a werift description the way
other peers differ. Session-level and codec mutations are listed by hand: no
BUNDLE, one group per m-line, ICE-lite, reversed or `actpass` DTLS setup,
max-message-size, sctp-port, no NACK / PLI, a changed fmtp, a codec subset or
reorder, a renamed MID (#142), swapped extmap IDs, other SSRCs, and no
end-of-candidates. Per-kind mutations are generated from a table of kinds
(audio, video, application) and attributes (port 0 and out of BUNDLE,
inactive, out of BUNDLE, own ICE credentials), so every kind gets every
attribute that applies to it (`applicationRejected`, `audioInactive`, ...).
The mutations are pure string rewrites, so the same library drives the tests
and the develop differential runner.

Interoperability with browsers and other implementations is the
responsibility of the end-to-end tests (`e2e/`, real Chrome). The individual
cases in `tests/negotiation/cases` therefore never fabricate another peer's
description or candidates (TICKET 2.20): the former
`negotiationTransactionMutation.test.ts`, the rejected-application paths and
every case that rewrote a remote description, wrote an external SDP or
trickled hand-made (mDNS) candidates were removed. The library stays for the
develop differential runner: `run.ts --mutate <p>` rewrites delivered
descriptions with probability `p`, so `compare.ts` reports what `develop`
accepted and communicated with but HEAD does not. Its only findings are
intended rejections: a changed `sctp-port` for an established association,
which HEAD rejects atomically (accepting it would make the current SDP
describe a port the live association does not use). The model property's
wire rewrites (`tests/pbt/model/wireMutations.ts`) reuse some of these rewrites.

## Interrupts

`negotiationTransactionInterrupt.test.ts` holds a negotiation at a wait —
the gathering of an ICE restart commit, an mDNS lookup of a provisional
generation's candidate, the DTLS start of a first answer, STUN checks to
candidates nobody answers — and meanwhile closes the connection, requests
`restartIce()`, starts a new offer, or rolls the pending pranswer back. The
held operation and the interrupt must settle (no hang), the invariants hold,
`close()` leaves every transport created so far closed, and otherwise a clean
negotiation afterwards communicates. A closed ICE transport stays `closed`:
checks that `stop()` interrupted do not report `failed` afterwards.

## Rules found by mutations and spec coverage

Each has a test that fails without it.

- A replacement remote offer that describes the MID of a transceiver the
  replaced offer created (same kind) carries it over in its created state —
  same MID, m-line and track objects — and notifies nothing again.
- Rolling back a first negotiation also replaces a transport that only got the
  rolled-back offer's remote credentials and candidates.
- At the final answer SCTP moves straight to its owner's transport in the
  answer; it never detours over its own prepared transport, which would
  replace an association a first pranswer established.
- A stopped SCTP transport delivers no DCEP a queued callback still carries.
- A rejected application m-line (port 0 in an answer, a pranswer or the
  peer's offer) does not close anything, as in develop: the SCTP transport
  stays bound to its MID and the next offer offers the application again
  with that MID. At the commit the SCTP transport is not moved to a transport
  the answer did not negotiate for it. (An earlier rule closed it and removed
  `sctpTransport`; the next `createOffer()` then failed. See "Rejected
  application m-lines".)
- After a replacement pranswer, a proposal transport no m-line uses any more
  stops the checks the earlier pranswer started and keeps its local
  generation for the final answer.
- Transport-cc feedback starts from a packet whose own codec negotiated it.
- A remote offer cannot recycle (new MID on) an m-line a local transceiver
  that is not stopped still uses, inactive or not.
- An offer created after `restartIce()` while a restart offer is pending
  replaces the pending credentials too.
- Candidates are signalled as copies: the local description renders the
  transport's own candidates, whose foundation never gets the `candidate:`
  prefix of the event (an ICE restart offer described
  `a=candidate:candidate:…`; found by the scenario properties).
- An SCTP transport whose MID only an unapplied `createOffer` reserved (no
  description negotiated it) follows the MID of the peer's offer; the answer
  no longer repeats a MID (seed 186 of the model property).
- An answer rejects (port 0) an m-line it can give no codec, such as a
  stopping transceiver whose codec preferences were just set; it was an
  m-line without formats (seed 264; also in develop).
- A replacement remote offer that describes again an m-line an existing
  transceiver of the peer received keeps the track event it delivered: the
  implicit rollback no longer resets the notified track (and the receiver
  keeps its track object), so the track event is not fired twice (as
  develop; found by the model property, seeds 9 and 27).
- A transceiver the application added while a description was pending is
  never committed by it: rollback (also from `have-remote-pranswer`) takes
  back its MID / m-line, the direction a pranswer gave it and everything the
  proposal negotiated for it (back to its created state); a track event it
  already delivered stays, with its track unbound for the next negotiation's
  SSRC (found by the scenario properties, seeds 15 and 52).
- A PLI request needs `a=rtcp-fb:<pt> nack pli` on the payload type the
  SSRC carries: a generic `nack` alone no longer allows it (RFC 4585; found
  by the model property's feedback oracle, seed 110; also in develop).
- Refreshing an applied local description (end-of-candidates) keeps the
  credentials it applied: an m-line a first max-compat offer described with
  its own transport, which BUNDLE then moved onto the tag's, is not
  rewritten with the tag's credentials, so the current local description
  does not change outside a negotiation (seed 38; also in develop).
- A MID only an unapplied `createOffer` reserved (no applied description
  has its m-line) is released at the answer instead of being stopped as a
  rejected m-line; for a transceiver it was stopped, for SCTP it collided
  with the peer's next MID (seeds 64, 114 and 545; also in develop).
- RTX pairs with its `apt` codec wherever the description lists it: an
  answer that puts RTX before its primary codec (an answerer's preference
  order) kept no RTX pairing (seed 15; also in develop).

## Test coverage

`tests/negotiation/harness/negotiationTransactionUtils.ts` holds the shared Arrange
utilities and the test-only `assertNegotiationInvariants(pc)`. In every
signaling state it checks MID uniqueness, router endpoints and receiver codec
tables against current SDP, BUNDLE owner, MID and mLineIndex, the live ICE
generation (credentials, candidates, EOC, checklist membership of the selected
pair, no provisional generation in stable), DTLS role and fingerprint, SCTP
MID, mLineIndex, owner transport and parameters, and that every transport
that left use is closed. The transition matrix runs as fixed scenes of the
scenario properties below (each peer once as the offerer);
`negotiationTransactionMatrix.test.ts` keeps the matrix rows with their own
values (transceiver stop and m-line reuse, BUNDLE split / tag change / merge).
The helper also checks the routing keys above against the live tables in every
signaling state: each SSRC, RTX pair and MID+RID of the current remote SDP
resolves to the current receiver (with its track), no extmap ID the router
knows contradicts the current SDP, and no staged route survives in `stable`.

### Continuation after every test

`expectSessionContinues(a, b)` checks that a session is still usable after
the operations of a test, not only right after them: from `stable` (a pending
description is rolled back, a pranswer is finished with its final answer) it
negotiates a plain offer from `a`, an ICE restart offer from `a`, an offer
from `a` that adds a DataChannel and a transceiver, and an offer from `b`,
with the invariants after every step, then checks data and RTP both ways on
the added DataChannel and transceiver. `enforceSessionContinuation()` fails a
test in which a peer applied a local description but never reached the
helper, unless the test exempted it with a reason
(`exemptFromContinuation`: `close()` is the operation under test, a single
peer negotiated against hand-built SDP, or a mutation that misdescribes the
real peer). Every case file of `tests/negotiation/cases` enforces it.

### Test layout

Tests are sorted by what decides their verdict. A test that needs only the
invariants, an unchanged state, continued traffic or a baseline match (or a
value a generic rule derives, such as the effective direction or
max-message-size) is a fixed scene of a scenario property; a test of a
spec value no generic rule gives, of timing / concurrency, of a special
environment (TURN, simulcast, codecs, `bundlePolicy`, held gathering) or a
regression minimized from a seed stays an individual test. Individual tests
are TypeScript cases of the harness (see "Negotiation cases"); the
table-driven matrices take their Arrange from the `negotiationTest` fixtures
of `negotiationTransactionUtils.ts` (`videoPeers`, `session`, `closing`;
imported as `test`, closed after the test).

`tests/pbt/scenario/negotiationScenarioProperty.test.ts` (with
`scenario/scenarios.ts`) has one property per claim: the final answer
commits the directions both applications asked for (commit); a pending
negotiation keeps the committed transports, DTLS roles, SCTP association,
remote ICE credentials and selected-pair generation (pending); rollback
returns a peer to the state before the negotiation, except the MIDs and the
staged ICE restart the proposal only reserved (rollback); a rejected
operation changes neither peer (reject); a trickled candidate joins its own
generation's description once (trickle); ICE credentials follow the restart
requests as W3C `[[LocalIceCredentialsToReplace]]` (ice); and creating an
offer or answer changes nothing (create). A scenario is text
(`a offer restart; b reply pranswer edit=inactive; alive silent; a rollback`)
run on a connected duplex session; every operation is followed by the base
checks (declared outcome and error name, the helper on both peers, no
`candidate:` foundation, the JSEP signaling transition with exact pending /
current descriptions, an untouched other peer), `alive` checks that every
negotiated stream flows (the applications' directions once settled, else the
effective `currentDirection`), DataChannel traffic and the effective
max-message-size limit, and every scenario ends with
`expectSessionContinues`. Each property runs its fixed scenes, named after
the individual tests they replaced, and random scenarios: CI runs
`WERIFT_NEGOTIATION_SCENARIO_SEEDS` (default 1) seeds of
`WERIFT_NEGOTIATION_SCENARIO_STEPS` (default 4) episodes from
`WERIFT_NEGOTIATION_SCENARIO_SEED`; a failure prints the seed, the scenario
text and the operation log, and the same seed replays it. The properties run
concurrently within the file (`describe.concurrent`).

`tests/pbt/model/negotiationModelProperty.test.ts` (with `model/generator.ts`,
`model/oracles.ts`, `model/wireMutations.ts` and `model/scenes.ts`) is the model
property: whatever the operations, after every description operation both
peers keep the invariants and these oracles hold.

- traffic (`c.expectTraffic()`, meta `traffic: true`): every stream whose
  sender's `currentDirection` sends, whose transceiver of the same MID on the
  other peer receives (a pranswer sets both provisionally) and that neither
  side stopped delivers one RTP packet from its local track within 2 s, and
  every DataChannel open on both peers delivers a message both ways. Only
  settled transports count (DTLS connected and a nominated pair of the
  current ICE generation; an ICE restart commit drops the old pair until the
  new generation nominates): after an operation an unsettled one is skipped
  without waiting, and the check after the scene waits up to 10 s for it.
  It holds while both peers have the same session (`c.sameSession`: each
  one's current local description, without candidates, is the other's
  current remote description, and so is a pending local description the
  other applied; a wire rewrite registered with `c.equivalent` counts as its
  original); while a renegotiation is pending, a stream on a transport that
  is not connected yet is not required (a pranswer stages a new transport
  for the final answer, see "Connection start").
- jsep: an accepted operation moves the peer to the state of its type and
  sets the pending or current description it applied (as the peer stores
  it, parsed and written again; a local description keeps its m-line
  structure; a rewritten split offer changes credentials), keeps the
  others, and leaves the other peer untouched. A transceiver without an
  m-line (not stopped) has no `currentDirection`.
- rollback: an explicit rollback restores the descriptions, the ICE
  credentials of the transports that existed (a restart only a created
  offer staged is dropped), the routes of the transceivers that existed and
  their committed MIDs, m-line indexes, send parameters (not the track the
  application attached, nor the codec a pending remote offer only
  proposes), receive tables and transport-cc feedback; MIDs a created offer
  only reserved may go. A transceiver the remote offer created is removed
  unless the application attached a track to it; one the application added
  or kept stays without a MID, direction, receive table or receive route;
  without a current session the connection states are `new` again.
- events: a state change fires `signalingstatechange` ending in the new
  state; rollback and an idempotent re-application fire no track or
  remote-transceiver event (DataChannels arrive asynchronously by DCEP); a
  receiver's track event fires again only after it stopped receiving (its
  remote m-line no longer sends, or a rollback) or with other streams; an
  open remote DataChannel is announced once.
- idempotent / create: re-applying the pending remote description, or
  creating an offer or answer, changes nothing (descriptions, live send
  parameters, receive tables, events).
- trickle: a trickled candidate is in its m-section at most once, and one
  of the current generation that entered the remote description is in the
  live checklist.
- feedback: after a packet of payload type P reached a receiver, a PLI
  request leaves it exactly when P's effective `a=rtcp-fb` has `nack pli`,
  and transport-cc feedback runs when it has `transport-cc`. P's effective
  feedback is the receiver's current remote description's when the current
  session has P on that m-line (a changed `a=rtcp-fb` is staged until the
  final answer), else the pending remote description's (an added payload
  type applies at once). An operation that commits nothing never starts
  transport-cc feedback for a packet whose codec lacks it.
- ice: an operation that commits nothing keeps the selected pair of every
  connected ICE transport (a restart checks its new generation beside it).
- commit: once both peers have the same current session, every m-line's
  `currentDirection` mirrors the other peer's and every sending codec is in
  the other peer's receive table; a DataChannel open on a committed session
  stays open. A DataChannel the application created never closes, and at the
  end of a scene one on a negotiated association is open on both peers. At
  a commit, an m-line that keeps its BUNDLE transport (same tag, or
  unbundled in both sessions) keeps its DTLS transport object (no new
  handshake).
- reject: an operation that may be rejected (`mayReject`) changes nothing
  when it is (the harness compares `negotiationSnapshot`); a wire rewrite
  that remaps a key the current session negotiated (a payload type to
  another codec on the same m-line, RFC 3264 section 8.3.2; a header
  extension ID to another URI, RFC 8285 section 7) must be rejected with
  `InvalidModificationError`.

Both peers use VP8 (NACK, PLI, REMB, transport-cc) with RTX, H264 (NACK,
PLI), Opus and PCMU, and the MID and transport-cc header extensions
(`modelConfig`). A scene is a start state (a connected duplex session, or
two unnegotiated peers where `a` sends video, with or without a
DataChannel) and a list of operations as data (`[side, name, choices]`:
tracks, recvonly transceivers, DataChannels, direction, codec preferences
(the first codec, or all reversed), stop and track attach (also on a
transceiver a pending remote offer created), `restartIce`, offer (ICE
restart), BUNDLE split offer, glare, replacement offer, pranswer, answer,
an answer after a preference or track change, rollback, re-application of
the pending remote description, create-only, applying a stale created
offer, trickle (new or described candidates, duplicates,
end-of-candidates), and an offer, pranswer or answer rewritten on the wire).
A wire rewrite (`model/wireMutations.ts`) either describes the same session
(fewer codecs or feedback, another order, an fmtp parameter, a larger
max-message-size, no end-of-candidates: the peers still agree) or
misdescribes the sender (inactive or rejected m-lines, other or swapped
SSRCs, no RTX, a renumbered payload type, a moved or swapped header
extension ID: the next clean negotiation must heal the session); a final
answer is only rewritten in the first way, and a rejected rewrite is
followed by the original description. Fixed scenes (`model/scenes.ts`) are
the operation sequences of former individual tests and regressions in a few
lines; random scenes draw one applicable operation at a time from a seed. A
failure prints the seed and the operations and, unless
`WERIFT_NEGOTIATION_MODEL_SHRINK=0`, shrinks the scene by dropping
operations and prints the smallest failing one, ready for `model/scenes.ts`.
CI runs `WERIFT_NEGOTIATION_MODEL_SEEDS` (default 4) seeds of
`WERIFT_NEGOTIATION_MODEL_STEPS` (default 10) operations from
`WERIFT_NEGOTIATION_MODEL_SEED`. The model property replaced 51 individual
tests whose verdict included traffic and needed no special environment
(TICKET 2.17) and 29 more whose verdict its oracles give (TICKET 2.19); it
trades their scene-specific values for oracles over every generated scene
(see `NEGOTIATION_CASES_MAPPING.md`). Cases that check concrete values of
ICE (end-of-candidates, credentials, generations), DTLS roles, BUNDLE and
the RFC codec rules stay individual tests: a wrong value there breaks
interoperability even when both werift peers agree.

`tests/pbt/fuzz/negotiationTransactionProperty.test.ts` holds the seeded episode
fuzzer and its episodes and atomicity check (`fuzz/episodes.ts`, built on
the shared utilities above); the seeded random stream every property uses is
`tests/pbt/shared/random.ts`. Each step
is a random negotiation episode (offer / pranswer / answer / rollback /
replacement, ICE restart, new audio m-line, audio BUNDLE split/merge,
end-of-candidates) or a remote-only routing-key mutation (RTX pairing, extmap
URI moved to a new ID, which then rolls back, or an extmap ID remap, which must
be rejected without state change). From their own random stream (so the
operations of existing seeds do not change), episodes also let the remote
peer reject an application, audio or video (added) m-line in the offer it
sends or in the answer it applies itself. The helper runs after every operation and
real RTP (video, audio) and DataChannel traffic is checked after every step.
`negotiationTransactionRouting.test.ts` covers each routing key,
`negotiationTransactionRegression.test.ts` turns what the property test and
the pre-review self-review found into deterministic cases, and
`negotiationTransactionDevelopIntegration.test.ts` covers the develop features
below (TURN across a staged ICE restart, SCTP MTU, application codec changes
and m-line reuse during a pending negotiation).
`negotiationTransactionInterrupt.test.ts` runs the interrupt matrix above.
CI replays a fixed seed set plus the seeds that found bugs; a deeper local
search uses `WERIFT_NEGOTIATION_FUZZ_SEEDS`, `WERIFT_NEGOTIATION_FUZZ_STEPS`
and `WERIFT_NEGOTIATION_FUZZ_SEED`, and a failure prints its seed and
operations. Before asking for review, run the deeper searches
(`WERIFT_NEGOTIATION_FUZZ_SEEDS=300 WERIFT_NEGOTIATION_FUZZ_STEPS=20` for the
episode fuzzer, `WERIFT_NEGOTIATION_SCENARIO_SEEDS=300` for the scenario
properties, `WERIFT_NEGOTIATION_MODEL_SEEDS=300` with `-t seed` for the
model property, and the leak property below) — `npm run pbt:deep`
runs all four in parallel vitest processes (`tools/pbt-deep/run.ts`: seed
ranges, `--jobs` defaults to the CPU count, a failure is
replayed alone to tell a load-induced failure from a real one) — and a
self-review that lists every path writing live tables while a description is
pending.
`NEGOTIATION_SPEC_COVERAGE.md` maps every requirement of the ticket to the
tests that verify it.

### Leak property (`tests/pbt/leak`)

`tests/pbt/leak/negotiationLeakProperty.test.ts` checks what the operations
leave behind, with deterministic verdicts (no heap slope in CI). Its Arrange
and measurement are in `leak/leakProbe.ts` (the model property's
`generator.ts`, `oracles.ts` and the harness are reused; `leakProbe.ts`
only wraps them), its fixed scenes and cycles in `leak/scenes.ts`.

| Kind | What leaks | Verdict |
| --- | --- | --- |
| L1 retention after close | an object the scene created stays reachable after both peers closed | after forced GCs (`v8.setFlagsFromString("--expose-gc")` when the process has no `gc`), every `WeakRef` registered during the scene is cleared |
| L2 OS resources after close | a socket, timer or immediate outlives `close()` | `process.getActiveResourcesInfo()` counted by type returns to the count before the scene (polled for 2 s: DTLS / SCTP close asynchronously) |
| L3 growth inside a session | a table, list or subscription grows with every negotiation | `leakFootprint(pc)` after each repetition of a cycle equals its value after the second one |

- P1 (L1, L2): a scene of the model property (fixed in `CLOSED_SCENES`, or
  drawn from a seed with `generateScene`), then `expectSessionContinues`,
  optionally an operation of `CLOSE_TIMING_OPERATIONS` that `close()`
  overtakes after 0..20 microtasks or a macrotask, then the harness closes
  both peers. `LeakTracker` registers every object the peers hold (the peer,
  every transport of `heldTransports` with its ICE transport and agent, SCTP
  and its association, transceivers, senders, receivers, remote tracks,
  DataChannels created or announced, transports the negotiation created)
  after each description operation (the position of `c.observe()`), before
  each operation and after the interrupt; a survivor is reported with its
  kind and the operation it first appeared after. The close-timing matrix
  (`arrangeCloseTimingOperation` x 0 / 2 ticks / macrotask), a close while a
  DTLS handshake waits for its peer and a close during or after a TURN
  allocation are fixed cases of the same check.
- P2 (L3): a cycle of templates from `stable` back to `stable`
  (`CYCLE_TEMPLATES`: re-offer, ICE restart, BUNDLE split and merge,
  pranswer then final answer, replacement offer then rollback, glare, a
  remote DataChannel opened and closed, a transceiver added, stopped and its
  m-line reused, trickle and end-of-candidates) drawn from a seed and
  repeated identically on a connected session (`modelConfig` without STUN
  servers, so no server query's timer moves the counts) under the model
  oracles. After every repetition and once the traffic settled, the metrics
  of `leakFootprint` (transceivers, transports, router tables, ICE
  generations, checklists, candidates and credential history, SCTP channel
  lists, proposal resources, queued candidates, description m-lines and
  candidate lines, `Event` subscriptions of the peer, media, DTLS, ICE, SCTP
  and channels, active timers) must equal their value after the second
  repetition plus the growth the cycle declares.
- P3 (heap, statistical): a P2 cycle repeated 200 times, heapUsed after a
  forced GC judged by `detectLeak` of `tests/memleak`; it runs without the
  oracles' records and the invariants' candidate history (test-side state
  that grows with every cycle). Only `WERIFT_NEGOTIATION_LEAK_HEAP=1`
  (`npm run pbt:deep`) runs it; `npm run memleak` runs the same cycle as the
  `renegotiation` scenario with heap snapshots.

Peers that name no ICE servers use a STUN server in the test process
(`useLocalStunServer`, addressed as `localhost` so a query still resolves a
name) instead of the public default, so no verdict depends on the network.
Besides the continuation and the interrupts, a scene may end closed as it
is (`asIs`: a pending offer or pranswer and its proposal's transports
included).

CI runs the fixed scenes and cycles, `WERIFT_NEGOTIATION_LEAK_SEEDS`
(default 2) seeds of `WERIFT_NEGOTIATION_LEAK_STEPS` (default 8) operations
from `WERIFT_NEGOTIATION_LEAK_SEED` (default 1), and P2 with
`WERIFT_NEGOTIATION_LEAK_CYCLES` (default 4) repetitions, every test
without retry. A failure prints the seed, the scene or cycle, what was not
collected or released and, unless `WERIFT_NEGOTIATION_LEAK_SHRINK=0`, the
smallest failing scene (operations dropped) or cycle (templates dropped).

A surplus `Timeout` is reported with the creation stack of every live timer
(`live timer created at:`, from `async_hooks` in `leakProbe.ts`), so a client's
timer (TURN refresh, retransmission) can be told from the test's own. P2 reads
`process.timers` as the fewest timers over six samples 40 ms apart, because a
transient timer (a STUN retransmission in flight) made the instantaneous count
exceed its bound under heavy parallel load.

### Leak property evidence

`npm run leak:verify -- repeat 10` runs `leak/negotiationLeakProperty.test.ts`
ten times without retry on the active tree; `npm run leak:verify -- inject`
applies six artificial leaks one at a time in a temporary `git worktree`
(`tools/leak-verify/run.sh`) and requires a failure for each. Result at
`af0e8ae5` (only the script, `package.json` and the `doc/_media` copy
uncommitted):

| Artificial leak | Judged by |
| --- | --- |
| ICE `userHistory` keeps every earlier generation | P2 fails |
| a stopped sender subscribes to the DTLS transport | P2 fails |
| a closed DataChannel stays in the SCTP manager's list | P2 fails |
| `RTCDtlsTransport.stop()` does not close a handshake in flight | P1 fails |
| a DTLS flight keeps retransmitting after the socket closed | P1 fails |
| transport-cc records are never pruned | `tests/media/senderBWE.test.ts` fails; the leak cycles carry no RTP, so P1 / P2 do not see it |

Ten consecutive runs: 10 passed, 0 failed (53 passed, 2 skipped each; the two
skipped are the `WERIFT_NEGOTIATION_LEAK_HEAP=1` tests). A first `inject` run
failed to detect two of the six because the injected edit was too small (the
flight timer still aborted through its signal; one pattern matched the wrong
`close()`); the edits in the script are the corrected ones.

State that stays on purpose, and its bound (P2 allows it; anything else must
not change between repetitions):

| State | Bound | Why |
| --- | --- | --- |
| `sdp.seenMid` | grows by one per m-line the application adds (declared by the cycle) | a MID is never reused within the session (RFC 8843); the set is as large as the m-lines ever created |
| `negotiation.retiredRemoteUfrags` | 64 (`RETIRED_UFRAG_HISTORY`) | rejects late callbacks of retired remote generations |
| ICE `userHistory` | current, replaced and staged credentials (3 per agent) | a check the peer sent before applying a restart is still answered |
| ICE `localGenerations` | the latest created offer and answer, and the applied one | applying a created description again restarts to its generation |
| routes of SSRCs a later answer no longer lists, stopped transceivers | the SSRCs and m-lines negotiated (see "Scope and known constraints") | existing since `develop`; the cycles do not change SSRCs |
| active timers | the maximum after the first two repetitions | periodic timers (RTCP, consent, SCTP heartbeat) are counted at an instant; timers after close are judged by L2 |
| sent packets awaiting transport-cc feedback | 5 s and 32768 packets per sender | feedback arrives within a round trip |

In `stable`, the staged and provisional routes, the proposal's resources,
the transports created since the last commit, queued remote candidates and
held candidate events are 0 (`STABLE_ZERO_METRICS`). The TURN server of the
TURN case is a fixture in the same process: the relay socket it keeps for
the client's allocation is not counted, since the client does not delete
its allocation on close (the server keeps it until its lifetime ends).
Harness references that would look like leaks are released or bounded: the
continuation records (`releaseContinuationRecords`), the operation log
(the last 40 operations), and the case and its oracles, which stay inside
the function that runs a scene (a suspended async function keeps its
locals).

What the property found and checked (TICKET 2.4):

| Candidate | Result |
| --- | --- |
| A remote DataChannel stays in `sctpManager.dataChannels` after it closes | leak: removed on close and counted in `dataChannelsClosed` (cycle "a remote DataChannel that closed leaves the SCTP manager's list") |
| `localGenerations` beyond the latest offer / answer | no leak: stays at its bound over ICE restart, replacement and rollback cycles; the agent's `userHistory` grew by two per restart (fixed in `packages/ice`, cycle "an ICE restart keeps the agent's credential history bounded") |
| Discarded proposal transports referenced through `onRtp` subscriptions or closures | a transport only the rollback baseline still bound (a pending offer moved its m-lines into BUNDLE) was not stopped at close, and its ICE agent kept the peer reachable (fixed: `dispose()` stops the baseline's transports, scene "closed while an offer pending on the answerer moved its DataChannel transport into BUNDLE"); a stopped sender kept its `onStateChange` subscription on the BUNDLE transport, also when a rollback bound it again, so every stopped transceiver stayed reachable (fixed, cycles "a stopped sender releases its DTLS transport subscription", "a stopped sender a glare rollback binds again does not subscribe to its transport") |
| Gathering and TURN allocations close overtook | leak: a STUN query whose DNS lookup outlived the socket started after close and retransmitted, and a cancelled transaction never settled (fixed in `packages/ice`, scene "a first negotiation closed while its answer is applied", the close-timing matrix); a TURN allocation close overtook kept its socket and retransmissions until it completed or timed out (fixed in `packages/ice`: `close()` aborts it, case "closing while a TURN allocation waits on a server that never answers"); after that the client releases its socket and refresh timer |
| Staged / provisional router tables after commit or rollback, routes of stopped receivers | no leak: 0 in `stable`, `ssrcTable` steady over the recycling cycle |
| Queued remote candidates and candidate lines over ICE restarts | no leak: steady over the trickle and ICE restart cycles |

Found besides: in-flight connectivity checks of a replaced checklist (a
restart, a completed checklist, a replaced pranswer generation) kept
retransmitting for ~12 s (`packages/ice`: their transactions abort with the
check's handle); a DTLS flight kept retransmitting for ~30 s after its
transport stopped (`packages/dtls`: the flight stops when the socket closes,
and `RTCDtlsTransport.stop()` closes it; fixed case "closing while a DTLS
handshake waits for its peer"); the transport-cc send history of a sender
was never pruned (one entry per RTP packet, found by P3; now 5 s).

### Negotiation cases (`tests/negotiation`)

The negotiation tests live in their own directories; the property tests in
`tests/pbt` have one directory per property test and `shared/` for what they
all use:

| Directory | Contents |
| --- | --- |
| `tests/negotiation/harness/` | the shared infrastructure: `negotiationTransactionUtils.ts` (Arrange helpers, `assertNegotiationInvariants`, snapshots, traffic and continuation checks) and `negotiationCase.ts` (the case harness) |
| `tests/negotiation/cases/` | the cases, one file per area (`negotiationTransaction*.test.ts`: codecs / feedback, events, ICE, transport / BUNDLE, routing, develop features, regressions, matrix, interrupts, close timing) |
| `tests/pbt/shared/` | `random.ts`: the seeded random stream (`seededRandom`) every property test draws from |
| `tests/pbt/fuzz/` | the episode fuzzer: `negotiationTransactionProperty.test.ts` and its episodes (`episodes.ts`) |
| `tests/pbt/scenario/` | the scenario properties: `negotiationScenarioProperty.test.ts` and the scenario text, runner, judgements and generators (`scenarios.ts`) |
| `tests/pbt/model/` | the model property: `negotiationModelProperty.test.ts`, the configuration, operations, generator, runner and shrinking (`generator.ts`), the oracles (`oracles.ts`), the wire rewrites (`wireMutations.ts`) and the fixed scenes (`scenes.ts`) |

A deterministic case is a TypeScript test in Arrange / Act / Assert with
Japanese `// Arrange:` / `// Act:` / `// Assert:` comments, registered with the
harness:

```ts
describeCases("negotiation transaction routing tables", () => {
  negotiationCase.for(ANSWER_OR_ROLLBACK)(
    "an RTX SSRC a re-offer pairs with another media SSRC keeps its current pairing until $finish",
    { ref: "2.4-3 2.4-T4", exempt: "b commits a hand-edited offer that a never applied" },
    async (c, { finish }) => {
      // Arrange: ...
      const { a, b, outgoing, incoming } = await c.given(createConnectedVideoPeersWithRtx());
      const offer = await a.createOffer();
      // Act: ...
      await c.setRemote(b, offer.sdp.split(media).join("999333"));
      // Assert: ...
      expect(pairing()).toEqual(Number(media));
    },
  );
});
```

- `describeCases(title, fn)` is a `describe` that enforces the continuation
  (`enforceSessionContinuation`); `negotiationCase(name, meta, body)` and
  `negotiationCase.for(rows)(name, meta, body)` register one test (per row;
  `$key` in the name is the row's value). `meta.ref` holds the spec IDs of
  `NEGOTIATION_SPEC_COVERAGE.md` and, for a regression, `origin: ...`;
  `meta.exempt` says why the peers do not continue; `meta.explicitInvariants`
  checks the invariants only where the case calls `c.invariants()`.
- `c.given(value)` takes the value of an Arrange helper of
  `negotiationTransactionUtils.ts`: `offerer` / `answerer` become `a` / `b`, a
  duplex session gives `a`, `b`, `aOut`, `bOut`, `aVideo`, `bVideo`,
  `aChannel`, `bChannel` and `session`, and the peers and the value's
  `close()` are closed after the case. A peer the case creates itself is
  registered with `c.peer(pc, name)`; `c.closing(x)` closes anything else.
- Description operations go through `c` so that every one of them is
  followed by `assertNegotiationInvariants` on every open peer:
  `c.setLocal(pc, description | sdp | "rollback")`, `c.setRemote(...)`,
  `c.addCandidate(...)`, and the steps `c.offer(pc, { iceRestart, hold })`
  (createOffer, setLocal, the other peer's setRemote unless `hold`),
  `c.answer` / `c.pranswer`, `c.negotiate`, `c.rollback(pc)` (this peer's
  pending description, then the other's) and `c.finish(pc, "answer" |
  "rollback")`. `{ rejects: "Name" }` (or `"A|B"`, or a message fragment)
  expects the failure and an unchanged `negotiationSnapshot` of the peer.
- Traffic and waits: `c.rtp(out, in)`, `c.data(from, to)`, `c.alive()` (the
  duplex session both ways), `c.waitFor(() => condition, ms)`, `c.sleep(ms)`;
  `c.start(promise)` begins a concurrent operation and `c.rejects(promise,
  "Name")` checks it later. Assertions are plain vitest `expect`.
- After the body the harness runs `expectSessionContinues(a, b)` unless the
  case is exempt, restores mocks and closes everything. A failure names the
  case, its `ref`, the number and text of the last operation and the
  operations before it; vitest adds the expected and actual values.
- `meta.traffic` also checks `c.expectTraffic()` after each description
  operation and after the body; `c.observe(observer)` runs the oracles of a
  property around every description operation; `{ mayReject: true }` lets
  an operation be rejected as long as nothing changes; `c.note(text)` adds a
  step of a generated scene to the operation log.

Expected values are literals or values the case saved before the operation,
never computed by the code under test, and a case keeps the operation
sequence of the regression it records (no split into independent cases).
Tests whose control flow is a matrix stay table-driven: the interrupt
matrix (`negotiationTransactionInterrupt.test.ts`: the interrupt and the
release of the held wait start in one synchronous tick) and the close-timing
matrix (microtask counting). A case uses only descriptions werift creates
itself (an offer under another local policy through `createRewrittenOffer`
included); another implementation's SDP shapes are left to the end-to-end
tests. Helpers several
cases of a file share sit at the top of that file; Arrange helpers belong in
`negotiationTransactionUtils.ts`. The mapping from the earlier procedural
tests is in `NEGOTIATION_CASES_MAPPING.md`.

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
- A local offer's BUNDLE group is a proposal until the peer has accepted
  BUNDLE in the committed session: under max-compat / balanced each member
  keeps its own transport and candidates in the offer, and the answer that
  accepts the group merges them (RFC 8843 section 7.2); an answer without
  BUNDLE keeps them separate. Members share the tag's transport in the offer
  under max-bundle, once the peer bundles, or when they already share it.
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

## develop features inside the transaction

Features merged from `develop` while this design was built run under the same
rules. Each was audited for state it writes while a description is pending
(negotiated state is staged or rolled back, application state survives a
rollback, configuration is not part of the baseline).

- **SCTP MTU (#716).** `sctp.mtu` is configuration. Every SCTP transport,
  including one a pending remote offer creates, is built with it, and moving a
  transport to another DTLS transport keeps it. It cannot change while any SCTP
  transport exists (also a pending one); a rollback that removes the
  proposal's transport makes it changeable again.
- **TURN settings (#688, #731).** ICE server settings (`iceServers`,
  `turnUdpFamily`) are configuration and are not rolled back. A transport that
  has not gathered takes a change at once; one that has gathered keeps its live
  Connection and takes it at its next ICE restart (JSEP 4.1.18), including a
  restart staged before the change. An ICE restart closes the previous TURN
  allocation and allocates anew with the current settings after the commit
  (see "ICE generation boundaries"), so a restart never leaves an unused
  allocation and recovers from a dead one. Settings changed after a restart
  offer that carried end-of-candidates (a transport without ICE servers) wait
  for the next restart.
- **Codec integration (#729).** `setCodecPreferences()` and a track that
  `addTrack()` attaches are application changes: they clear the transceiver's
  resolved codecs for the next offer / answer but never touch the live sender
  or receiver. A change during a pending negotiation survives its rollback (a
  revision counter tells it apart from the baseline). A change between
  `createAnswer()` and applying that answer commits the applied answer's codecs
  and resolves again for the next offer. While a remote offer is pending,
  `replaceTrack()` checks the track source against the codec the answer would
  send with as well as the committed one. The codecs come from the applied answer (or pranswer) itself, never from a later unapplied `createOffer()` or preference change; a first negotiation's pranswer already sends and receives with them. The local answer commits the codecs
  it answered for every live media m-line (sender, receive tables, remote
  track codec, TWCC) and drops the receive values a pending description
  staged, so a codec the answer left out does not come back at the commit.
  The answer matches remote codecs one to one (one remote codec per local
  codec, as #729 introduced) and lists them in the answerer's preference
  order; a remote answer keeps its own order (a merge had lost both).
- **m-line reuse (#721, issue 705).** See the section above. A transceiver the
  application adds during a negotiation that takes over a stopped m-line gives
  that position back on rollback, and a local offer reuses a stopped m-line
  only for a transceiver of the same kind.

Other rules of the transaction:

- A payload type or header extension ID counts as in use only when both
  current descriptions carry it for the m-line; what an offer listed but the
  answer did not accept may be offered again with another value.
- `close()` stops every transport only the negotiation holds (created for a
  proposal, pending-only, BUNDLE owners, prepared), also after a provisional
  connection. `"closed"` is final: a description operation that `close()`
  overtook is rejected with `InvalidStateError` and does not move the state.
- A first answer whose m-lines carry the answering server's own MIDs (issue
  #142, `0_srtp` for the offered `0`) is paired with the offer by position
  (RFC 3264): an m-line of the offered kind takes the offered MID and its
  BUNDLE entries follow. Once a session exists an answer MID must equal the
  offered one (RFC 8843).
- An answer's `a=setup:actpass` (invalid per RFC 5763 section 5) keeps the
  role of a live DTLS association; a new association becomes client.
- Negotiation state types and helpers live in `src/negotiation/internalState.ts`
  and are not exported by the package.

## Rejected application m-lines

The position of the application m-line (MID, index, rejected or not) is
recorded by the current description, not by the SCTP transport object, so it
outlives the transport:

- `createOffer` keeps an application m-line of the current description that
  has no SCTP transport as a rejected (port 0) m-line with the same MID. An
  SCTP transport bound to that MID offers it again (port 9, as in develop).
  An unbound SCTP transport (`createDataChannel` on a peer that has none)
  takes a rejected position with a new MID, like a transceiver reusing a
  stopped position of its kind; on a position no side rejected it takes that
  MID.
- Rejection never closes the SCTP transport, whichever way it arrives (the
  peer's answer, the peer's offer, a pranswer and its final answer, initial
  or renegotiation), and the commit does not move it to a transport the
  answer did not negotiate for it.
- An answer to an offer whose application m-line has port 0 has port 0 (RFC
  3264 section 6), also without an SCTP transport.
- An offer that reuses the rejected application position with a new MID
  moves the SCTP transport to that MID (restored by rollback). A position
  with port 0 in either current description may take a new MID in the next
  offer or answer (audio and video too).
- An SCTP transport that joins an already connected DTLS transport (the first
  application m-line of a renegotiation) starts its association there; the
  channel IDs follow the DTLS start's ICE role even if the peer's INIT
  established the association first.
- Rolling back a remote offer stops the DTLS transport the offer's SCTP
  transport ran on unless something else uses it.
- The renomination path kept from develop (new remote credentials while an
  m-line is `inactive`) keeps the checklist but drops the remote candidates
  and pairs that name another remote ufrag (`dropOtherRemoteGenerations` in
  the ICE layer); candidates without a ufrag stay, as in develop.

The rejection paths were covered by `negotiationTransactionApplicationRejection.test.ts`,
which built the rejecting peer's description by hand; it was removed in
TICKET 2.20 (browser interoperability is the end-to-end tests'
responsibility), so these rules have no individual test now.

## Operation chain, connection start and the reviewer's axes

- **Operation chain** (`enqueueDescriptionOperation`, W3C "chain an
  operation"): registering on a closed connection rejects at once; an
  operation that `close()` overtook while it waited for the previous one, or
  while it ran, rejects with `InvalidStateError` when it resumes. Every
  promise settles (W3C would leave an overtaken one pending; werift settles
  it). Each operation exposes an "applied" point next to "done":
  `setLocalDescription` marks it before its gathering wait, and
  `addIceCandidate` waits only for the previous operation's applied point
  (as develop, it does not wait for gathering); later operations wait for
  both. ICE gathering stops waiting when its agent closes.
- **Connection start**: `connect()` starts only transports an applied
  description gave the peer's ICE and DTLS parameters; one whose parameters a
  renegotiation pranswer staged for the final answer starts after it.
  `connectPending()` (the provisional transports of a pranswer) follows the
  same rules: checks start once per generation, running ones are awaited,
  an established generation is not checked again, and a DTLS handshake starts
  once (a pranswer applied again changes nothing). Stopping an ICE transport
  settles whoever awaits its checks.
- **Rollback of remote-created transceivers**: kept (unassociated) only when
  the sender has a track, as develop; an application `stop()`, direction or
  codec preferences do not keep it. A transceiver the application added during
  the transaction and no description negotiated loses the MID and m-line the
  rolled-back offer gave it, also after a replacement offer (W3C).
- **Remote generation**: a remote-only ICE restart advances a separate
  `remoteGeneration` (remote-side mDNS, end-of-candidates, consent,
  nomination); the local gathering of the current generation continues. A
  nominated pair is selected when it is in the current checklist and its
  remote candidate names the live remote ufrag (if it names one); the SDP
  `generation` attribute counts the peer's own restarts and is not compared
  with the local generation.
- **Simulcast RID routing**: MID+RID first, then RID alone when the packet's
  MID names no route (as develop).
- **Differential runner axes**: `run.ts` draws a configuration per seed
  (bundlePolicy, rtcpMuxPolicy, relay-only over a local TURN server),
  application operations (stop, replaceTrack, direction,
  setCodecPreferences, createDataChannel, restartIce) and `closeDuring`
  (close() 0..8 microtasks or one macrotask into an operation), besides the
  peer mutations. `compare.ts` also checks HEAD alone: no unsettled
  operation, no `failed` connection state without an injected fault, and the
  same transceivers as develop after the same operation and outcome. Two
  compositions the random sequence rarely reaches run from stable peers:
  `pranswerRound` (a new m-line held under a pranswer, then the final answer)
  and `remoteOfferAppOpRollback` (the peer's offer, an application operation
  on the transceiver it created, rollback on both sides); `--ops` replays a
  fixed list. The intended differences in the table below are counted, not
  failed: a transceiver an unapplied offer did not associate is compared by
  kind and direction, MID values may differ (HEAD's must be unique; the RTP
  result of a track is matched through the transceiver at the same position,
  not by MID), a record
  where develop gave one MID to two transceivers is develop's defect, and a
  closed peer's transceivers are not compared.
  `negotiationTransactionCloseTiming.test.ts` runs the close timing for ten
  operations in CI.

## Behavior differences from develop

Every rule of 2.6 to 2.10 that makes werift behave differently from
`develop`, whether the core invariant (a pending description never breaks
the current session) or W3C / RFC needs it, and what was done. New fixes add
no behavior difference unless they pass `expectSessionContinues`.

| Rule | develop | Needed for | Decision |
| --- | --- | --- | --- |
| A rejected application m-line closes SCTP and removes `sctpTransport` (2.10) | keeps SCTP, offers it again | nothing in the core invariant (W3C only) | back to develop |
| ICE restart staged until the answer, provisional generation (2.2, 2.7, 2.8) | `createOffer` restarts ICE | core: a pending offer must not change the current ICE generation | kept |
| Pranswer effective values: send codec, direction, max-message-size (2.10) | pranswer barely applied | pranswer contract (2.2), W3C max-message-size | kept |
| Reject a remap of an extmap ID in use, a role / fingerprint change of a connected DTLS association, a port change or move of a connected SCTP association (2.4, 2.8, 2.10) | no such check (whether it then breaks was not measured in this round) | core | kept |
| Reject a new MID on the m-line of a transceiver that is not stopped (2.10) | no such check (not measured in this round) | core | kept |
| Validation of MIDs, BUNDLE groups, SCTP port, codecs before any mutation (2.1) | these errors do not exist in develop | W3C `setRemoteDescription` / `setLocalDescription` and atomic rejection | kept |
| Last created offer / answer reuse contract (2.9) | offers matched loosely | W3C `[[LastCreatedOffer]]`; develop differences kept at 0 by the differential runner | kept |
| #142 first-answer MID alignment (2.8) | accepted | develop compatibility | kept (same result as develop) |
| max-compat BUNDLE stays a proposal until accepted (2.8) | shared at the offer | interop with non-BUNDLE peers (RFC 8843 section 7.2) | kept |
| New remote credentials in an answer restart the remote generation (2.10) | not measured | interop (Chrome behaves the same) | kept |
| Answer port 0 to a rejected application offer (2.11) | port 9 without `a=sctp-port` | RFC 3264; HEAD validates `a=sctp-port` | added, passes the helper |
| SCTP starts on an already connected DTLS transport (2.11) | DataChannel never opens | makes a develop failure work | added, passes the helper |
| SCTP side from the ICE role at the DTLS start (2.11) | ICE role at the SCTP start | consistent sides when SCTP starts late | added, same side as develop in a normal flow |
| Overtaken operations settle with InvalidStateError (2.12) | some stay pending forever | an application awaiting them is never stuck | added (W3C leaves them pending; those WPT cases were already failing) |
| addIceCandidate waits only for the applied description (2.12) | not chained | develop latency; still ordered before later descriptions | restores develop behavior |
| An unapplied createOffer() does not associate MIDs; the description that is applied does (2.9, found again by the 2.12 runner) | assigns the MID at createOffer() | W3C (a MID is associated when a description is set); develop can hand the same MID to two transceivers (an unapplied offer's and the next one's) and then stop the new m-line | kept (intended difference; the runner counts it and stops comparing that seed's states) |
| A pending remote offer does not switch the current send codec, and rollback restores it (2.2, found again by the 2.12 runner) | switches the send codec when the remote offer is applied and keeps it after rollback | core invariant; develop's later success with a stale answer whose codec the offer did not list depends on that leak | kept (intended difference) |
| Renomination drops remote candidates naming another ufrag (2.11) | keeps them in the checklist | ICE generation consistency (they cannot pass checks with the new credentials) | added, ufrag-less candidates unchanged |
| An SCTP transport whose MID only an unapplied createOffer reserved takes the MID of the peer's offer (2.17) | answers the application with the reserved MID, repeating a MID of the offer | W3C (the answerer uses the offer's MIDs); HEAD validates unique MIDs | added, passes the helper (found by the model property) |
| An answer rejects (port 0) an m-line it can give no codec, e.g. a stopping transceiver whose codec preferences were just set (2.17) | sends an m-line without formats, which it then cannot parse | JSEP 5.3.1 | added, passes the helper (found by the model property) |
| PLI only with `nack pli` negotiated (2.19) | sends PLI for any `nack` feedback | RFC 4585 (`nack` and `nack pli` are different feedback) | added, passes the helper (found by the model property) |
| A refresh of an applied local description keeps the credentials it applied (2.19) | rewrites the current description with the BUNDLE tag's credentials at end-of-candidates | W3C (the current description changes only at a negotiation) | added, passes the helper (found by the model property) |
| A MID only an unapplied createOffer reserved is released at the answer (2.19) | stops the transceiver as rejected (the peer's next m-line with that MID is answered with port 0); keeps the SCTP MID, which collides | W3C (a MID is associated when a description is set) | added, passes the helper (found by the model property; the differential runner counts the stopped-in-develop transceiver as the intended deferred MID) |
| RTX pairs with its primary codec whatever the order of the codecs (2.19) | no RTX pairing when RTX precedes its primary codec | RFC 4588 (the order is a preference) | added, passes the helper (found by the model property) |
| A remote DataChannel that closed leaves `getStats` and counts in `dataChannelsClosed` (leak property) | stays in the data-channel stats forever, never counted as closed | W3C `dataChannelsClosed`; L3 (no growth per remote channel) | added, passes the helper (found by the leak property) |
| A cancelled connectivity check (restart, completed or replaced checklist, close) stops retransmitting and leaves its pair's state as it was; a STUN request whose lookup ends after close fails with `TransactionCancelled` | keeps retransmitting, then marks the pair failed | L2 (no timer of a discarded generation), RFC 8445 (cease retransmissions of cancelled checks) | added, passes the helper (found by the leak property) |
| The ICE agent answers checks for its current, replaced and staged credentials only | answers every generation's credentials since the agent started | L3 (no growth per restart) | added, passes the helper (found by the leak property) |
| `RTCDtlsTransport.stop()` closes the DTLS socket and a running handshake stops retransmitting | the flight retransmits ~30 s after stop | L1 / L2 | added, passes the helper (found by the leak property) |
| `close()` aborts a TURN allocation still running (its client and socket close at once, no TCP fallback) | the allocation completes (or times out) after close, then closes | L1 / L2 | added, passes the helper (found by the leak property) |

## Scope and known constraints

The transition table, the mutation matrix and the property test's operation
catalog define what this design guarantees. A new combination outside them
(another subsystem, operation or interop target) is handled as a follow-up,
not as a change of this contract. Known constraints:

- Interoperability is verified with Chrome only.
- Reusing created descriptions is guaranteed only for the orders in the
  description reuse contract table; another order is a follow-up.
- A rejected application m-line keeps the SCTP transport and its channels
  (as in `develop`); W3C would set `sctpTransport` to null. The next offer
  offers the application again with the same MID.
- A peer running `develop` answers an offer whose application m-line is
  rejected with port 9 and no `a=sctp-port`; HEAD rejects that answer
  (`OperationError`, no state change). HEAD answers such an offer with port 0.
- werift sets the ICE role at every offer / answer (existing since
  `develop`). SCTP takes its client / server side from the ICE role when the
  DTLS transport started, so a later association start agrees with the peer.
- The header extension ID map is shared by the whole PeerConnection. m-lines
  on separate (non-BUNDLE) transports that map one ID to different URIs are
  not supported; only a remap of an ID the current session uses is rejected.
- A remote offer may associate an unassociated transceiver the application
  created with `addTransceiver` (W3C reuses only `addTrack` ones); this is
  existing werift behavior.
- The ICE layer drops the old selected pair when a restart commits; RTP pauses
  until the new generation nominates a pair.
- Changing only `iceTransportPolicy` with `setConfiguration` does not reach an
  existing ICE transport (existing since `develop`). A TURN allocation that
  completes after `close()` releases the client's socket and refresh timer,
  but the client does not delete the allocation on the server (no Refresh
  with lifetime 0): the server keeps it until its lifetime ends (existing
  since `develop`).
- With STUN or TURN servers a restart's relay candidate and end-of-candidates
  follow the commit; a relay-only session has no candidate of the new
  generation until the new allocation completes.
- A restart's connectivity checks keep waiting for candidates until both the
  peer's end-of-candidates and the local gathering of the generation have
  ended; a TURN allocation that completes meanwhile pairs with the remote
  candidates already known. So a relay-only restart whose peer finished
  first still nominates once its own allocation completes.
- `setCodecPreferences()` only marks the transceiver for re-resolution.
  `createAnswer` resolves the answer's codecs onto the transceiver (the
  proposal); the sender, receiver codec / RTX tables, TWCC and remote track
  codec follow at the local answer commit, so RTP of the current session is
  never decoded with a codec the pending answer only proposes. Rollback
  restores the proposal and the re-resolution flag from the baseline unless
  the application changed the codecs during the negotiation (see "develop
  features" below).
- A transceiver displaced by m-line recycling is marked stopped when the
  recycling offer is applied (its current m-line is already rejected, so no
  current traffic uses it); rollback restores it.
- `createOffer` fills empty codec and header extension lists of a transceiver;
  these are defaults, not negotiated state, and stay after an unapplied offer.
- A remote SSRC of the current session that a later answer no longer lists
  stays routed, and a receiver keeps one track per SSRC it was given across
  committed renegotiations (existing since `develop`). Only SSRCs a replaced
  pranswer alone announced are dropped, and their track is reused.
- An answer or pranswer that changes the remote ICE credentials of a
  transport whose generation the offer did not restart restarts the checks for
  the new remote generation and keeps the local credentials (as Chrome does);
  the session continues once the new pair is nominated.
- A transport-cc feedback packet without padding is serialized with an RTCP
  length one word short in `packages/rtp`, so the peer cannot parse it
  (existing since `develop`, outside negotiation; tests observe that the
  feedback is sent).
- The peer-diversity mutations and the develop differential runner exercise
  werift on both ends; other implementations are covered only as far as the
  mutations model them.
