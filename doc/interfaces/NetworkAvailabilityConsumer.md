[**werift**](../README.md)

***

[werift](../globals.md) / NetworkAvailabilityConsumer

# Interface: NetworkAvailabilityConsumer

Optional pin `OnNetworkAvailability` consumer.

Not part of the common [BandwidthEstimator](BandwidthEstimator.md) contract. Initial
exponential probing must not start until the transport can actually send.

## Methods

### setNetworkAvailable()

> **setNetworkAvailable**(`available`): `void`

True when ICE/DTLS (or equivalent) can emit RTP.

#### Parameters

##### available

`boolean`

#### Returns

`void`
