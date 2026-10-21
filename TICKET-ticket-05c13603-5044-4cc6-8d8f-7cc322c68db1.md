## 概要

werift は現在、非 TCP の候補ペアに対して aggressive nomination を使用しています。このため、選択される ICE ペアが、意図した候補ペアの優先度ではなく、どの connectivity check が最初に完了するかに左右されることがあります。

これは、TURN を利用した実際の Chrome ↔ werift のデプロイ環境で観測されました。優先度の低いリレー経路(TCP 経由の TURN)が先に完了してすぐに nominate され、その直後に優先度の高い UDP 経由のリレー候補が利用可能になりました。その結果、UDP リレー経路が利用可能であったにもかかわらず、セッションは TCP リレー経路に留まり、深刻なレイテンシが蓄積しました。

下流側の報告 / 回避策:

- Rkcr007/mfarm-cloud#258: https://github.com/Rkcr007/mfarm-cloud/pull/258
- Rkcr007/mfarm-cloud#259: https://github.com/Rkcr007/mfarm-cloud/pull/259

下流側の回避策は、優先度の低いリレー候補を短時間保留し、優先度の高い UDP リレー候補を先にチェックできるようにするものです。これはアプリケーション層で必要になるべきではありません。

## 現在の挙動

現在の `develop` では、`Connection.checkStart()` は非 TCP のすべてのペアに対して次のように処理しています。

```ts
const nominate =
  this.iceControlling && !this.remoteIsLite && !this.isTcpPair(pair);
```

つまり、UDP / リレーペアでは最初の connectivity check 自体に `USE-CANDIDATE` が付与されます。

そのようなチェックが最初に成功すると、次のようになります。

```ts
if (nominate || pair.remoteNominated) {
  pair.nominated = true;
}
...
this.checkComplete(pair);
```

そして `checkComplete()` は、`this.nominated == undefined` の場合に限り、そのペアを選択済みペアとして確定します。

```ts
if (pair.nominated && ... && this.nominated == undefined) {
  this.nominated = pair;
  ...
}
```

その後、コンポーネントの ICE 処理は完了し、残りの waiting / frozen 状態のペアは failed にされます。

したがって、UDP / リレーペアでは、選択されるペアは実質的に「最初に成功した nominate 付きチェックが勝つ」ことになります。

一方、TCP ペアにはすでに独立した regular nomination の経路(`nominateTcpPairIfReady()`)があり、どの connectivity check がたまたま先に完了するかによって選択が左右されないようになっています。

現在の changelog にも、TCP の regular nomination 修正は UDP / リレーの nomination 挙動を変更しない、と明記されています。

## なぜ問題なのか

RFC 8445 §8.1.1 は regular nomination を次のように説明しています。

1. 停止条件が満たされるまで connectivity check を進行させる。
2. 評価基準に従って valid pair を 1 つ選ぶ。
3. 選んだペアに対して `USE-CANDIDATE` を付けてチェックを繰り返す。

また、aggressive nomination は RFC 5245 の挙動であり、もはや必要ないとも記されています。

現在の UDP / リレーの経路は、nomination の判断が行われる前の通常の connectivity check の段階で `USE-CANDIDATE` を送信してしまっています。

これは特に trickle ICE で問題になります。優先度の低い候補が、優先度の高い候補がシグナリングされるよりも前に到着して成功することがあります。最初のペアが nominate されてしまうと、RFC 8445 では ICE restart なしに同じコンポーネントで別のペアを nominate することは認められていません。したがって、後からペアを切り替えようとするのではなく、早すぎる nomination を避けることが正しい修正です。

## 実環境での影響

mfarm-cloud では次のことが起きました。

- Chrome は TURN/TCP と TURN/UDP の両方でリレー候補を収集した。
- 優先度の低い TCP ベースのリレー候補が先に完了した。
- werift はそれをすぐに nominate した。
- 優先度の高い UDP リレー候補はその直後に利用可能になったが、もう選択されることはできなかった。
- 約 4 Mbit/s 固定の映像ストリームが TURN/TCP 上で、RTT が約 6.2 秒にまで膨らんだ。
- UDP リレー経路を強制すると、RTT は約 88 ms に低下した。

同じデプロイ環境でのもう 1 つの関連する観測として、werift 側にもリレー候補がある場合、最初に nominate されたリレーペアが Chrome が最終的に使用する経路と一致せず、映像がフリーズすることがありました。werift 側のリレー候補を取り除くと、この障害は回避できました。

## 期待される挙動

full ICE ↔ full ICE のセッションでは、UDP / リレーの候補ペアでも regular nomination を使用すべきです。

- 通常の connectivity check は、自動的に `USE-CANDIDATE` を付与しない。
- nomination は、停止条件 / 評価基準が満たされた後にのみ行う。
- 選択するペアは、候補ペアの優先度 / ポリシーに従い、valid pair の中から決定的に選ぶ。
- trickle で後から届いた優先度の高い候補にも、その停止条件に従って nomination の前に参加する機会を与える。
- コンポーネントに対して nominate されるペアは、ちょうど 1 つにする。

ICE-lite との相互運用では、必要な箇所に限り、現在の特殊な挙動を維持してよい。

## 実装方針の提案

UDP 用に別の aggressive 経路を維持するのではなく、既存の TCP 向け regular nomination の仕組みを一般化します。

- 「connectivity check が成功した」ことと「このペアを nominate する」ことを分離する。
- すべてのトランスポートについて、成功した valid pair を追跡する。
- trickle に対応した nomination の停止条件を導入する。例:
  - 利用可能な場合は、リモートの end-of-candidates、および/または
  - 逐次 trickle に対する、上限付きの nomination 遅延 / ポリシーフック
- 条件が満たされたら、最良の valid pair を選ぶ。
- そのペアに対して、専用の `USE-CANDIDATE` チェックを送信する。
- 現在の ICE-lite の扱いは維持する。
- ペアの選択に成功した後は、再 nominate を行わない。

正確な停止条件はポリシー上の判断です。重要なのは、通常の UDP チェックのすべてが aggressive nomination のチェックにならないことです。

## 回帰テスト

少なくとも次をカバーするテストを追加してください。

1. 2 つの UDP 候補ペアが存在する場合:
   - 優先度の低いペアが先に成功する。
   - 優先度の高いペアが後から成功する。
   - 優先度の高い valid pair のみが nominate される。

2. Trickle ICE:
   - 優先度の低いリレー候補が先に到着して成功する。
   - 優先度の高い候補がその少し後に追加される。
   - 設定された停止条件が満たされる前に、nomination が不可逆的に確定しない。

3. 有効な候補が 1 つだけの場合:
   - end-of-candidates / 停止条件の後、不要な遅延なく nomination が完了する。

4. Controlled / ICE-lite の挙動が変わらない。

5. 同じコンポーネントに対して、複数の `USE-CANDIDATE` による nomination が送信されない。

## 影響を受けるバージョン

下流側では `werift 0.24.4` で再現しました。

現在の `develop` にも、上記の非 TCP の aggressive nomination 経路が残っているため、0.24.4 以降も該当すると考えられます。
