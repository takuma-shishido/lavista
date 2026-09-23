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

初回の指示と完了条件をUTF-8の `task.txt` に記入し、対象プロジェクトのディレクトリで実行します。

```sh
cd /path/to/project
lavista start task.txt
```

カレントディレクトリが対象プロジェクトになり、成果物はそこへ直接反映されます。隔離したい場合は、事前に用意した作業用コピーやworktreeで実行してください。実行ログは `.lavista/runs/<開始時刻(UTC)>/` に保存されます。

## 画面

端末で実行すると、ClaudeとAstra（Codex）の動作をリアルタイムで表示するTUIが起動します。

```
lavista  run 2026-09-24T01-23-45Z  iteration 1/5  Astra (Codex) ⠇ 00:12
╭ Claude Code ─────────────────────────╮╭ Astra (Codex) ───────────────────────╮
│ ∴ I need to create result.txt        ││ ∴ Verify result.txt exists           │
│ ▸ Write /p/result.txt                ││ ▸ $ bash -lc "cat result.txt"        │
│ ⎿ File created successfully          ││ ⎿ ok: ok                             │
│ · finished: success (3 turns, $0.03) ││ · finished (5120 in / 210 out tokens)│
╰──────────────────────────────────────╯╰──────────────────────────────────────╯
#1 done result.txt exists and tests pass
```

- 左右（幅100桁未満では上下）にClaude・Astraそれぞれの発言（●）、思考（∴）、ツール呼び出し（▸）、結果（⎿）、エラー（✗）、使用量上限（⊘）を表示します。各行は1行に要約され、完全なログはrunディレクトリに保存されます。表示前にタブ・制御文字・色付けのエスケープを取り除き、絵文字として描かれうる記号は幅2として扱うので、出力内容によって枠がずれることはありません。
- ヘッダーに反復回数と実行中のエージェント・経過時間、下部にAstraの判定を表示します。
- `q` または `Ctrl+C` で停止します（状態とログは残り、`lavista resume` などで再開できます）。各CLIに終了を求め、5秒以内に終わらなければ強制終了します。もう一度押すと待たずに強制終了します。端末でない場合の `Ctrl+C`（SIGINT）も同じく2回目で強制終了します。
- 終了すると元の画面に戻り、判定の要約とログの場所を表示します。
- パイプやCIなど端末でない出力先では、同じ内容を1行ずつのテキストで出力します。

## モデルとeffortの選択

ClaudeとAstra（Codex）のモデルとeffortは `start` 時にrunごとに決まり、そのrunの間は固定されます。

```sh
lavista start task.txt \
  --claude-model claude-opus-5-5 --claude-effort high \
  --astra-model gpt-6-astra --astra-effort xhigh
```

指定の優先順位は、コマンドの `--claude-model` / `--claude-effort` / `--astra-model` / `--astra-effort`、設定ファイルの `claude_model` / `claude_effort` / `astra_model` / `astra_effort`、の順です。どちらでも指定されていない項目は、起動時に一覧から選びます（Claudeのモデル→effort→Astraのモデル→effortの順）。

- Claudeのモデル：`claude-fable-5-1` / `claude-opus-5-5` / `claude-sonnet-5` / `claude-haiku-4-5-20251001`。`opus` などの別名はCLIによって旧モデル（例：`claude-opus-5`）に解決されることがあるため、正式名で選びます
- Claudeのeffort：`low` / `medium` / `high` / `xhigh` / `max`
- Astraのモデル：Codexが提供するモデル一覧（`codex debug models` と、Codexがアカウントごとに取得・保存しているモデル一覧）
- Astraのeffort：選んだモデルが対応する段階（モデル既定の段階に印を付けて表示）
- どの一覧にも「CLI default」があり、モデルには「Other…」（名前を入力）もあります

各CLIの設定には干渉しません。選んだ値はその実行のコマンド引数（Claudeは `--model` / `--effort`、Codexは `--model` / `-c model_reasoning_effort=…`）としてだけ渡し、`~/.claude` や `~/.codex/config.toml` は変更しません。「CLI default」を選んだ項目は何も渡さず、各CLIの設定がそのまま使われます。

