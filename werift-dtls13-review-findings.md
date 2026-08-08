1. **[P1] HVRによる `[1.3,1.2] → 1.2` downgrade経路がまだ危険です。**

最初の ClientHello 自体は改善されており、今は `[V1_3,V1_2]` を `supported_versions` に載せ、1.2 cipher suites も同時に提示しています。ここは前回より正しくなりました。

ただし、DTLS 1.2 `HelloVerifyRequest` を受信すると `DtlsVersionSelected(V1_2)` を投げ、DTLS 1.3 engineを破棄したあと、1.2 stateを新規作成して `connect12()` を最初から開始しています。

この新しい1.2 ClientHelloは `setupExtensions()` 経由であり、そこには `supported_versions` がありません。

つまり実質的には、

```text
CH: supported_versions=[1.3,1.2]
             ↓
       unauthenticated HVR
             ↓
1.3 engineを捨てる
             ↓
新規 DTLS 1.2-only ClientHello
```

になっています。

RFC 9147 はDTLSのversion negotiationにTLS 1.3のdowngrade protectionを適用しており、TLS 1.3側も「互換性のため別connection attemptで低versionを試す」方式はdowngrade攻撃に弱いため推奨していません。([RFC Editor][1])

したがって、前回の「エラー文字列regexでfallback」はなくなりましたが、**unauthenticated HVRが1.2-only retryを起動できる本質的な問題は残っています。**

推奨は、HVRを単なる「1.2で再接続せよ」というcontrol signalとして扱わず、downgrade protectionを含むassociation-levelのversion negotiationとして設計することです。少なくともDTLS 1.3-capable serverが1.2へ落ちる場合のdowngrade sentinel検証は必要です。

---

2. **[P1] ACK accumulator修正が送信順序と衝突しています。**

今回、

```ts
if (retransmittable) {
  this.clearAckAccumulator();
  ...
}
```

が `sendHandshakeFlight()` に追加されました。意図は「前flightのrecord numbersを次flightのACKへ混ぜない」で、方向性は理解できます。

しかしclientのserver Finished処理順序は現在、

```text
server flightを受信
↓
record numbersをACK候補として蓄積
↓
server Finishedを処理
↓
sendHandshakeFlight(client final flight)
    ↓
    clearAckAccumulator()
↓
sendAck()
```

です。実コードでもclient final flightを送った**後**にserver-flight ACKを送っています。

さらに受信recordを `receivedRecordNumbers` に追加する処理そのものが、`onCiphertextRecordAsync()`、つまりFinished dispatchが完了した**後**です。

したがって、server flightに対して本来送るべきACK情報をclient自身のoutbound flight開始時に消してしまいます。特にFinished recordについてはACK送信時点でまだaccumulatorにも入っていません。

RFC 9147のfull-handshakeでは、client final flightは最終的にACKされる必要があります。([RFC Editor][2])

これは単なる余計なACKではなく、**相手の再送タイマーが発火してduplicateを受けるまで完全ACKにならない可能性**があるため、merge blockerにした方がよいです。

設計としては `receivedRecordNumbers` を「local outbound flight」に紐付けてclearするのではなく、**remote inbound flight単位**に管理するのがよいです。少なくとも、

```text
remote flightを受信
→ record acceptanceを確定
→ そのremote flightのrecord numbersをACK
→ ACK完了後にclear
```

にすべきです。

---

3. **[P1] HRRは大幅改善しましたが、最終ServerHelloの `key_share` 検証が不足しています。**

今回の修正でserver側は、

* `supported_groups` をparse
* localとのintersectionを計算
* intersectionなしを失敗
* 最初のkey_shareにないintersection groupだけをHRR候補にする
* HRRを最大1回にする

ようになりました。

またclientもHRRのselected groupについて、

* 自分の `supported_groups` に含まれる
* initial `key_share` に含まれていない
* second HRRではない

ことを検証しています。ここは良い修正です。

しかしHRR後または通常ServerHelloの最終 `key_share` について、clientは取得した `serverShare.group` をそのまま `selectedGroup` に代入しています。**current ClientHelloで実際に送ったKeyShareEntryのgroupかどうかを検証していません。**

RFC 8446ではServerHelloのserver_shareはclientが送ったkey_shareのgroupと対応する必要があります。HRRがあった場合はHRRで選択されたgroupとの整合性も必要です。

例えばclient側で、

```ts
if (serverShare.group !== this.selectedGroup) {
  throw new Error("ServerHello key_share group was not offered");
}
```

相当の検証が必要です。

---

4. **[P1] `signature_algorithms` negotiationはほぼ直りましたが、extension省略時の扱いがRFC違反です。**

今回、

* peerのschemeを保存
* local keyとのintersectionから選択
* CertificateRequestのschemeをclient CVに適用
* 受信CVも実際に提示したscheme集合でチェック

するようになっています。

これは前回の主要問題をほぼ解消しています。

ただしserverのClientHello処理は、

```ts
if (sigExt) {
  ...
}
```

となっており、`signature_algorithms` が無い場合はdefault schemesをそのまま利用してhandshakeを続けます。

TLS 1.3ではcertificate authenticationを行うserverに対してclientが `signature_algorithms` を送らなかった場合、serverは `missing_extension` でabortする必要があります。([RFC Editor][3])

したがってここも、

```ts
if (!sigExt) {
  throw missingExtension(...)
}
```

相当にする必要があります。

加えてP2レベルですが、`schemesForKey()` は `asymmetricKeyType === "ec"` ならcurveを確認せず `ecdsa_secp256r1_sha256` と判定しています。 P-384等をP-256として扱わず、今回サポート対象外なら明示的にrejectする方が安全です。

## `[V1_2,V1_3]` について

今回、serverが

```ts
[V1_2, V1_3]
```

ならdual clientに対して意図的に1.2を選択するE2Eも追加されています。

ここは再考を推奨します。チケットで明示されている利用パターンは、

```text
[V1_3]
[V1_3, V1_2]
[V1_2]
```

です。

1.3-capable server/client間で意図的に1.2を成立させるなら、RFC 9147が取り込んでいるdowngrade sentinel semanticsも考慮する必要があります。([RFC Editor][1])

Epic 1では `[V1_2,V1_3]` 自体をsupported patternにしない方が設計が単純だと思います。

