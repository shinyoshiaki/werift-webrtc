[**werift**](../README.md)

***

[werift](../globals.md) / RTCIceTransport

# Class: RTCIceTransport

ICE generations of one transport. An ICE restart (new ufrag/pwd without a
BUNDLE topology change) keeps the transport, its sockets and its DTLS
association: no role renegotiation, no second handshake (RFC 8842, JSEP).
Only a BUNDLE owner change creates a separate pending transport.

Restart generations are registered by ufrag (`localGenerationFor`): the
latest created offer and the latest created answer each keep theirs until a
newer description of the same kind replaces it, whatever is applied, rolled
back or committed meanwhile. Applying a description selects the generation
its SDP carries, and the final answer switches exactly that one. A new offer
reuses the applied pending offer's generation (JSEP 5.2.1) unless
`restartIce()` asked to replace it; an answer created again reuses the
earlier answer's (JSEP 5.3.1).

Provisional generation: while a restart of an established transport is
negotiated, a second checklist runs beside the live one on the same sockets.
It only exchanges STUN checks; RTP and DataChannel stay on the live selected
pair, and it follows the live checklist's rules (pair filter, ICE-lite,
nomination, staged-password error responses).

- Created when the restart credentials are staged (`stageLocalRestart`): by
  `createOffer()` while a `restartIce()` request stands, or by
  `createAnswer()` for a remote offer that changes a live transport's ufrag.
  It then answers checks for that ufrag.
- Fed by the pranswer with the peer's credentials, candidates and
  end-of-candidates (`setProvisionalRemoteParams`,
  `addProvisionalRemoteCandidate`); a replacement pranswer restarts it.
- Checks start when the pranswer is applied (`startProvisionalChecks`); the
  controlling side nominates a provisional pair, but the live selected pair
  and send target never change. A response for an earlier checklist is
  ignored.
- Ends at the final answer, which recreates the live agent with the staged
  credentials and checks the answered generation from scratch, or at
  rollback / a replacement offer / selecting another generation, which
  stops its checks and keeps the live generation.

A first negotiation and transports created for a proposal have no
provisional generation; they connect normally from the pranswer. The
staged-credential methods of `IceConnection` are optional: without them a
restart still happens at the final answer, without provisional checks.

A restart generation's candidates are fixed when its description is
created (host candidates of the kept sockets and their server-reflexive
addresses) and are re-advertised at the commit without waiting. With STUN
or TURN servers the description carries neither the relay candidate nor
end-of-candidates: after the commit the generation gathers again (a new TURN
allocation replaces and closes the previous one) and trickles them. A
restart's background gathering that a later restart or `close()` replaced
signals nothing more. ICE server settings changed after gathering take
effect at the next restart (JSEP 4.1.18). The old selected pair is dropped
at the commit, so RTP pauses until the new generation nominates.

## Constructors

### Constructor

> **new RTCIceTransport**(`iceGather`): `RTCIceTransport`

#### Parameters

##### iceGather

[`RTCIceGatherer`](RTCIceGatherer.md)

#### Returns

`RTCIceTransport`

## Properties

### component

> `readonly` **component**: `"rtp"` = `"rtp"`

***

### connection

> **connection**: [`IceConnection`](../interfaces/IceConnection.md)

***

### iceRestarts

> **iceRestarts**: `number` = `0`

***

### id

> `readonly` **id**: `string`

***

### ongatheringstatechange?

> `optional` **ongatheringstatechange?**: () => `void`

#### Returns

`void`

***

### onIceCandidate

> `readonly` **onIceCandidate**: [`Event`](Event.md)\<\[[`IceCandidate`](IceCandidate.md) \| `undefined`\]\>

***

### onNegotiationNeeded

> `readonly` **onNegotiationNeeded**: [`Event`](Event.md)\<\[\]\>

***

### onstatechange?

> `optional` **onstatechange?**: () => `void`

#### Returns

`void`

***

### onStateChange

> `readonly` **onStateChange**: [`Event`](Event.md)\<\[`"closed"` \| `"new"` \| `"connected"` \| `"disconnected"` \| `"completed"` \| `"failed"` \| `"checking"`\]\>

***

### state

> **state**: `"closed"` \| `"new"` \| `"connected"` \| `"disconnected"` \| `"completed"` \| `"failed"` \| `"checking"` = `"new"`

