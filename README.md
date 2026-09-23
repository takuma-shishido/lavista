# lavista

Claude Codeが実行し、Codex CLIのAstraが履歴を検証して次のプロンプトを作り、Claudeの新規セッションで続行するローカルツールです。TypeScript / Node.jsで実装した、macOS / Linux向けのCLIです。Node.js 22.12以上が必要です。

## 準備

このリポジトリで次を実行します。

```sh
npm ci
npm run build
npm link
```

`lavista` コマンドを使えるようになります。コマンド登録をせずに `node dist/cli.js` で実行することもできます。

`claude` と `codex` をインストールし、それぞれログインしてください。Astraの既定モデルは `gpt-6-astra` です。利用可否はCodex側のアカウント・環境に依存します。別モデルへの自動フォールバックはしません。

初回の指示と完了条件をUTF-8の `task.txt` に記入します。

```sh
lavista start \
  --project /absolute/path/to/project \
  --prompt-file task.txt \
  --run-dir ./runs/first \
  --max-iterations 5
```

`--run-dir` は新しいディレクトリを指定します。成果物は `--project` に直接反映されます。隔離したい場合は、事前に用意した作業用コピーやworktreeを指定してください。

Claudeは `acceptEdits` でファイルを編集します。コマンド実行などに既存の許可がない場合、その操作は拒否され、最終結果に権限拒否が含まれればループを停止します。必要な許可だけ `--allowed-tools 'Bash(npm test)'` のように指定できます。権限の一括バイパスは行いません。Astraはread-onlyで検証します。各CLIの既存設定・プロジェクト指示・連携は適用されます。

## 動作

1. 初回指示を新しいClaudeセッションへ送信。
2. 会話・ツール呼び出し・結果を含むCLIの出力イベントを保存。
3. それまでの全反復の保存履歴と元の目標をAstraに渡す。
4. Astraが `continue` / `done` / `needs_input` を返す。
5. `continue` なら生成された指示で新しいClaudeセッションを起動。

引き継ぐのはCLIが公開するイベント履歴です。モデル内部の非公開推論や、CLIが出力しない内部コンテキストを取得するものではありません。作業ファイルは反復間で共有されます。

最大反復回数は5回、1回のCLI呼び出しは30分が既定です。履歴は黙って切り捨てず、既定の1MBを超えた場合に停止します。このバイト上限はモデルのトークン上限を保証しません。使用量は各CLIの契約・課金体系に従います。全体の金額上限を強制する機能はありません。

## 状態確認・再開

```sh
lavista status ./runs/first
lavista resume ./runs/first --max-iterations 10
```

Ctrl+Cで停止すると子プロセスも停止し、ログと状態を残します。Astraの失敗は通常の `resume` で再試行できます。実行途中のClaudeは、重複操作を避けるため自動再実行しません。ログと作業ファイルを確認した後、明示的に再試行します。

```sh
lavista resume ./runs/first --retry-worker
```

失敗した試行は別フォルダに保存されます。再試行では新しいClaudeセッションが現在の作業ファイルから進めます。失敗試行のログは通常のAstra入力には含まれません。

Claudeの成功結果が保存済みで、状態更新の前に中断した場合：

```sh
lavista resume ./runs/first --review-worker
```

`needs_input` の停止理由に対する回答をファイルに書き、再判定させる場合：

```sh
lavista resume ./runs/first --input-file answer.txt
```

履歴サイズの上限を調整する場合：

```sh
lavista resume ./runs/first --max-history-bytes 2000000
```

`001/`、`002/`…にClaudeの入力・全出力、Astraの入力・全出力・判定を保存します。ログには作業内容が含まれるので、公開リポジトリへ追加する前に確認してください。`done` はAstraの判定であり、独立した検証器による保証ではありません。最初の指示にテストなどの具体的な完了条件を含めると判定しやすくなります。

## 構成

- `src/loop.ts` — 実行・確認・停止の状態遷移
- `src/agents.ts` — Claude / AstraのCLI引数、履歴の組み立て、実行結果の確認
- `src/process.ts` — 子プロセス起動、ログ保存、タイムアウト・中断
- `src/store.ts` — 状態・反復ごとのファイル配置の保存と多重起動防止
- `src/model.ts` — 状態・判定のスキーマ（型・検証・Astra向けJSON Schemaを一元定義）
- `src/cli.ts` — コマンド引数と開始・再開操作

Python版と保存データの形式は共通です。ただし多重起動防止の仕組みが異なるため、同じrunをPython版と同時に操作しないでください。強制終了や電源断で `.lavista-lock` が残った場合は、中の `owner.json` にあるプロセスが停止済みであることを確認してから、そのロックディレクトリを削除してください。通常のCtrl+Cでは自動解除します。

主な依存ライブラリ：

- [execa](https://github.com/sindresorhus/execa) — 子プロセス起動、タイムアウト・中断時のプロセスグループ単位の停止
- [zod](https://zod.dev) — 保存状態とAstra応答の検証、構造化出力用JSON Schemaの生成
- [commander](https://github.com/tj/commander.js) — サブコマンド・オプションの解析とヘルプ
- [write-file-atomic](https://github.com/npm/write-file-atomic) — 状態ファイルのアトミックな書き込み

## 開発用テスト

```sh
npm run check
npm test
```

Codexの非対話実行・イベント出力・構造化出力は[公式ドキュメント](https://learn.chatgpt.com/docs/non-interactive-mode)を参照。実装のCLI引数は、この環境にインストールされた両CLIのヘルプとも照合しています。
