# Xboxセール情報（GitHub Pages版）

Microsoft Store（日本）のセール対象ゲームを一覧できるページです。
**毎日 09:30（日本時間）に GitHub Actions が自動で最新情報へ更新します。手作業も承認も要りません。**

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | ページ本体（商品データ込み）。自動更新で書き換わります |
| `scripts/update.mjs` | 取得・差し替えスクリプト（Node 18+、外部ライブラリなし） |
| `.github/workflows/update.yml` | 定期実行の設定（毎日 09:30 JST） |

## 設置手順（初回だけ）

1. GitHub アカウントを作成（無料）: https://github.com/signup
2. 新しいリポジトリを作成（右上の「+」→「New repository」）
   - 名前は任意（例: `xbox-sale-info`）
   - **Public** を選ぶ（無料プランで Pages を使う条件）
   - 「Create repository」
3. このキットのファイルをアップロード
   - リポジトリ画面の「uploading an existing file」から、`index.html` と `README.md`、`scripts` フォルダ、`.github` フォルダをまとめてドラッグ＆ドロップ
   - ※ `.github` は隠しフォルダなので、フォルダごとドラッグするのが確実です
4. Pages を有効化
   - リポジトリの「Settings」→ 左メニュー「Pages」
   - 「Build and deployment」の Source で **Deploy from a branch** を選び、Branch は **main** / **/(root)** にして Save
5. 数分待つと公開されます
   - URL: `https://＜ユーザー名＞.github.io/＜リポジトリ名＞/`

## 手動で今すぐ更新したいとき

リポジトリの「Actions」タブ → 左の「Xboxセール情報 自動更新」→「Run workflow」。
1〜3分で取得・反映されます。

## 仕組み

- 取得元は Xbox 公式の「ブラック フライデー」専用チャンネル。ブラックフライデー終了後、チャンネルが空になったら Microsoft Store の通常セール一覧へ自動で切り替わります（ページ内の出典表記も追随します）
- 価格・定価・セール開始/終了日時は Microsoft の DisplayCatalog API で確認した日本のストア価格です
- 「新着（NEW）」は、前回の掲載リストに無かった商品です。前回リストはページ内に保持され、更新のたびに繰り上がります
- 表紙画像は Microsoft の CDN への直接リンクです（ファイルは同梱しません）
- 取得に失敗したり件数が異常に少ない場合は、ページを壊さないよう更新を中止します（Actions の実行ログに理由が残ります）

## 注意点

- 表示価格は取得時点の情報です。最新の価格は各ゲームの「ストアで見る」リンク先で確認してください
- GitHub の定期実行は、混雑時に数分遅れることがあります
- GitHub の仕様で「60日間リポジトリに動きがないと定期実行が止まる」ルールがありますが、この仕組み自体が週2回コミットするので通常は止まりません。万一止まったら Actions タブで再有効化できます
- リポジトリは Public ですが、中身はストアの公開情報だけで、個人情報や秘密情報は含まれていません