## Accessors

### gatheringState

#### Get Signature

> **get** **gatheringState**(): `"complete"` \| `"new"` \| `"gathering"`

##### Returns

`"complete"` \| `"new"` \| `"gathering"`

***

### hasStagedRestart

#### Get Signature

> **get** **hasStagedRestart**(): `boolean`

##### Returns

`boolean`

***

### localCandidates

#### Get Signature

> **get** **localCandidates**(): [`IceCandidate`](IceCandidate.md)[]

##### Returns

[`IceCandidate`](IceCandidate.md)[]

***

### localCandidatesComplete

#### Get Signature

> **get** **localCandidatesComplete**(): `boolean`

Whether the local description may carry `a=end-of-candidates`.

##### Returns

`boolean`

***

### localParameters

#### Get Signature

> **get** **localParameters**(): [`RTCIceParameters`](RTCIceParameters.md)

##### Returns

[`RTCIceParameters`](RTCIceParameters.md)

***

### role

#### Get Signature

> **get** **role**(): `"unknown"` \| `"controlling"` \| `"controlled"`

##### Returns

`"unknown"` \| `"controlling"` \| `"controlled"`

## Methods

### addEventListener()

> **addEventListener**(`type`, `listener`, `options?`): `void`

#### Parameters

##### type

`string`

##### listener

(...`args`) => `void`

##### options?

`boolean` \| \{ `once?`: `boolean`; \}

#### Returns

`void`

***

### addProvisionalRemoteCandidate()

> **addProvisionalRemoteCandidate**(`candidate?`): `Promise`\<`void`\> \| `undefined`

#### Parameters

##### candidate?

[`IceCandidate`](IceCandidate.md)

#### Returns

`Promise`\<`void`\> \| `undefined`

***

### addRemoteCandidate()

> **addRemoteCandidate**(`candidate?`): `Promise`\<`void`\> \| `undefined`

#### Parameters

##### candidate?

[`IceCandidate`](IceCandidate.md)

#### Returns

`Promise`\<`void`\> \| `undefined`

***

### commitLocalRestartIfStaged()

> **commitLocalRestartIfStaged**(): `Promise`\<`void`\>

Called unconditionally on every answer; actually restarts ICE only if
this transport has a staged local restart. No-op otherwise.

#### Returns

`Promise`\<`void`\>

***

### deferIceServers()

> **deferIceServers**(`options`): `void`

Keep ICE servers for the next gathering (an ICE restart).

#### Parameters

##### options

`Partial`\<[`IceOptions`](../interfaces/IceOptions.md)\>

#### Returns

`void`

***

### deliverProvisionalRemoteCandidate()

> **deliverProvisionalRemoteCandidate**(`candidate?`): `void`

`deliverRemoteCandidate` for the provisional (pranswer) generation.

#### Parameters

##### candidate?

[`IceCandidate`](IceCandidate.md)

#### Returns

`void`

***

### deliverRemoteCandidate()

> **deliverRemoteCandidate**(`candidate?`): `void`

Hand a remote candidate (`undefined`: end-of-candidates) to the ICE agent
without waiting for it. A host candidate is added synchronously; an mDNS
name may take seconds to resolve, and the agent itself orders that
resolution against end-of-candidates and generation changes, so the
description operation queue must not wait for it.

#### Parameters

##### candidate?

[`IceCandidate`](IceCandidate.md)

#### Returns

`void`

***

### discardUnappliedLocalRestart()

> **discardUnappliedLocalRestart**(): `void`

Drop only what an unapplied createOffer staged; keep the applied one.

#### Returns

`void`

***

### dispatchEvent()

> **dispatchEvent**(`event`): `boolean`

#### Parameters

##### event

`Event`

#### Returns

`boolean`

***

### emitCommittedCandidates()

> **emitCommittedCandidates**(): `void`

Signal the candidates an ICE restart committed by a local answer gathered.

#### Returns

`void`

***

### emitStagedCandidates()

> **emitStagedCandidates**(): `void`

#### Returns

`void`

***

### gather()

> **gather**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### getLocalCandidates()

> **getLocalCandidates**(): [`RTCIceCandidate`](RTCIceCandidate.md)[]

#### Returns

