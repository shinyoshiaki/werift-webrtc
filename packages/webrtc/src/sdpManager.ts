import { DISCARD_HOST, DISCARD_PORT } from "./const";
import { createWebRtcDomException } from "./errors";
import type { RTCRtpTransceiver } from "./media";
import {
  type RTCRtpCodecParameters,
  RTCRtpSimulcastParameters,
} from "./media/parameters";
import type { MediaDirection } from "./media/rtpTransceiver";
import {
  type BundlePolicy,
  GroupDescription,
  MediaDescription,
  SessionDescription,
  SsrcDescription,
  addSDPHeader,
  codecParametersFromString,
} from "./sdp";
import type { RTCDtlsTransport } from "./transport/dtls";
import type { RTCSctpTransport } from "./transport/sctp";
import { andDirection } from "./utils";

export class SDPManager {
  currentLocalDescription?: SessionDescription;
  currentRemoteDescription?: SessionDescription;
  pendingLocalDescription?: SessionDescription;
  pendingRemoteDescription?: SessionDescription;
  readonly cname: string;
  readonly midSuffix: boolean;
  readonly bundlePolicy?: BundlePolicy;
  readonly mLineReuse: MLineReuse;

  private seenMid = new Set<string>();

  constructor({
    cname,
    midSuffix,
    bundlePolicy,
    mLineReuse,
  }: {
    cname: string;
    midSuffix?: boolean;
    bundlePolicy?: BundlePolicy;
    mLineReuse?: MLineReuse;
  }) {
    this.cname = cname;
    this.midSuffix = midSuffix ?? false;
    this.bundlePolicy = bundlePolicy;
    this.mLineReuse = mLineReuse ?? "compatible";
  }

  get localDescription() {
    if (!this._localDescription) {
      return undefined;
    }
    return this._localDescription.toJSON();
  }

  get remoteDescription() {
    if (!this._remoteDescription) {
      return undefined;
    }
    return this._remoteDescription.toJSON();
  }

  /**@private */
  get _localDescription() {
    return this.pendingLocalDescription || this.currentLocalDescription;
  }

  /**@private */
  get _remoteDescription() {
    return this.pendingRemoteDescription || this.currentRemoteDescription;
  }

  get inactiveRemoteMedia() {
    return this._remoteDescription?.media?.find?.(
      (m) => m.direction === "inactive",
    );
  }

  /**
   * MediaDescriptionをトランシーバー用に作成
   */
  createMediaDescriptionForTransceiver(
    transceiver: RTCRtpTransceiver,
    direction: MediaDirection,
  ): MediaDescription {
    const media = new MediaDescription(
      transceiver.kind,
      9,
      "UDP/TLS/RTP/SAVPF",
      transceiver.codecs.map((c) => c.payloadType),
    );
    media.direction = direction;
    media.msids = transceiver.msids;
    media.rtp = {
      codecs: transceiver.codecs,
      headerExtensions: transceiver.headerExtensions,
      muxId: transceiver.mid ?? undefined,
    };
    media.rtcpHost = "0.0.0.0";
    media.rtcpPort = 9;
    media.rtcpMux = true;

    media.ssrc = [
      new SsrcDescription({ ssrc: transceiver.sender.ssrc, cname: this.cname }),
    ];

    if (transceiver.options.simulcast) {
      media.simulcastParameters = transceiver.options.simulcast.map(
        (o) => new RTCRtpSimulcastParameters(o),
      );
    }

    if (media.rtp.codecs.find((c) => c.name.toLowerCase() === "rtx")) {
      media.ssrc.push(
        new SsrcDescription({
          ssrc: transceiver.sender.rtxSsrc,
          cname: this.cname,
        }),
      );
      media.ssrcGroup = [
        new GroupDescription("FID", [
          transceiver.sender.ssrc.toString(),
          transceiver.sender.rtxSsrc.toString(),
        ]),
      ];
    }

    this.addTransportDescription(media, transceiver.dtlsTransport);
    return media;
  }

  /**
   * 拒否 / 停止した m-line を作成する (RFC 3264 §6 / RFC 8829 §5.3.1)。
   * port は 0、proto と MID は元の m-line を保ち、fmt は少なくとも 1 token 残す。
   */
  createRejectedMediaDescription(
    source: {
      kind: MediaDescription["kind"];
      profile: string;
      fmt: (string | number)[];
      codecs: RTCRtpCodecParameters[];
      mid?: string;
    },
    dtlsTransport?: RTCDtlsTransport,
  ): MediaDescription {
    const format = source.fmt[0] ?? source.codecs[0]?.payloadType ?? 0;
    const media = new MediaDescription(source.kind, 0, source.profile, [
      format,
    ] as string[] | number[]);
    media.host = DISCARD_HOST;
    media.direction = "inactive";
    media.rtp = {
      codecs: source.codecs.filter(
        (codec) => codec.payloadType?.toString() === format.toString(),
      ),
      headerExtensions: [],
      muxId: source.mid,
    };
    media.rtcpMux = true;
    if (dtlsTransport) {
      // 候補は載せず、ICE / DTLS の識別子だけを残す
      media.iceParams = dtlsTransport.iceTransport.localParameters;
      media.dtlsParams = dtlsTransport.localParameters;
    }
    return media;
  }

