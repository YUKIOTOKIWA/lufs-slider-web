# LUFS SLIDER WEB

ブラウザ内で音源を解析・調整・比較し、16bit PCM WAVを書き出すVite + TypeScriptアプリです。音源のアップロードや外部APIへの送信は行いません。

## ローカル確認

```sh
npm ci
npm run dev
node --test tests/*.test.mjs
npm run build
npm run preview
```

TARGETのプリセットはスライダーのショートカットです。RESETはTARGET -14.0、OUTPUT 0.0、WIDTH 100%、LIMITER ON、CEILING -1.0へ戻します。音源、再生位置、A/B選択は保持します。DIFFERENCEの絶対値が0.5 LU以内なら「TARGETに近い値」と表示します。この目安による音声の再補正は行いません。

UI文言は`src/ui-text.ts`に集約しています。英語版を追加する際はこの辞書を切り替える構造へ拡張できます。音声モジュールの既存エラーメッセージは各モジュール内にあります。

## GitHub Pagesへの公開準備

`npm run build`が生成する`dist/`の中身を配信対象にします。`vite.config.ts`の`base: './'`により、HTML、CSS、JavaScript、Worker、AudioWorkletのURLを相対パスとして生成します。`https://<owner>.github.io/<repository>/`のように末尾に`/`があるルートから配信してください。独自ドメインのルート配信にも対応します。

AudioWorkletにはHTTPS（またはlocalhost等の安全なコンテキスト）と対応ブラウザが必要です。`dist/index.html`をファイルとして直接開く確認方法は使用しないでください。公開時は`dist/`を配信し、TypeScriptのソースをそのまま配信しません。今回、push・GitHub Actions設定・公開自体は行っていません。

[Viteの相対base仕様](https://vite.dev/guide/build#relative-base)、[AudioWorkletの対応条件](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)も参照してください。

## 現在の制限

- PROCESSED処理とLUFS計測はモノラル／ステレオ対応。Integrated LUFSには0.4秒以上が必要です。
- WAVは16bit PCM、元AudioBufferのサンプルレート・チャンネル数、通常RIFFの約4GB上限です。デコード時にブラウザがリサンプルする場合があります。
- Limiter OFFで0 dBFSを超えたPCMはWAV変換時にクランプします。その場合、ACTUALと再読み込み後のCURRENTが異なることがあります。
- 長時間音源では元AudioBufferと完成WAVのメモリが必要です。再解析中の薄い波形は直前の設定のもので、音声とACTUALの新しい設定の表示とは区別しています。
- OS、ブラウザ、端末によってデコード対応やダウンロードの挙動が異なります。自動ダウンロードが開始しない場合は生成後のダウンロードリンクを使用できます。