端末でない環境（パイプ・CI）では一覧を出さず、Astraのモデルだけ `gpt-6-astra`、それ以外は「CLI default」になります。選んだモデルとeffortはTUIの各ペインの見出しと `lavista status` で確認できます。Claudeが指定と異なるモデルで起動した場合はTUIに警告を表示します。

## 設定

設定はコマンド引数ではなく `.lavista/` 以下のJSONファイルに書きます。どちらも省略可能で、書いた項目だけが既定値を上書きします。

- `.lavista/config.json` — プロジェクト共通の設定（コミットしてチームで共有できます）
- `.lavista/config.local.json` — 個人用の上書き（`config.json` より優先。git管理外）

```json
{
  "astra_model": "gpt-6-astra",
  "claude_model": "",
  "allowed_tools": "Bash(npm test)",
  "max_iterations": 5,
  "timeout": 1800,
  "max_history_bytes": 1000000
}
```

| 項目 | 既定値 | 内容 |
|---|---|---|
| `claude_model` | （一覧から選択） | Claudeのモデル。`""` ならClaude CLIの設定に従う |
| `claude_effort` | （一覧から選択） | Claudeのeffort（`low`〜`max`）。`""` ならClaude CLIの設定に従う |
| `astra_model` | （一覧から選択） | Astra（Codex）のモデル。`""` ならCodex CLIの設定に従う |
| `astra_effort` | （一覧から選択） | Astraのreasoning effort。`""` ならCodex CLIの設定に従う |
| `allowed_tools` | `""` | Claudeに追加で許可するツール規則 |
| `max_iterations` | `5` | 最大反復回数 |
| `timeout` | `1800` | 1回のCLI呼び出しのタイムアウト（秒） |
| `max_history_bytes` | `1000000` | Astraに渡す履歴の上限（バイト） |

未知のキーや不正な値はエラーになります。モデルとeffort以外の設定は `start` 時だけでなく `resume` などの再開時にも読み直されるため、上限に達して止まった場合はファイルを編集して `lavista resume` するだけで続行できます。初回の `start` で `.lavista/.gitignore` が作成され、`runs/` と `config.local.json` はgit管理外になります。

## 権限

Claudeは `acceptEdits` でファイルを編集します。コマンド実行などに既存の許可がない場合、その操作は拒否され、最終結果に権限拒否が含まれればループを停止します。必要な許可だけ `allowed_tools` に `"Bash(npm test)"` のように指定できます。権限の一括バイパスは行いません。Astraはread-onlyで検証します。各CLIの既存設定・プロジェクト指示・連携は適用されます。

## 動作

1. 初回指示を新しいClaudeセッションへ送信。
2. 会話・ツール呼び出し・結果を含むCLIの出力イベントを保存。
3. それまでの全反復の保存履歴と元の目標をAstraに渡す。
4. Astraが `continue` / `done` / `needs_input` を返す。
5. `continue` なら生成された指示で新しいClaudeセッションを起動。

引き継ぐのはCLIが公開するイベント履歴です。モデル内部の非公開推論や、CLIが出力しない内部コンテキストを取得するものではありません。作業ファイルは反復間で共有されます。

履歴は黙って切り捨てず、`max_history_bytes` を超えた場合に停止します。このバイト上限はモデルのトークン上限を保証しません。使用量は各CLIの契約・課金体系に従います。全体の金額上限を強制する機能はありません。

## 状態確認・再開

各コマンドの `[run]` は `.lavista/runs/` 以下のrun IDで、省略すると最新のrunが対象になります。

```sh
lavista status
lavista resume
```

Ctrl+Cで停止すると子プロセスも停止し、ログと状態を残します。Astraの失敗は通常の `resume` で再試行できます。実行途中のClaudeは、重複操作を避けるため自動再実行しません。ログと作業ファイルを確認した後、明示的に再試行します。

```sh
lavista retry
```

失敗した試行は別フォルダに保存されます。再試行では新しいClaudeセッションが現在の作業ファイルから進めます。失敗試行のログは通常のAstra入力には含まれません。