  /**
   * MediaDescriptionをSCTP用に作成
   */
  createMediaDescriptionForSctp(sctp: RTCSctpTransport): MediaDescription {
    const media = new MediaDescription(
      "application",
      DISCARD_PORT,
      "UDP/DTLS/SCTP",
      ["webrtc-datachannel"],
    );
    media.sctpPort = sctp.port;
    media.rtp.muxId = sctp.mid;
    media.sctpCapabilities = sctp.getCapabilities();

    this.addTransportDescription(media, sctp.dtlsTransport);
    return media;
  }

  /**
   * トランスポートの情報をMediaDescriptionに追加
   */
  addTransportDescription(
    media: MediaDescription,
    dtlsTransport: RTCDtlsTransport,
    { applied = false }: { applied?: boolean } = {},
  ): void {
    const generation = dtlsTransport.iceTransport.describedLocalGeneration({
      applied,
    });

    media.iceCandidates = generation.candidates;
    media.iceCandidatesComplete = generation.complete;
    media.iceParams = generation.parameters;
    media.iceOptions = "trickle";

    media.host = DISCARD_HOST;
    media.port = DISCARD_PORT;

    if (media.direction === "inactive") {
      // compatible は受け入れた inactive を拒否と区別するため非ゼロ port を保つ
      if (this.mLineReuse === "aggressive") {
        media.port = 0;
      }
      media.msids = [];
    }

    if (!media.dtlsParams) {
      media.dtlsParams = dtlsTransport.localParameters;
      if (!media.dtlsParams.fingerprints) {
        media.dtlsParams.fingerprints =
          dtlsTransport.localParameters.fingerprints;
      }
    }
  }

  /**
   * 一意のMIDを割り当て
   */
  allocateMid(type: "dc" | "av" | "" = ""): string {
    let mid = "";
    for (let i = 0; ; ) {
      // rfc9143.html#name-security-considerations
      // SHOULD be 3 bytes or fewer to allow them to efficiently fit into the MID RTP header extension
      mid = (i++).toString() + type;
      if (!this.seenMid.has(mid)) break;
    }
    this.seenMid.add(mid);
    return mid;
  }

  parseSdp({
    sdp,
    isLocal,
    signalingState,
    type,
  }: {
    sdp: string;
    isLocal: boolean;
    signalingState: string;
    type: "offer" | "answer" | "pranswer";
  }): SessionDescription {
    const description = SessionDescription.parse(sdp);
    this.validateDescription({ description, isLocal, signalingState, type });
    if (!isLocal && type !== "offer") this.alignInitialAnswerMids(description);
    this.validateSections(description, type, isLocal);
    description.type = type;
    return description;
  }

  /**
   * RFC 3264 pairs the m-lines of an answer with the offer's by position.
   * Some servers (issue #142) answer a first offer with MIDs of their own
   * (`0_srtp` for the offered `0`): such an m-line, of the offered kind at the
   * offered position, takes the offered MID, and BUNDLE entries naming it
   * follow. This applies only before a session exists; afterwards an answer
   * MID must equal the offered one (RFC 8843), and any other mismatch is
   * rejected by validateSections.
   */
  private alignInitialAnswerMids(answer: SessionDescription) {
    const offer = this.pendingLocalDescription;
    if (
      this.currentLocalDescription ||
      this.currentRemoteDescription ||
      !offer ||
      offer.media.length !== answer.media.length
    ) {
      return;
    }
    const offeredMids = new Set(offer.media.map((media) => media.rtp.muxId));
    const renamed = new Map<string, string>();
    for (const [index, media] of answer.media.entries()) {
      const offered = offer.media[index];
      const mid = media.rtp.muxId;
      const offeredMid = offered.rtp.muxId;
      if (
        !mid ||
        !offeredMid ||
        mid === offeredMid ||
        offeredMids.has(mid) ||
        media.kind !== offered.kind ||
        answer.media.some((other) => other.rtp.muxId === offeredMid)
      ) {
        continue;
      }
      renamed.set(mid, offeredMid);
      media.rtp.muxId = offeredMid;
    }
    for (const group of answer.group) {
      group.items = group.items.map((item) => renamed.get(item) ?? item);
    }
  }

