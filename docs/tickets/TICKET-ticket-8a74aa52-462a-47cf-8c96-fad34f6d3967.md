Found while fixing ticket 340fdd75.

packages/webrtc/src/transport/sctp.ts dataChannelOpen() writes channel.label.length / channel.protocol.length (UTF-16 code units) into the Label Length / Protocol Length fields, but appends Buffer.from(label, 'utf8'). For a non-ASCII label (e.g. '日本語') the lengths do not match the bytes, so the remote parses a truncated label and the wrong protocol.

Expected: use Buffer.byteLength(..., 'utf8') (RFC 8832 5.1). Add a round-trip test with a multibyte label and protocol.