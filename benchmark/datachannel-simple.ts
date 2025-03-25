/**
 * Simple DataChannel ベンチマークテスト
 * 
 * このテストは基本的なDataChannelの性能を測定します。
 * 小さいサイズのデータを使用して往復時間(RTT)を計測します。
 */

import { randomBytes } from "crypto";
import * as Werift from "../packages/webrtc/src";

/**
 * DataChannelの接続を確立し、テストを実行します
 */
async function runBenchmark() {
  console.log("DataChannel ベンチマークを開始します...");
  
  // 2つのピア接続を作成
  const peer1 = new Werift.RTCPeerConnection({});
  const peer2 = new Werift.RTCPeerConnection({});
  
  // ICE候補の交換
  peer1.onicecandidate = (e) => {
    if (e.candidate) {
      peer2.addIceCandidate(e.candidate);
    }
  };
  peer2.onicecandidate = (e) => {
    if (e.candidate) {
      peer1.addIceCandidate(e.candidate);
    }
  };
  
  // DataChannel作成
  const dc1 = peer1.createDataChannel("benchmark");
  let dc2: Werift.RTCDataChannel;
  
  // DataChannelの受信設定
  peer2.onDataChannel.subscribe((channel) => {
    dc2 = channel;
    
    // メッセージを受信したら即座に送り返す（エコー）
    channel.onMessage.subscribe((msg) => {
      channel.send(msg);
    });
  });
  
  // 接続確立
  await peer1.createOffer()
    .then((offer) => peer1.setLocalDescription(offer))
    .then(() => peer2.setRemoteDescription(peer1.localDescription!))
    .then(() => peer2.createAnswer())
    .then((answer) => peer2.setLocalDescription(answer))
    .then(() => peer1.setRemoteDescription(peer2.localDescription!));
  
  // DataChannelのオープンを待機
  await new Promise<void>((resolve) => {
    dc1.stateChanged.subscribe((state) => {
      if (state === "open") {
        resolve();
      }
    });
  });
  
  console.log("DataChannel接続が確立されました。テストを実行します...");
  
  // テストデータ（1KB）
  const testData = randomBytes(1024);
  const iterations = 100;
  const results: number[] = [];
  
  // 往復時間(RTT)テスト
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    
    // メッセージを送信
    dc1.send(testData);
    
    // 応答を待機
    await new Promise<void>((resolve) => {
      dc1.onMessage.once(() => {
        const end = performance.now();
        results.push(end - start);
        resolve();
      });
    });
    
    // 進捗表示
    if (i % 10 === 0) {
      console.log(`テスト進捗: ${i}/${iterations}`);
    }
  }
  
  // 結果集計
  const avg = results.reduce((sum, val) => sum + val, 0) / results.length;
  const min = Math.min(...results);
  const max = Math.max(...results);
  const sorted = [...results].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  
  // 結果出力
  console.log("======== 結果 ========");
  console.log(`サンプル数: ${results.length}`);
  console.log(`データサイズ: 1KB`);
  console.log(`平均RTT: ${avg.toFixed(2)}ms`);
  console.log(`最小RTT: ${min.toFixed(2)}ms`);
  console.log(`最大RTT: ${max.toFixed(2)}ms`);
  console.log(`中央値RTT: ${median.toFixed(2)}ms`);
  console.log("=====================");
  
  // 接続をクリーンアップ
  dc1.close();
  peer1.close();
  peer2.close();
  
  return results;
}

// ベンチマークを実行
runBenchmark().catch((err) => {
  console.error("エラーが発生しました:", err);
});