  /** Checks cross-section constraints before any media or transport is changed. */
  private validateSections(
    description: SessionDescription,
    type: "offer" | "answer" | "pranswer",
    isLocal: boolean,
  ) {
    const mids = description.media.map((media) => media.rtp.muxId);
    const presentMids = mids.filter((mid): mid is string => !!mid);
    if (new Set(presentMids).size !== presentMids.length) {
      throw createWebRtcDomException("OperationError", "Duplicate MID in SDP");
    }

    for (const group of description.group.filter(
      (group) => group.semantic === "BUNDLE",
    )) {
      // BUNDLE members are identified by exact MID (RFC 8843 section 7).
      if (
        new Set(group.items).size !== group.items.length ||
        group.items.some((mid) => !presentMids.includes(mid))
      ) {
        throw createWebRtcDomException(
          "OperationError",
          "Invalid BUNDLE group in SDP",
        );
      }
    }

    const previous = isLocal
      ? this.currentLocalDescription
      : this.currentRemoteDescription;
    if (previous) {
      for (const [index, oldMedia] of previous.media.entries()) {
        const next = description.media[index];
        // Rejected by either side of the current session (JSEP 5.2.2).
        const counterpart = isLocal
          ? this.currentRemoteDescription
          : this.currentLocalDescription;
        const reusable =
          oldMedia.port === 0 ||
          counterpart?.media[index]?.port === 0 ||
          oldMedia.direction === "inactive";
        if (
          !next ||
          (next.kind !== oldMedia.kind && oldMedia.port !== 0) ||
          (oldMedia.rtp.muxId &&
            next.rtp.muxId !== oldMedia.rtp.muxId &&
            !reusable)
        ) {
          throw createWebRtcDomException(
            "InvalidModificationError",
            "Existing m-lines must retain their order, kind and MID",
          );
        }
        if (!isLocal && !reusable && next.port !== 0) {
          this.assertStablePayloadTypes(this.negotiatedCodecs(index), next);
        }
      }
      if (!isLocal) this.assertStableHeaderExtensionIds(description);
    }

    if (type === "offer") return;
    const offer = isLocal
      ? this.pendingRemoteDescription
      : this.pendingLocalDescription;
    // RFC 3264 §6 asks for exactly the offer's m-lines. A remote answer that
    // answers only the leading ones (a peer re-sending its previous answer)
    // is accepted as develop did: the m-lines it leaves out are rejected by it.
    const shorterRemote =
      !isLocal && !!offer && description.media.length < offer.media.length;
    if (
      !offer ||
      (description.media.length !== offer.media.length && !shorterRemote)
    ) {
      throw createWebRtcDomException(
        "InvalidModificationError",
        "Answer m-lines must match the offer",
      );
    }
    for (const [index, media] of description.media.entries()) {
      const offered = offer.media[index];
      if (
        media.kind !== offered.kind ||
        (offered.rtp.muxId && media.rtp.muxId !== offered.rtp.muxId)
      ) {
        throw createWebRtcDomException(
          "InvalidModificationError",
          "Answer m-lines must match the offer",
        );
      }
      if (media.port !== 0 && offered.port === 0) {
        throw createWebRtcDomException(
          "InvalidModificationError",
          "Answer cannot accept a rejected m-line",
        );
      }
    }
  }

  /**
   * The current session uses only what both current descriptions carry for an
   * m-line: an offer may list payload types and header extensions the answer
   * did not accept, and those are free to be offered again with another value.
   */
  private negotiatedMedia(index: number) {
    const remote = this.currentRemoteDescription?.media[index];
    const local = this.currentLocalDescription?.media[index];
    if (!remote || !local || remote.port === 0 || local.port === 0) return;
    return { remote, local };
  }

  private negotiatedCodecs(index: number) {
    const media = this.negotiatedMedia(index);
    if (!media) return [];
    return media.remote.rtp.codecs.filter((codec) =>
      media.local.rtp.codecs.some((c) => c.payloadType === codec.payloadType),
    );
  }

  private negotiatedHeaderExtensions(index: number) {
    const media = this.negotiatedMedia(index);
    if (!media) return [];
    return media.remote.rtp.headerExtensions.filter((extension) =>
      media.local.rtp.headerExtensions.some(
        (e) => e.id === extension.id && e.uri === extension.uri,
      ),
    );
  }

  /**
   * RFC 8285 section 7: a header extension ID in use must not be remapped to
   * another URI within the session (Chrome rejects it too). The router's ID
   * map is shared by every m-line, so a remap in the proposal would reparse
   * current RTP while the description is still pending. Adding extensions,
   * or moving a URI to a new ID, stays allowed.
   */
  private assertStableHeaderExtensionIds(next: SessionDescription) {
    const active = new Map<number, string>();
    for (const index of this.currentRemoteDescription?.media.keys() ?? []) {
      for (const extension of this.negotiatedHeaderExtensions(index)) {
        active.set(extension.id, extension.uri);
      }
    }
    for (const media of next.media) {
      if (media.port === 0) continue;
      for (const extension of media.rtp.headerExtensions) {
        const uri = active.get(extension.id);
        if (uri !== undefined && uri !== extension.uri) {
          throw createWebRtcDomException(
            "InvalidModificationError",
            `RTP header extension id ${extension.id} cannot be remapped within a session`,
          );
        }
      }
    }
  }