[`RTCIceCandidate`](RTCIceCandidate.md)[]

***

### getLocalParameters()

> **getLocalParameters**(): [`RTCIceParameters`](RTCIceParameters.md)

#### Returns

[`RTCIceParameters`](RTCIceParameters.md)

***

### getRemoteCandidates()

> **getRemoteCandidates**(): [`RTCIceCandidate`](RTCIceCandidate.md)[]

#### Returns

[`RTCIceCandidate`](RTCIceCandidate.md)[]

***

### getRemoteParameters()

> **getRemoteParameters**(): [`RTCIceParameters`](RTCIceParameters.md) \| `null`

#### Returns

[`RTCIceParameters`](RTCIceParameters.md) \| `null`

***

### getSelectedCandidatePair()

> **getSelectedCandidatePair**(): \{ `local`: [`RTCIceCandidate`](RTCIceCandidate.md); `remote`: [`RTCIceCandidate`](RTCIceCandidate.md); \} \| `null`

#### Returns

\{ `local`: [`RTCIceCandidate`](RTCIceCandidate.md); `remote`: [`RTCIceCandidate`](RTCIceCandidate.md); \} \| `null`

***

### getStats()

> **getStats**(`timestamp?`, `transportId?`): `Promise`\<[`RTCStats`](../interfaces/RTCStats.md)[]\>

#### Parameters

##### timestamp?

`number` = `...`

##### transportId?

`string` = `...`

#### Returns

`Promise`\<[`RTCStats`](../interfaces/RTCStats.md)[]\>

***

### markLocalRestartApplied()

> **markLocalRestartApplied**(): `void`

The staged generation now belongs to an applied description.

#### Returns

`void`

***

### removeEventListener()

> **removeEventListener**(`type`, `listener`): `void`

#### Parameters

##### type

`string`

##### listener

(...`args`) => `void`

#### Returns

`void`

***

### resetRemoteGeneration()

> **resetRemoteGeneration**(): `void`

Internal: drop the remote generation and its checks, keeping the local
credentials and candidates a description already carries (a remote-only
restart, or a proposal transport a replacement pranswer left unused).

#### Returns

`void`

***

### restart()

> **restart**(`notifyNegotiation?`, `applyNextGatherIceServers?`): `void`

#### Parameters

##### notifyNegotiation?

`boolean` = `true`

##### applyNextGatherIceServers?

`boolean` = `true`

#### Returns

`void`

***

### rollbackLocalRestart()

> **rollbackLocalRestart**(): `void`

#### Returns

`void`

***

### setIceServers()

> **setIceServers**(`options`): `void`

#### Parameters

##### options

`Partial`\<[`IceOptions`](../interfaces/IceOptions.md)\>

#### Returns

`void`

***

### setProvisionalRemoteParams()

> **setProvisionalRemoteParams**(`remoteParameters`): `void`

Feed a pranswer's ICE generation to the provisional checklist.

#### Parameters

##### remoteParameters

[`RTCIceParameters`](RTCIceParameters.md)

#### Returns

`void`

***

### setRemoteParams()

> **setRemoteParams**(`remoteParameters`, `renomination?`, `__namedParameters?`): `void`

`keepLocalCredentials`: the remote credentials come from an answer or
pranswer, so the local ones are fixed by the applied local offer. Changed
remote credentials restart the checks for the new remote generation
without new local credentials (nothing would describe them to the peer).

#### Parameters

##### remoteParameters

[`RTCIceParameters`](RTCIceParameters.md)

##### renomination?

`boolean` = `false`

##### \_\_namedParameters?

###### keepLocalCredentials?

`boolean` = `false`

#### Returns

`void`

***

### stageLocalRestart()

> **stageLocalRestart**(`__namedParameters?`): `void`

Prepare an ICE generation for SDP without touching the selected pair.
`answering` is the remote offer an answer is created for.

#### Parameters

##### \_\_namedParameters?

###### answering?

`object`

###### replacing?

`ReadonlySet`\<`string`\>

Credentials restartIce() asked to replace (W3C [[LocalIceCredentialsToReplace]]).

#### Returns

`void`

***

### start()

> **start**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### startProvisionalChecks()

> **startProvisionalChecks**(): `void`

#### Returns

`void`

***

### stop()

> **stop**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>
