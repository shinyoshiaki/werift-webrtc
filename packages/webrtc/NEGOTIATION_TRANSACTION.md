# PeerConnection negotiation transaction

## Invariant and ownership

The last pair of descriptions that reached `stable` is **current**. Its RTP
routes, BUNDLE owner, ICE selected pair, DTLS session and SCTP association
remain usable while another negotiation is pending. Packet driven counters,
consent timers and retransmission state belong to the live transport and are
never copied into an SDP snapshot.

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
| begin | stable or first offer | Capture baseline once; assign transaction ID and revision. No current transport is stopped. |
| replace/update | active transaction | Retire old pending-only resources and candidate buckets. Keep baseline and emitted-event history. A byte-identical description is idempotent. |
| validate | parsed proposal | Check signaling transition, unique MID, m-line order and reuse, BUNDLE membership and tag, codec/rejection, ICE credentials, DTLS role/fingerprint and SCTP port before live mutation. Failure leaves previous pending revision and current untouched. |
| prepare | validated proposal | Allocate any new transport and media objects under pending ownership; prepare may fail and must clean only the newly allocated objects. |
| commit | validated final answer and successful prepare | Switch BUNDLE routing, ICE generation, DTLS parameters, SCTP binding and RTP/router, then publish the current descriptions and `stable`. No fallible validation is allowed after the switch. Start remaining asynchronous connect work and report later failures on that generation. |
| cleanup | commit or rollback finished | Stop orphan pending resources; keep only current ownership and event deduplication needed for future revisions. |
| rollback | active pending transaction | Stop provisional communication, discard pending candidates/EOC and resources, restore the first baseline and publish `stable`. Already delivered events remain delivered. |

The ordered operations are `begin → replace/update → validate → prepare →
commit → cleanup` or `begin → … → rollback → cleanup`. A synchronous failure
before commit leaves the previously published current and pending descriptions
and live session intact. A failed asynchronous ICE check or DTLS/SCTP handshake
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
| ICE restart commit/rollback | C routes until K/R | C owner until K/R | P credentials, checklist and pair; K switches or R drops | P handshake while C remains live | C association remains live during P | P ufrag distinct from C | Candidates labeled by generation |
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

A BUNDLE split prepares a separate ICE/DTLS transport for its new owner while
the previously shared transport stays connected. This also applies to a local
offer whose BUNDLE group was changed before `setLocalDescription`; the pending
local SDP is refreshed with the new owner's own ICE credentials and candidates.

For pranswer, non-`inactive` agreed m-lines may send and receive RTP/RTCP.
Pending ICE may gather, check and nominate; DTLS may start after ICE; a new
SCTP association and DCEP may become active. Existing RTP routes, selected
pair, DTLS and SCTP remain available alongside them. The final answer is
validated afresh and can differ from every earlier pranswer. Replaced or
rolled-back provisional resources are stopped. Existing DataChannels stay on
their committed association; channels opened on a pending-only association
close when it is discarded. Application-created unattached channels remain
application objects for a later negotiation.

When a re-offer changes ICE credentials, a separate pending ICE/DTLS transport
gathers candidates and runs checks during pranswer. Its candidate and EOC
bucket is selected by the pending ufrag. The committed transport remains bound
to existing media until final answer; rollback stops the pending transport.
For an established SCTP association, the existing ICE transport stages restart
credentials so DataChannels remain on their current DTLS association; the
final answer activates those credentials on that transport.

Trickle with an explicit `usernameFragment` targets the matching current or
pending remote generation; without one it targets the latest applicable
generation. MID takes precedence over m-line index. Null or empty candidate
is EOC for the selected sections. Pre-SRD buffering remains the public werift
behavior. Candidate and EOC mutations are idempotent within a generation; an
old-generation callback may update only that generation and cannot be carried
into a replacement generation. Upstream WPT-only stricter behavior belongs in
`tools/wpt-runner` wrappers.