  /**
   * RFC 3264 section 8.3.2: a dynamic payload type keeps its codec for the
   * session. A remap would change how in-flight current RTP is decoded while
   * the new description is still pending, so it is rejected before mutation.
   */
  private assertStablePayloadTypes(
    negotiated: RTCRtpCodecParameters[],
    next: MediaDescription,
  ) {
    for (const codec of next.rtp.codecs) {
      const previous = negotiated.find(
        (c) => c.payloadType === codec.payloadType,
      );
      if (!previous) continue;
      const apt = (c: typeof codec) =>
        codecParametersFromString(c.parameters ?? "")["apt"];
      if (
        previous.mimeType.toLowerCase() !== codec.mimeType.toLowerCase() ||
        previous.clockRate !== codec.clockRate ||
        (previous.channels ?? 1) !== (codec.channels ?? 1) ||
        (previous.name.toLowerCase() === "rtx" && apt(previous) !== apt(codec))
      ) {
        throw createWebRtcDomException(
          "InvalidModificationError",
          `Payload type ${codec.payloadType} cannot be remapped within a session`,
        );
      }
    }
  }

  private validateDescription({
    description,
    isLocal,
    signalingState,
    type,
  }: {
    description: SessionDescription;
    isLocal: boolean;
    signalingState: string;
    type: "offer" | "answer" | "pranswer";
  }) {
    if (isLocal) {
      if (type === "offer") {
        if (
          !["stable", "have-local-offer", "have-remote-pranswer"].includes(
            signalingState,
          )
        )
          throw createWebRtcDomException(
            "InvalidStateError",
            "Cannot handle offer in signaling state",
          );
      } else if (["answer", "pranswer"].includes(type)) {
        if (
          !["have-remote-offer", "have-local-pranswer"].includes(signalingState)
        ) {
          throw createWebRtcDomException(
            "InvalidStateError",
            "Cannot handle answer in signaling state",
          );
        }
      }
    } else {
      if (type === "offer") {
        if (
          ![
            "stable",
            "have-remote-offer",
            "have-local-offer",
            "have-local-pranswer",
          ].includes(signalingState)
        ) {
          throw createWebRtcDomException(
            "InvalidStateError",
            "Cannot handle offer in signaling state",
          );
        }
      } else if (["answer", "pranswer"].includes(type)) {
        if (
          !["have-local-offer", "have-remote-pranswer"].includes(signalingState)
        ) {
          throw createWebRtcDomException(
            "InvalidStateError",
            "Cannot handle answer in signaling state",
          );
        }
      }
    }
  }

