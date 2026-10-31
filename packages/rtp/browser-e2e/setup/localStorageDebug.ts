// werift の logger はモジュール読み込み時に localStorage.debug を読むため、
// テストファイルが src を import する前に設定しておく。
localStorage.setItem("debug", "werift:browser-enabled");