Claudeの成功結果が保存済みで、状態更新の前に中断した場合：

```sh
lavista review
```

### 使用量上限での停止

ClaudeまたはAstra（Codex）が使用量上限・レート上限・課金エラーを報告すると、そのCLIを即座に停止し、ツール全体も停止します（終了コード75）。CLIが上限待ちの再試行を続けてタイムアウトまで待つことはありません。停止理由と、分かる場合は解除時刻を表示します。

- Claudeで停止した場合：上限解除後に `lavista retry`
- Astraで停止した場合：上限解除後に `lavista resume`（Claudeの作業結果はそのまま再判定されます）

判定には各CLIのエラー用イベント（Claudeの `error` 付きメッセージやエラー結果、Codexの `error` / `turn.failed`）と、失敗時のstderrだけを使います。作業内容やツール出力に「rate limit」「429」などの語が含まれても停止しません。CLI自身が行う一時的な再接続（`Reconnecting...`）でも停止しません。

`needs_input` の停止理由に対する回答をファイルに書き、再判定させる場合：

```sh
lavista answer answer.txt
```

runディレクトリの `001/`、`002/`…にClaudeの入力・全出力、Astraの入力・全出力・判定を保存します。ログには作業内容が含まれるので、公開リポジトリへ追加する前に確認してください。`done` はAstraの判定であり、独立した検証器による保証ではありません。最初の指示にテストなどの具体的な完了条件を含めると判定しやすくなります。

## 構成

- `src/loop.ts` — 実行・確認・停止の状態遷移
- `src/agents.ts` — Claude / AstraのCLI引数、履歴の組み立て、実行結果の確認
- `src/activity.ts` — Claude（stream-json）/ Codex（`--json`）の出力イベントを表示用の要約に変換
- `src/events.ts` — ループから表示へのイベント定義と非TTY用の行出力
- `src/tui/` — Inkによる全画面表示（`view.ts` が状態、`App.tsx` が画面）
- `src/process.ts` — 子プロセス起動、ログ保存、タイムアウト・中断・強制終了
- `src/follow.ts` — 子プロセスが書き込むログファイルを追いかけて1行ずつ読む（`tail -f` 相当）
- `src/store.ts` — 状態・反復ごとのファイル配置の保存と多重起動防止
- `src/model.ts` — 状態・判定のスキーマ（型・検証・Astra向けJSON Schemaを一元定義）
- `src/models.ts` — モデル・effort一覧の取得と、起動時の選択
- `src/workspace.ts` — `.lavista/` の設定ファイル読み込みとrunディレクトリの作成・検索
- `src/cli.ts` — サブコマンドと開始・再開操作

Python版と保存データの形式は共通です。ただし多重起動防止の仕組みが異なるため、同じrunをPython版と同時に操作しないでください。強制終了や電源断で `.lavista-lock` が残った場合は、中の `owner.json` にあるプロセスが停止済みであることを確認してから、そのロックディレクトリを削除してください。通常のCtrl+Cでは自動解除します。

主な依存ライブラリ：

- [execa](https://github.com/sindresorhus/execa) — 子プロセス起動、タイムアウト・中断時のプロセスグループ単位の停止
- [zod](https://zod.dev) — 保存状態とAstra応答の検証、構造化出力用JSON Schemaの生成
- [commander](https://github.com/tj/commander.js) — サブコマンドの解析とヘルプ
- [Ink](https://github.com/vadimdemedes/ink) / React — TUI表示
- [@inquirer/prompts](https://github.com/SBoudrias/Inquirer.js) — 起動時のモデル選択
- [write-file-atomic](https://github.com/npm/write-file-atomic) — 状態ファイルのアトミックな書き込み

## 開発用テスト

```sh
npm run check
npm test
```

Codexの非対話実行・イベント出力・構造化出力は[公式ドキュメント](https://learn.chatgpt.com/docs/non-interactive-mode)を参照。実装のCLI引数は、この環境にインストールされた両CLIのヘルプとも照合しています。