  /**
   * オファーSDPを構築
   */
  buildOfferSdp(
    transceivers: RTCRtpTransceiver[],
    sctpTransport: RTCSctpTransport | undefined,
  ): SessionDescription {
    const description = new SessionDescription();
    addSDPHeader("offer", description);

    const fallbackDtlsTransport = this.findLiveDtlsTransport(
      transceivers,
      sctpTransport,
    );

    // # handle existing transceivers / sctp
    const currentMedia = this.currentLocalDescription?.media ?? [];
    // JSEP 5.2.2: recycle eligible zero-port slots while preserving placeholders
    // for stopped m-lines whose transceiver was replaced at the same index.
    const added = transceivers.filter(
      (t) =>
        t.mid == undefined &&
        t.mLineIndex === undefined &&
        !t.stopping &&
        !t.stopped,
    );
    const placeholderIndices = new Set<number>();

    currentMedia.forEach((m, i) => {
      // werift also writes an `inactive` m-line with port zero, so only an
      // m-line whose transceiver is gone or stopped is recyclable.
      const owner = transceivers.find(
        (t) => !!m.rtp.muxId && t.mid === m.rtp.muxId,
      );
      const recyclable =
        m.kind !== "application" &&
        (!owner || owner.stopped) &&
        (m.port === 0 || this.currentRemoteDescription?.media[i]?.port === 0);
      // A stopped position is reused only by the same kind (issue 705 design).
      const index = recyclable
        ? added.findIndex((transceiver) => transceiver.kind === m.kind)
        : -1;
      const recycled = index >= 0 ? added.splice(index, 1)[0] : undefined;
      if (recycled) {
        recycled.mid = this.allocateMid(this.midSuffix ? "av" : "");
        recycled.mLineIndex = i;
        description.media.push(
          this.createMediaDescriptionForTransceiver(
            recycled,
            recycled.direction,
          ),
        );
        return;
      }
      const mid = m.rtp.muxId;
      if (!mid) {
        return;
      }
      if (m.kind === "application") {
        // The m-line keeps its position without an SCTP transport: the
        // current description, not the transport, records it.
        const rejected =
          m.port === 0 || this.currentRemoteDescription?.media[i]?.port === 0;
        let placed = sctpTransport?.mid === mid;
        if (sctpTransport && sctpTransport.mid == undefined) {
          // An unbound transport (createDataChannel) takes a rejected
          // position with a new MID, like a transceiver reusing a stopped
          // position of its kind, and keeps the MID of any other position.
          sctpTransport.mid = rejected
            ? this.allocateMid(this.midSuffix ? "dc" : "")
            : mid;
          placed = true;
        }
        if (sctpTransport && placed) {
          sctpTransport.mLineIndex = i;
          description.media.push(
            this.createMediaDescriptionForSctp(sctpTransport),
          );
          return;
        }
        // No SCTP transport for this position: it stays rejected (port 0).
        description.media.push(
          this.createRejectedMediaDescription(
            {
              kind: m.kind,
              profile: m.profile,
              fmt: m.fmt,
              codecs: [],
              mid,
            },
            fallbackDtlsTransport,
          ),
        );
      } else {
        const transceiver = transceivers.find((t) => t.mid === mid);
        if (!transceiver) {
          // 再利用で transceiver が外れた位置は、新しい transceiver が来るまで port 0 で保つ
          placeholderIndices.add(i);
          description.media.push(
            this.createRejectedMediaDescription(
              {
                kind: m.kind,
                profile: m.profile,
                fmt: m.fmt,
                codecs: m.rtp.codecs,
                mid,
              },
              fallbackDtlsTransport,
            ),
          );
          return;
        }
        transceiver.mLineIndex = i;
        if (transceiver.stopping || transceiver.stopped) {
          // stop() / 拒否の確定した m-line は自分の offer で port 0 にする
          description.media.push(
            this.createRejectedMediaDescription(
              {
                kind: m.kind,
                profile: m.profile,
                fmt: m.fmt,
                codecs: m.rtp.codecs,
                mid,
              },
              this.liveTransportOr(
                transceiver.dtlsTransport,
                fallbackDtlsTransport,
              ),
            ),
          );
          return;
        }
        description.media.push(
          this.createMediaDescriptionForTransceiver(
            transceiver,
            // JSEP 5.2.2: a stopping or stopped transceiver is offered as a
            // rejected (zero port) m-line.
            transceiver.stopping || transceiver.stopped
              ? "inactive"
              : transceiver.direction,
          ),
        );
      }
    });

    // # handle new transceivers / sctp
    // A stopping or stopped transceiver never gets a new m-line (JSEP 5.2.2).
    for (const transceiver of transceivers.filter(
      (t) =>
        !t.stopping &&
        !t.stopped &&
        !description.media.find((m) => m.rtp.muxId === t.mid),
    )) {
      if (transceiver.mid == undefined) {
        transceiver.mid = this.allocateMid(this.midSuffix ? "av" : "");
      }
      const mediaDescription = this.createMediaDescriptionForTransceiver(
        transceiver,
        transceiver.direction,
      );
      const reservedIndex = transceiver.mLineIndex;
      if (
        reservedIndex != undefined &&
        placeholderIndices.has(reservedIndex) &&
        description.media[reservedIndex]?.kind === transceiver.kind
      ) {
        // 確定済みの port 0 位置を新しい MID で再利用する
        placeholderIndices.delete(reservedIndex);
        description.media[reservedIndex] = mediaDescription;
      } else {
        transceiver.mLineIndex = description.media.length;
        description.media.push(mediaDescription);
      }
    }

    if (
      sctpTransport &&
      !description.media.find(
        (m) =>
          m.kind === "application" &&
          m.port !== 0 &&
          m.rtp.muxId === sctpTransport.mid,
      )
    ) {
      sctpTransport.mLineIndex = description.media.length;
      if (sctpTransport.mid == undefined) {
        sctpTransport.mid = this.allocateMid(this.midSuffix ? "dc" : "");
      }
      description.media.push(this.createMediaDescriptionForSctp(sctpTransport));
    }

    if (this.bundlePolicy !== "disable") {
      // RFC 8843: port 0 の m-line は BUNDLE group に含めない
      const mids = description.media
        .filter((m) => m.port !== 0)
        .map((m) => m.rtp.muxId)
        .filter((v) => v) as string[];
      if (mids.length) {
        const bundle = new GroupDescription(
          "BUNDLE",
          orderBundleMids(
            mids,
            this.negotiatedBundleTags.find((tag) => mids.includes(tag)),
          ),
        );
        description.group.push(bundle);
      }
    }

    return description;
  }

  private liveTransportOr(
    dtlsTransport: RTCDtlsTransport | undefined,
    fallback: RTCDtlsTransport | undefined,
  ) {
    return dtlsTransport && dtlsTransport.state !== "closed"
      ? dtlsTransport
      : fallback;
  }

  private findLiveDtlsTransport(
    transceivers: RTCRtpTransceiver[],
    sctpTransport: RTCSctpTransport | undefined,
  ) {
    return [
      ...transceivers
        .filter((t) => !t.stopped && !t.pendingRejection)
        .map((t) => t.dtlsTransport),
      sctpTransport?.dtlsTransport,
      ...transceivers.map((t) => t.dtlsTransport),
    ].find((t): t is RTCDtlsTransport => !!t && t.state !== "closed");
  }

