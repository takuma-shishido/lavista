# lavista

[![CI](https://github.com/takuma-shishido/lavista/actions/workflows/ci.yml/badge.svg)](https://github.com/takuma-shishido/lavista/actions/workflows/ci.yml)

Astra（Codex CLI）が目標を段階的な計画に分け、Claude Codeが1段階ずつ実行し、Astraが結果を検証して次の指示を作る、というループを回すローカルCLIです。macOS / Linux、Node.js 22.12以上。

「Astra」は、レビュー役として動くCodex CLI（既定モデル `gpt-6-astra`）を指すlavista内の呼び名です。

> [!WARNING]
> ClaudeはカレントディレクトリでAuto modeのまま、ファイルの編集やコマンドの実行を自律的に行います。変更はその場に直接反映され、lavistaは元に戻す手段を持ちません。
> - gitで管理されたディレクトリで、作業前にコミットしてから実行してください。隔離したい場合は、`git worktree` などで作った作業用コピーで実行してください。
> - 秘密情報や、失っては困るデータがある環境では実行しないでください。
> - ClaudeとCodexの利用料金・使用量は、それぞれのアカウントに計上されます。

## 準備

```sh
git clone https://github.com/takuma-shishido/lavista.git
cd lavista
npm ci
npm run build
npm link
```

`claude` と `codex` をインストールし、それぞれログインしておきます（動作確認済み：Claude Code 2.1.281、codex-cli 0.153.4）。lavistaは両CLIの出力形式に依存するため、CLIの更新で動かなくなることがあります。

## 使い方

目標と完了条件を `task.txt` に書き、対象プロジェクトのディレクトリで実行します。成果物はカレントディレクトリに直接反映されます。

```sh
cd /path/to/project
lavista start task.txt
```

モデルとeffortは引数で指定でき、未指定なら起動時に一覧から選びます。

```sh
lavista start task.txt \
  --claude-model claude-opus-5-5 --claude-effort high \
  --astra-model gpt-6-astra --astra-effort xhigh
```

TUIでは `q` / `Ctrl+C` で停止します（もう一度押すと強制終了）。ログは `.lavista/runs/<run>/` に残ります。

### 許可の確認

Claudeはauto modeで動きます。ほとんどの操作はauto modeの分類器が判断しますが、ユーザーの承認が必要な操作はTUIに確認として表示されます。macOSでは通知も出ます。

| キー | 内容 |
|---|---|
| `y` | 今回だけ許可 |
| `a` | このrunの間は同じ種類の操作を許可（表示された規則をrunに保存し、以降の回にも適用） |
| `n` | 拒否 |

- 確認を待っている間は、`timeout`の無出力時間に数えません。
- 分類器が拒否した操作は確認に回らず、その場で拒否されます。拒否された操作は一覧で表示し、実行はそのままレビューに進みます。
- 毎回許可したい操作は、`allowed_tools`に規則を書いておくと確認なしで実行されます。
- ターミナル以外（パイプやCI）で実行したときは、確認が必要な操作はすべて拒否されます。

### バックグラウンドの処理

Claudeがビルドなどをバックグラウンドで起動したままターンを終えた場合、lavistaはセッションを閉じずにその完了を待ちます（TUIに `waiting for background work` と表示）。完了するとClaudeが同じセッションで続きを行い、残りがなくなった時点でその回を終えます。この待ち時間は `timeout` に数えません。

### 並列実行

同じプロジェクトで別のターミナルから `lavista start` を実行すると、別のrunが並行して動きます。各runのClaudeとAstraには、同時に動いている他のrunの目標と現在の段階が渡され、その作業に触れないよう指示されます。作業ディレクトリは共有なので、目標は重ならないように分けてください。

## コマンド

| コマンド | 内容 |
|---|---|
| `lavista status [run]` | 状態と計画を表示 |
| `lavista resume [run]` | 停止したrunを再開（Astraの失敗・上限停止後など） |
| `lavista retry [run]` | 失敗したClaudeの実行をやり直す |
| `lavista review [run]` | 保存済みのClaude結果をAstraに判定させる |
| `lavista answer <file> [run]` | `needs_input` への回答を渡して再判定 |

`[run]` を省略すると最新のrunが対象です（`resume` / `retry` / `review` / `answer` は、別のlavistaが実行中のrunを飛ばします）。使用量上限で止まった場合は終了コード75で終了します。

## 設定

`.lavista/config.json`（共有用）と `.lavista/config.local.json`（個人用、優先）に書きます。

| 項目 | 既定値 | 内容 |
|---|---|---|
| `claude_model` / `claude_effort` | 一覧から選択 | Claudeのモデル・effort。`""` でCLIの設定に従う |
| `astra_model` / `astra_effort` | 一覧から選択 | Astraのモデル・effort。`""` でCLIの設定に従う |
| `allowed_tools` | `""` | Claudeに確認なしで許可するツール規則（例：`"Bash(npm test)"`）。確認で `a` を選んだ規則は、runの `approved_tools` に保存されて一緒に使われます |
| `max_iterations` | `20` | Claudeの最大実行回数 |
| `timeout` | `1800` | CLIの無出力がこの秒数続いたら停止（確認待ちとバックグラウンド処理の待ちは除く） |

## 開発

```sh
npm run check
npm test
```

## ライセンス

[MIT](LICENSE)