  /**確定済み answer の BUNDLE tag (各 group の先頭 MID) */
  get negotiatedBundleTags(): string[] {
    const answer = [
      this.currentLocalDescription,
      this.currentRemoteDescription,
    ].find((d) => d?.type === "answer");
    return (answer?.group ?? [])
      .filter((g) => g.semantic === "BUNDLE")
      .map((g) => g.items[0]);
  }

  /**
   * アンサーSDPを構築
   */
  buildAnswerSdp({
    transceivers,
    sctpTransport,
    signalingState,
    transportByMid,
  }: {
    transceivers: RTCRtpTransceiver[];
    sctpTransport: RTCSctpTransport | undefined;
    signalingState: string;
    transportByMid?: Map<string, RTCDtlsTransport>;
  }): SessionDescription {
    if (
      !["have-remote-offer", "have-local-pranswer"].includes(signalingState)
    ) {
      throw new Error("createAnswer failed");
    }
    if (!this._remoteDescription) {
      throw new Error("wrong state");
    }

    const description = new SessionDescription();
    addSDPHeader("answer", description);

    const remoteDescription = this._remoteDescription;
    const fallbackDtlsTransport = this.findLiveDtlsTransport(
      transceivers,
      sctpTransport,
    );
    const rejectedMids = new Set<string>();

    for (const remoteMedia of remoteDescription.media) {
      let dtlsTransport: RTCDtlsTransport | undefined;
      let media: MediaDescription;
      let accepted = true;

      if (remoteMedia.port === 0) {
        if (remoteMedia.rtp.muxId) rejectedMids.add(remoteMedia.rtp.muxId);
        media = new MediaDescription(
          remoteMedia.kind,
          0,
          remoteMedia.profile,
          remoteMedia.fmt,
        );
        media.rtp.muxId = remoteMedia.rtp.muxId;
        media.direction = "inactive";
        description.media.push(media);
        continue;
      }

      if (["audio", "video"].includes(remoteMedia.kind)) {
        const transceiver = transceivers.find(
          (t) => t.mid != undefined && t.mid === remoteMedia.rtp.muxId,
        );
        if (!transceiver && remoteMedia.port !== 0) {
          throw new Error(
            `Transceiver with mid=${remoteMedia.rtp.muxId} not found`,
          );
        }
        if (
          !transceiver ||
          remoteMedia.port === 0 ||
          transceiver.stopped ||
          transceiver.pendingRejection
        ) {
          accepted = false;
          if (remoteMedia.rtp.muxId) rejectedMids.add(remoteMedia.rtp.muxId);
          dtlsTransport = this.liveTransportOr(
            transceiver?.dtlsTransport,
            fallbackDtlsTransport,
          );
          media = this.createRejectedMediaDescription(
            {
              kind: remoteMedia.kind,
              profile: remoteMedia.profile,
              fmt: remoteMedia.fmt,
              codecs: remoteMedia.rtp.codecs,
              mid: remoteMedia.rtp.muxId,
            },
            dtlsTransport,
          );
        } else {
          // answerer の stop() だけでは port 0 にせず、次の自分の offer で停止を交渉する
          media = this.createMediaDescriptionForTransceiver(
            transceiver,
            transceiver.stopping
              ? "inactive"
              : andDirection(transceiver.direction, transceiver.offerDirection),
          );
          dtlsTransport = transceiver.dtlsTransport;
        }
      } else if (remoteMedia.kind === "application") {
        if (!sctpTransport || !sctpTransport.mid) {
          throw new Error("sctpTransport not found");
        }
        media = this.createMediaDescriptionForSctp(sctpTransport);

        dtlsTransport = sctpTransport.dtlsTransport;
      } else {
        throw new Error("invalid kind");
      }

      const proposedTransport =
        remoteMedia.rtp.muxId && transportByMid?.get(remoteMedia.rtp.muxId);
      // A rejected m-line keeps port 0: only an accepted one takes the
      // transport prepared for the pending proposal.
      if (proposedTransport && accepted) {
        dtlsTransport = proposedTransport;
        this.addTransportDescription(media, proposedTransport);
      }

      // # determine DTLS role, or preserve the currently configured role
      if (media.dtlsParams && dtlsTransport) {
        if (dtlsTransport.role === "auto") {
          // RFC 8842 section 5.3: answer `passive` to an `active` offer and
          // `active` to `actpass`/`passive`.
          media.dtlsParams.role =
            remoteMedia.dtlsParams?.role === "client" ? "server" : "client";
        } else {
          media.dtlsParams.role = dtlsTransport.role;
        }
      }

      // Simulcastに関する処理
      if (
        accepted &&
        remoteMedia.simulcastParameters &&
        remoteMedia.simulcastParameters.length > 0
      ) {
        media.simulcastParameters = remoteMedia.simulcastParameters.map(
          (v) => ({
            ...v,
            direction: v.direction === "send" ? "recv" : "send",
          }),
        );
      }

      description.media.push(media);
    }

    if (this.bundlePolicy !== "disable") {
      description.group.push(
        ...this.buildAnswerBundleGroups(remoteDescription, description),
      );
    }

    return description;
  }

  /**
   * RFC 8843 §7.3: offered BUNDLE group の member のうち受け入れた MID だけで
   * answer の group を作る。確立済みの tag は保持し、初回 answer で
   * offerer-tagged を拒否した場合は受け入れた先頭 member を answerer-tagged にする。
   * 全 member を拒否した group は省略する。
   */
  private buildAnswerBundleGroups(
    remoteDescription: SessionDescription,
    answer: SessionDescription,
  ) {
    const acceptedMids = new Set(
      answer.media
        .filter((m) => m.port !== 0 && m.rtp.muxId)
        .map((m) => m.rtp.muxId!),
    );
    const negotiatedTags = this.negotiatedBundleTags;

    return remoteDescription.group
      .filter((group) => group.semantic === "BUNDLE")
      .map((group) =>
        group.items.filter((mid, index, items) => {
          return acceptedMids.has(mid) && items.indexOf(mid) === index;
        }),
      )
      .filter((mids) => mids.length > 0)
      .map(
        (mids) =>
          new GroupDescription(
            "BUNDLE",
            orderBundleMids(
              mids,
              negotiatedTags.find((tag) => mids.includes(tag)),
            ),
          ),
      );
  }

  /**
   * remote answer / pranswer を適用する前の検証。
   * 非ゼロ port の RTP m-line が pending local offer と共通 codec を持たなければ拒否する。
   */
  private assertRemoteAnswerCodecs(remoteSdp: SessionDescription) {
    if (!["answer", "pranswer"].includes(remoteSdp.type)) {
      return;
    }
    const offer = this.pendingLocalDescription;
    if (!offer) {
      return;
    }
    remoteSdp.media.forEach((media, index) => {
      if (!["audio", "video"].includes(media.kind) || media.port === 0) {
        return;
      }
      const offered = offer.media[index];
      if (!offered || offered.port === 0 || offered.kind !== media.kind) {
        return;
      }
      const hasCommonCodec = media.rtp.codecs.some(
        (codec) =>
          codec.name.toLowerCase() !== "rtx" &&
          offered.rtp.codecs.some(
            (offeredCodec) =>
              offeredCodec.mimeType.toLowerCase() ===
              codec.mimeType.toLowerCase(),
          ),
      );
      if (!hasCommonCodec) {
        throw createWebRtcDomException(
          "InvalidAccessError",
          `No common codec for m-line ${index} (mid=${media.rtp.muxId}) in remote ${remoteSdp.type}`,
        );
      }
    });
  }

  setLocalDescription(description: SessionDescription) {
    if (description.type === "offer" || description.type === "pranswer") {
      this.pendingLocalDescription = description;
      return;
    }

    this.currentLocalDescription = description;
    if (this.pendingRemoteDescription) {
      this.currentRemoteDescription = this.pendingRemoteDescription;
    }
    this.pendingLocalDescription = undefined;
    this.pendingRemoteDescription = undefined;
  }

  setRemoteDescription(
    sessionDescription: RTCSessionDescriptionInit,
    signalingState: string,
  ) {
    if (!sessionDescription.type) {
      throw new Error("invalid sessionDescription");
    }

    if (sessionDescription.type === "rollback") {
      if (
        ![
          "have-remote-offer",
          "have-local-pranswer",
          "have-remote-pranswer",
        ].includes(signalingState)
      ) {
        throw createWebRtcDomException(
          "InvalidStateError",
          "Cannot rollback remote description in signaling state",
        );
      }
      this.pendingLocalDescription = undefined;
      this.pendingRemoteDescription = undefined;
      return;
    }

    if (!sessionDescription.sdp) {
      throw new Error("invalid sessionDescription");
    }

    // # parse and validate description
    const remoteSdp = this.parseSdp({
      sdp: sessionDescription.sdp,
      isLocal: false,
      signalingState,
      type: sessionDescription.type,
    });
    this.validateRemoteDescription(remoteSdp);

    this.applyRemoteDescription(remoteSdp);

    return remoteSdp;
  }

  /**
   * 状態を変更する前の remote description の検証。失敗時は signaling state /
   * descriptions を保つ。answer / pranswer は pending local offer と共通 codec を持つ。
   * (re-offer による BUNDLE の分割・統合は negotiation transaction が staged topology として扱う)
   */
  validateRemoteDescription(remoteSdp: SessionDescription) {
    this.assertRemoteAnswerCodecs(remoteSdp);
  }

  applyRemoteDescription(remoteSdp: SessionDescription) {
    if (remoteSdp.type === "offer" || remoteSdp.type === "pranswer") {
      this.pendingRemoteDescription = remoteSdp;
    } else {
      if (this.pendingLocalDescription) {
        this.currentLocalDescription = this.pendingLocalDescription;
      }
      this.currentRemoteDescription = remoteSdp;
      this.pendingRemoteDescription = undefined;
      this.pendingLocalDescription = undefined;
    }
  }

  rollbackLocalDescription(signalingState: string) {
    if (
      ![
        "have-local-offer",
        "have-local-pranswer",
        "have-remote-pranswer",
      ].includes(signalingState)
    ) {
      throw createWebRtcDomException(
        "InvalidStateError",
        "Cannot rollback local description in signaling state",
      );
    }
    this.pendingLocalDescription = undefined;
    this.pendingRemoteDescription = undefined;
  }

  registerMid(mid: string): void {
    this.seenMid.add(mid);
  }

  get remoteIsBundled() {
    const remoteSdp = this._remoteDescription;
    if (!remoteSdp) {
      return undefined;
    }
    const bundle = remoteSdp.group.find(
      (g) => g.semantic === "BUNDLE" && this.bundlePolicy !== "disable",
    );
    return bundle;
  }

  /**
   * RFC 8842 section 5.2: an offer for a new DTLS association (a transport
   * prepared for this offer that has never connected, such as a BUNDLE split
   * owner) uses `actpass`, even if the SDP carried the shared transport's role.
   */
  private offerNewAssociation(
    description: SessionDescription,
    media: MediaDescription,
    dtlsTransport: RTCDtlsTransport,
    transportByMid?: Map<string, RTCDtlsTransport>,
  ) {
    if (
      description.type === "offer" &&
      media.dtlsParams &&
      dtlsTransport.state === "new" &&
      transportByMid?.get(media.rtp.muxId ?? "") === dtlsTransport
    ) {
      media.dtlsParams.role = "auto";
    }
  }

  /**
   * ローカルセッション記述を設定し、トランスポート情報を追加する
   */
  setLocal(
    description: SessionDescription,
    transceivers: RTCRtpTransceiver[],
    sctpTransport?: { dtlsTransport: RTCDtlsTransport; mid?: string },
    transportByMid?: Map<string, RTCDtlsTransport>,
  ) {
    const transceiverByMLineIndex = new Map(
      transceivers.map((transceiver) => [transceiver?.mLineIndex, transceiver]),
    );
    const fallbackDtlsTransport =
      transceivers.find((transceiver) => transceiver?.dtlsTransport)
        ?.dtlsTransport ?? sctpTransport?.dtlsTransport;
    // Refreshing an applied description keeps the ICE generation it applied.
    const applied =
      description === this.currentLocalDescription ||
      description === this.pendingLocalDescription;
    // SCTP が RTP より先にある SDP でも元の m-line index で transceiver を引く
    description.media.forEach((m, i) => {
      if (!["audio", "video"].includes(m.kind)) return;
      const transceiver =
        transceivers.find(
          (t) => t?.mid != undefined && t.mid === m.rtp.muxId,
        ) ?? transceiverByMLineIndex.get(i);
      const live =
        transceiver &&
        !transceiver.stopping &&
        !transceiver.stopped &&
        !transceiver.pendingRejection;
      if (m.port === 0 && !live) return;
      const dtlsTransport =
        (m.rtp.muxId && transportByMid?.get(m.rtp.muxId)) ||
        transceiver?.dtlsTransport ||
        fallbackDtlsTransport;
      if (!dtlsTransport)
        throw new Error(`dtls transport not found for media index ${i}`);
      const port = m.port;
      this.addTransportDescription(m, dtlsTransport, { applied });
      this.offerNewAssociation(description, m, dtlsTransport, transportByMid);
      if (port === 0) m.port = 0;
    });
    // A rejected (port 0) application m-line carries no transport.
    const sctpMedia = description.media.find(
      (m) => m.kind === "application" && m.port !== 0,
    );
    if (sctpTransport && sctpMedia) {
      const dtlsTransport =
        (sctpMedia.rtp.muxId && transportByMid?.get(sctpMedia.rtp.muxId)) ||
        sctpTransport.dtlsTransport;
      this.addTransportDescription(sctpMedia, dtlsTransport, { applied });
      this.offerNewAssociation(
        description,
        sctpMedia,
        dtlsTransport,
        transportByMid,
      );
    }

    // Refreshing the transport lines of the current description (candidates
    // an ICE restart gathers after its commit) keeps it current.
    if (description === this.currentLocalDescription) return;
    this.setLocalDescription(description);
  }
}

/**確立済み tag が含まれていれば先頭に置き、それ以外は元の順序を保つ */
function orderBundleMids(mids: string[], preferredTag?: string) {
  if (!preferredTag || !mids.includes(preferredTag)) {
    return mids;
  }
  return [preferredTag, ...mids.filter((mid) => mid !== preferredTag)];
}

export type MLineReuse = "compatible" | "aggressive";

export interface RTCSessionDescriptionInit {
  sdp?: string;
  type?: RTCSdpType;
}
export type RTCSdpType = "answer" | "offer" | "pranswer" | "rollback";
