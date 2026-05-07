# AgentMux 詳細利用ガイド

このガイドでは、AgentMux のインストール、初回起動、設定、運用、トラブルシュートまでをまとめています。

AgentMux はローカルで動く OpenAI 互換ゲートウェイです。OpenCode、Cline、Continue、OpenAI SDK、curl などのクライアントは `http://127.0.0.1:8787/v1` だけを見ます。実際にどの上流プロバイダーやアカウントへ流すかは AgentMux が判断します。

## 目次

- [AgentMux ができること](#agentmux-ができること)
- [インストール](#インストール)
- [初回起動](#初回起動)
- [基本概念](#基本概念)
- [設定ファイル](#設定ファイル)
- [シークレットと環境変数](#シークレットと環境変数)
- [モデルルーティング](#モデルルーティング)
- [ルーティング戦略](#ルーティング戦略)
- [予算と料金設定](#予算と料金設定)
- [クールダウンとフェイルオーバー](#クールダウンとフェイルオーバー)
- [OpenAI 互換 API](#openai-互換-api)
- [クライアント設定](#クライアント設定)
- [CLI リファレンス](#cli-リファレンス)
- [ダッシュボードとヘルスチェック](#ダッシュボードとヘルスチェック)
- [LiteLLM インポート](#litellm-インポート)
- [プロバイダープリセット](#プロバイダープリセット)
- [よく使う構成例](#よく使う構成例)
- [トラブルシュート](#トラブルシュート)
- [セキュリティチェックリスト](#セキュリティチェックリスト)
- [開発](#開発)

## AgentMux ができること

AgentMux は OpenAI 互換クライアントと OpenAI 互換の上流プロバイダーの間に入ります。

主な用途は次の通りです。

- 同じプロバイダーの複数 API キーをローテーションする。
- 1つの論理モデル名を複数の上流プロバイダーへ割り当てる。
- レート制限、予算超過、一時的な障害が起きているアカウントを避ける。
- OpenCode、Claude Code 互換ツール、Codex 系 CLI、Cline、Continue、curl などを、ひとつのローカルエンドポイントへ向ける。
- リクエスト数、エラー、レイテンシ、トークン数、推定コストを SQLite に記録する。

AgentMux が提供するエンドポイントは次の通りです。

- `GET /health`
- `GET /dashboard`
- `GET /v1/models`
- `POST /v1/chat/completions`

`/v1/*` エンドポイントは、`server.allow_unauthenticated: true` を明示しない限り、`Authorization: Bearer <AgentMux のローカル API キー>` を要求します。

## インストール

### npm

```bash
npm install -g @ryusei-mogi/agentmux
agentmux --version
```

スコープなしの npm パッケージ名 `agentmux` は別プロジェクトが使っています。AgentMux を npm から入れる場合は `@ryusei-mogi/agentmux` を使ってください。

AgentMux は Node.js `>=22.13` が必要です。

### GitHub Release tarball

```bash
npm install -g https://github.com/ryusei-mogi/AgentMux/releases/download/v0.4.0/ryusei-mogi-agentmux-0.4.0.tgz
agentmux --version
```

### Homebrew

```bash
brew install ryusei-mogi/AgentMux/agentmux
agentmux --version
```

Homebrew は GitHub Release の tarball を取得し、`Formula/agentmux.rb` の checksum で検証します。

### ローカル開発用 checkout

```bash
git clone https://github.com/ryusei-mogi/AgentMux.git
cd AgentMux
npm install
npm run build
node dist/cli.js --version
```

## 初回起動

設定ディレクトリを作ります。

```bash
mkdir -p ~/.agentmux
```

クライアントが AgentMux へ接続するときに使うローカル API キーを作ります。

```bash
export AGENTMUX_API_KEY="$(openssl rand -hex 32)"
```

デフォルト設定を作ります。

```bash
agentmux init --config ~/.agentmux/agentmux.yaml
```

既存ファイルを置き換えたい場合は `--force` を付けます。

```bash
agentmux init --config ~/.agentmux/agentmux.yaml --force
```

秘密情報用の環境変数ファイルを作ります。

```bash
cat > ~/.agentmux/accounts.env <<'EOF'
export AGENTMUX_API_KEY="replace-with-your-local-agentmux-api-key"
export OPENCODE_GO_A_KEY="sk-..."
export OPENCODE_GO_B_KEY="sk-..."
export OPENCODE_GO_C_KEY="sk-..."
EOF
```

中身を編集します。

```bash
$EDITOR ~/.agentmux/accounts.env
```

シェルへ読み込みます。

```bash
source ~/.agentmux/accounts.env
```

AgentMux を起動します。

```bash
agentmux serve --config ~/.agentmux/agentmux.yaml
```

起動すると次のように表示されます。

```text
AgentMux listening on http://127.0.0.1:8787
```

ヘルスチェックを確認します。

```bash
curl http://127.0.0.1:8787/health
```

モデル一覧を確認します。

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $AGENTMUX_API_KEY"
```

チャット補完を送ります。

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $AGENTMUX_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      { "role": "user", "content": "Say hello from AgentMux." }
    ]
  }'
```

ダッシュボードはブラウザで開けます。

```text
http://127.0.0.1:8787/dashboard
```

## 基本概念

### クライアント

クライアントは AgentMux へ OpenAI 互換リクエストを送るツールです。例として次のものがあります。

- OpenCode
- Cline
- Continue
- カスタム `curl` スクリプト
- `fetch` や OpenAI SDK を custom base URL で使うプログラム
- OpenAI 互換の `base_url` を指定できるツール

クライアントが知る必要があるのは AgentMux だけです。

```text
base_url: http://127.0.0.1:8787/v1
api_key:  AGENTMUX_API_KEY の値
model:    deepseek-chat など AgentMux の論理モデル名
```

### 論理モデル

論理モデルは、クライアントが AgentMux に要求するモデル名です。

```yaml
models:
  deepseek-chat:
    upstreams: [opencode-go-a, opencode-go-b, opencode-go-c]
```

クライアントは `deepseek-chat` を指定します。AgentMux はその論理モデルに紐づく upstream の中から実際の送信先を選びます。

### Upstream

upstream は、実際の OpenAI 互換プロバイダーのエンドポイント、認証情報、モデル名の対応をまとめたものです。

```yaml
upstreams:
  - id: opencode-go-a
    type: openai-compatible
    base_url: https://opencode.ai/zen/go/v1
    api_key_env: OPENCODE_GO_A_KEY
    models:
      deepseek-chat: deepseek-chat
```

AgentMux はこの upstream に対して次の URL を呼びます。

```text
https://opencode.ai/zen/go/v1/chat/completions
```

認証には upstream の API キーを使います。

### モデル名の対応

左側は AgentMux の論理モデル名、右側はプロバイダー側の実モデル名です。

```yaml
models:
  deepseek-chat: deepseek-chat
  qwen-coder: qwen/qwen-2.5-coder-32b-instruct
```

この対応を使うと、プロバイダーごとにモデル名が違っても、クライアント側では同じ名前を使えます。

## 設定ファイル

デフォルトの設定ファイルは次の場所です。

```text
~/.agentmux/agentmux.yaml
```

別のパスを使う場合は `--config` で指定します。

```bash
agentmux serve --config ./agentmux.yaml
```

完全なデフォルト設定を表示するには次を実行します。

```bash
agentmux config-example
```

### 完全な設定例

```yaml
server:
  host: 127.0.0.1
  port: 8787
  api_key_env: AGENTMUX_API_KEY
  allow_unauthenticated: false
  cors_origins: []

database:
  path: ~/.agentmux/usage.sqlite

routing:
  default_strategy: quota_aware
  retry_attempts: 3
  request_timeout_seconds: 120
  cooldown:
    rate_limit_seconds: 900
    server_error_seconds: 300
    timeout_seconds: 180

models:
  deepseek-chat:
    upstreams: [opencode-go-a, opencode-go-b, opencode-go-c]
  qwen-coder:
    upstreams: [opencode-go-a, opencode-go-b, opencode-go-c]
  kimi-k2:
    upstreams: [opencode-go-a, opencode-go-b, opencode-go-c]

upstreams:
  - id: opencode-go-a
    type: openai-compatible
    base_url: https://opencode.ai/zen/go/v1
    api_key_env: OPENCODE_GO_A_KEY
    strategy_weight: 1
    budget:
      window: 5h
      limit_usd: 12
    pricing:
      input_per_million: 0
      output_per_million: 0
    models:
      deepseek-chat: deepseek-chat
      qwen-coder: qwen-coder
      kimi-k2: kimi-k2
```

### `server`

```yaml
server:
  host: 127.0.0.1
  port: 8787
  api_key_env: AGENTMUX_API_KEY
  allow_unauthenticated: false
  cors_origins: []
```

各項目の意味は次の通りです。

- `host`: AgentMux が bind する interface。ローカルだけで使うなら `127.0.0.1` のままにします。
- `port`: HTTP ポートです。
- `api_key`: クライアントが AgentMux に接続するときのローカル API キーです。秘密情報なので、通常は `api_key_env` を使います。
- `api_key_env`: ローカル API キーを入れた環境変数名です。
- `allow_unauthenticated`: `true` にすると `/v1/*` の認証を無効にします。通常は `false` のままにします。
- `cors_origins`: ブラウザから `/v1/*` を呼ぶ場合に許可する origin です。必要なときだけ追加します。

`api_key_env` を設定しているのに環境変数が存在しない場合、AgentMux は起動しません。解決された API キーが16文字未満の場合も起動しません。

### `database`

```yaml
database:
  path: ~/.agentmux/usage.sqlite
```

AgentMux は SQLite に次の状態を保存します。

- upstream の cooldown 状態
- 無効化された upstream
- round-robin の cursor
- リクエストごとの使用量
- 推定コスト
- レイテンシ
- エラー数

`~` はホームディレクトリに展開されます。

### `routing`

```yaml
routing:
  default_strategy: quota_aware
  retry_attempts: 3
  request_timeout_seconds: 120
  cooldown:
    rate_limit_seconds: 900
    server_error_seconds: 300
    timeout_seconds: 180
```

各項目の意味は次の通りです。

- `default_strategy`: モデル route 側で strategy を指定しない場合に使われる戦略です。
- `retry_attempts`: 1リクエストで試す upstream 数の上限です。実際の候補数より大きい場合は候補数が上限になります。
- `request_timeout_seconds`: upstream への1回のリクエストの timeout です。
- `cooldown.rate_limit_seconds`: rate limit と quota error に使う cooldown 秒数です。
- `cooldown.server_error_seconds`: 5xx や一般的な retryable server failure に使う cooldown 秒数です。
- `cooldown.timeout_seconds`: timeout に使う cooldown 秒数です。

### `models`

```yaml
models:
  deepseek-chat:
    upstreams: [deepseek-main, openrouter-fallback]
    strategy: fallback
```

各項目の意味は次の通りです。

- `deepseek-chat` のような key が、クライアントから指定する論理モデル名です。
- `upstreams` は、その論理モデルで使える upstream ID の一覧です。
- `strategy` は任意です。指定すると `routing.default_strategy` より優先されます。

`upstreams` に書いた ID は、必ず `upstreams` セクションに存在する必要があります。

### `upstreams`

```yaml
upstreams:
  - id: deepseek-main
    type: openai-compatible
    base_url: https://api.deepseek.com/v1
    api_key_env: DEEPSEEK_API_KEY
    strategy_weight: 1
    budget:
      window: daily
      limit_usd: 5
    pricing:
      input_per_million: 0.27
      output_per_million: 1.1
      cached_input_per_million: 0.07
    models:
      deepseek-chat: deepseek-chat
```

各項目の意味は次の通りです。

- `id`: upstream の一意な ID です。route や CLI から参照します。
- `type`: 現在は `openai-compatible` のみ対応しています。
- `base_url`: プロバイダーの base URL です。通常は `/v1` までの URL を指定します。
- `api_key_env`: プロバイダー API キーを入れた環境変数名です。
- `api_key`: プロバイダー API キーを直接書く項目です。通常は `api_key_env` を使います。
- `strategy_weight`: `weighted_round_robin` で使う重みです。
- `budget.window`: 予算 window です。`daily`、`weekly`、`monthly`、`5h` のような時間指定が使えます。
- `budget.limit_usd`: その window での推定コスト上限です。
- `pricing.input_per_million`: 入力トークン100万あたりの USD 単価です。
- `pricing.output_per_million`: 出力トークン100万あたりの USD 単価です。
- `pricing.cached_input_per_million`: cached input token 100万あたりの USD 単価です。省略時は `input_per_million` と同じ扱いです。
- `models`: AgentMux の論理モデル名と、上流プロバイダーのモデル名の対応です。

各 upstream は `api_key_env` または `api_key` のどちらかを必ず持つ必要があります。

## シークレットと環境変数

おすすめの置き場所は `~/.agentmux/accounts.env` です。

```bash
mkdir -p ~/.agentmux
touch ~/.agentmux/accounts.env
chmod 600 ~/.agentmux/accounts.env
```

例:

```bash
export AGENTMUX_API_KEY="replace-with-a-random-local-key"
export DEEPSEEK_API_KEY="sk-..."
export OPENROUTER_API_KEY="sk-or-..."
export OPENCODE_GO_A_KEY="sk-..."
export OPENCODE_GO_B_KEY="sk-..."
export OPENCODE_GO_C_KEY="sk-..."
```

AgentMux を起動する前に読み込みます。

```bash
source ~/.agentmux/accounts.env
agentmux serve --config ~/.agentmux/agentmux.yaml
```

実キーを commit しないでください。コピーした env ファイルは repository の外に置くか、ignore されたファイルに置きます。

## モデルルーティング

AgentMux は次の順番で候補を選びます。

1. リクエストされた論理モデルを `models` から探す。
2. route に書かれた upstream ID を読み込む。
3. そのモデルを mapping していない upstream を除外する。
4. disabled の upstream を除外する。
5. cooldown 中の upstream を除外する。
6. 予算上限に達した upstream を除外する。
7. route strategy に従って残った upstream を並べる。
8. `routing.retry_attempts` の範囲で順番に試す。

候補が残らない場合、AgentMux は `503` を返します。

## ルーティング戦略

### `fallback`

`models.<model>.upstreams` に書いた順番を保ちます。

優先 provider と backup provider を決めたいときに使います。

```yaml
models:
  deepseek-chat:
    strategy: fallback
    upstreams: [deepseek-main, openrouter-backup]
```

### `least_used`

upstream の予算 window 内で記録された request 数が少ない順に並べます。

最近の使用量に応じて複数アカウントへ分散したいときに使います。

### `round_robin`

利用可能な upstream を順番に回します。cursor は SQLite に保存されるため、プロセスを再起動しても rotation が続きます。

同等のアカウントへおおむね均等に流したいときに使います。

### `weighted_round_robin`

`round_robin` と似ていますが、`strategy_weight` で相対的な優先度を調整できます。

```yaml
upstreams:
  - id: fast-account
    strategy_weight: 2
  - id: slower-account
    strategy_weight: 0.5
```

内部では重みに応じて候補を展開してから rotation します。1つのリクエスト内では、同じ upstream は候補順に一度だけ現れます。

### `cheapest`

設定された pricing をもとに並べます。

```text
input_per_million + output_per_million
```

pricing がない upstream は cost `0` として扱われます。現実に近い `pricing` を入れた上で使ってください。

### `quota_aware`

次の情報を使って candidate を score します。

- 残り予算の割合
- success rate
- 最近のエラー数
- レイテンシ
- 設定された cost

デフォルト戦略です。複数 provider や複数アカウントを混ぜる構成に向いています。

## 予算と料金設定

budget は AgentMux が記録した推定コストをもとにしたローカル routing limit です。プロバイダー側の課金上限を変更するものではありません。

日次予算の例:

```yaml
budget:
  window: daily
  limit_usd: 10
```

直近5時間の予算の例:

```yaml
budget:
  window: 5h
  limit_usd: 12
```

記録された推定コストが `limit_usd` に達すると、その window が進むまで upstream は routing 候補から外れます。

コスト推定の流れは次の通りです。

- upstream response に OpenAI 互換の `usage` が含まれていればそれを使います。
- usage がなければ、`gpt-tokenizer` で prompt token を推定します。
- streaming response では、usage chunk があれば取得し、必要に応じて stream された text から output token を推定します。
- `pricing` がない場合、推定 cost は `0` です。

pricing の例:

```yaml
pricing:
  input_per_million: 0.27
  output_per_million: 1.1
  cached_input_per_million: 0.07
```

## クールダウンとフェイルオーバー

AgentMux は failure を記録し、調子の悪い upstream を一時的に避けます。

retryable な条件は次の通りです。

- `429`
- `402`
- response text に `rate limit` が含まれる
- response text に `limit reached` が含まれる
- response text に `quota` が含まれる
- upstream の `5xx`
- request timeout
- network error

cooldown の対応は次の通りです。

- `rate_limit` と `quota_exceeded`: `routing.cooldown.rate_limit_seconds`
- `timeout`: `routing.cooldown.timeout_seconds`
- その他の retryable server failure: `routing.cooldown.server_error_seconds`

streaming の挙動:

- stream が始まる前に upstream が失敗した場合、AgentMux は別の upstream を試せます。
- いったん bytes が流れ始めると、途中で別 provider へ切り替えることはできません。
- 次の request は更新された状態をもとに再度 routing されます。

## OpenAI 互換 API

### モデル一覧

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $AGENTMUX_API_KEY"
```

レスポンス例:

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-chat",
      "object": "model",
      "created": 0,
      "owned_by": "agentmux"
    }
  ]
}
```

### 非 streaming chat completion

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $AGENTMUX_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      { "role": "system", "content": "You are concise." },
      { "role": "user", "content": "What is AgentMux?" }
    ]
  }'
```

### streaming chat completion

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $AGENTMUX_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-chat",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Stream a short answer." }
    ]
  }'
```

## クライアント設定

### OpenCode

設定例は `examples/opencode.json` です。

```json
{
  "provider": {
    "agentmux": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AgentMux",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1"
      },
      "models": {
        "deepseek-chat": { "name": "DeepSeek Chat via AgentMux" },
        "qwen-coder": { "name": "Qwen Coder via AgentMux" },
        "kimi-k2": { "name": "Kimi K2 via AgentMux" }
      }
    }
  },
  "model": "agentmux/deepseek-chat",
  "small_model": "agentmux/deepseek-chat"
}
```

AgentMux のローカル API キーは、OpenCode の `/connect` で `agentmux` provider 用に登録します。あるいは OpenCode の auth store に `AGENTMUX_API_KEY` と同じ値を保存します。

### Continue、Cline、その他の OpenAI 互換クライアント

次の値を設定します。

```text
base URL: http://127.0.0.1:8787/v1
API key:  AGENTMUX_API_KEY の値
model:    agentmux.yaml の models にある任意の key
```

クライアントに OpenAI API key 欄がある場合は、AgentMux のローカル API キーを入れます。プロバイダーの API キーは入れません。プロバイダーのキーは AgentMux の upstream 設定か環境変数へ置きます。

### OpenAI SDK for JavaScript

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.AGENTMUX_API_KEY,
  baseURL: 'http://127.0.0.1:8787/v1'
});

const result = await client.chat.completions.create({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'Hello through AgentMux' }]
});

console.log(result.choices[0]?.message?.content);
```

## CLI リファレンス

### `agentmux init`

設定ファイルを作ります。

```bash
agentmux init --config ~/.agentmux/agentmux.yaml
```

既存ファイルを上書きします。

```bash
agentmux init --config ~/.agentmux/agentmux.yaml --force
```

### `agentmux serve`

gateway を起動します。

```bash
source ~/.agentmux/accounts.env
agentmux serve --config ~/.agentmux/agentmux.yaml
```

### `agentmux status`

upstream の状態と当日の使用状況を表示します。

```bash
agentmux status --config ~/.agentmux/agentmux.yaml
```

主な列:

- `id`: upstream ID
- `state`: `healthy`、`cooldown`、`probation`、`disabled`
- `requests`: 当日の request 数
- `errors`: 当日の error 数
- `cost`: 当日の推定 cost
- `latency`: 平均 latency
- `cooldown_until`: cooldown が終わる ISO timestamp。なければ `-`

### `agentmux upstream list`

`agentmux status` と同じ状態テーブルを表示します。

```bash
agentmux upstream list --config ~/.agentmux/agentmux.yaml
```

### `agentmux upstream disable`

upstream を routing から一時的に外します。

```bash
agentmux upstream disable opencode-go-a --config ~/.agentmux/agentmux.yaml
```

この操作は runtime state を SQLite に書きます。YAML は編集しません。

### `agentmux upstream enable`

disabled の upstream を再度有効化します。

```bash
agentmux upstream enable opencode-go-a --config ~/.agentmux/agentmux.yaml
```

### `agentmux usage today`

当日の使用状況を表示します。

```bash
agentmux usage today --config ~/.agentmux/agentmux.yaml
```

### `agentmux usage window`

指定した rolling window 以降の使用状況を表示します。

```bash
agentmux usage window 5h --config ~/.agentmux/agentmux.yaml
agentmux usage window 24h --config ~/.agentmux/agentmux.yaml
```

### `agentmux preset list`

組み込み provider preset を一覧表示します。

```bash
agentmux preset list
```

### `agentmux preset show`

preset を YAML として表示します。

```bash
agentmux preset show deepseek
```

### `agentmux import-litellm`

LiteLLM YAML を変換します。

```bash
agentmux import-litellm litellm.yaml --output agentmux.yaml
```

### `agentmux config-example`

デフォルト設定を表示します。

```bash
agentmux config-example
```

## ダッシュボードとヘルスチェック

### Health

```bash
curl http://127.0.0.1:8787/health
```

レスポンスには次の情報が含まれます。

- overall status: `ok` または `degraded`
- upstream state
- 設定済みの論理モデル

少なくとも1つの upstream が `healthy` または `probation` なら、`status` は `ok` です。

### Dashboard

ブラウザで開きます。

```text
http://127.0.0.1:8787/dashboard
```

dashboard は AgentMux が返すローカル HTML です。request 数、token 数、推定 cost、latency、error、cooldown、upstream state を確認できます。

## LiteLLM インポート

次のような LiteLLM 設定があるとします。

```yaml
model_list:
  - model_name: deepseek-v4-flash
    litellm_params:
      model: deepseek/deepseek-chat
      api_base: https://api.deepseek.com/v1
      api_key: os.environ/DEEPSEEK_API_KEY
```

変換します。

```bash
agentmux import-litellm litellm.yaml --output agentmux.yaml
```

変換後は次を確認してください。

- 生成された upstream ID
- 生成された環境変数名
- model mapping
- cost-aware routing を使う場合は pricing と budget

## プロバイダープリセット

preset を一覧表示します。

```bash
agentmux preset list
```

現在の preset:

- `opencode-go`
- `deepseek`
- `openrouter`
- `kimi`
- `qwen`
- `zen-balance`

preset を表示します。

```bash
agentmux preset show openrouter
```

preset は upstream 設定の断片です。実際に使うには `id`、`models`、認証情報を追加してください。

## よく使う構成例

### 同じプロバイダーの3アカウントを使う

```yaml
models:
  deepseek-chat:
    upstreams: [account-a, account-b, account-c]
    strategy: round_robin

upstreams:
  - id: account-a
    type: openai-compatible
    base_url: https://opencode.ai/zen/go/v1
    api_key_env: ACCOUNT_A_KEY
    models:
      deepseek-chat: deepseek-chat
  - id: account-b
    type: openai-compatible
    base_url: https://opencode.ai/zen/go/v1
    api_key_env: ACCOUNT_B_KEY
    models:
      deepseek-chat: deepseek-chat
  - id: account-c
    type: openai-compatible
    base_url: https://opencode.ai/zen/go/v1
    api_key_env: ACCOUNT_C_KEY
    models:
      deepseek-chat: deepseek-chat
```

### primary provider と backup provider を使う

```yaml
models:
  deepseek-chat:
    strategy: fallback
    upstreams: [deepseek-main, openrouter-backup]

upstreams:
  - id: deepseek-main
    type: openai-compatible
    base_url: https://api.deepseek.com/v1
    api_key_env: DEEPSEEK_API_KEY
    models:
      deepseek-chat: deepseek-chat
  - id: openrouter-backup
    type: openai-compatible
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
    models:
      deepseek-chat: deepseek/deepseek-chat
```

### cost-aware routing を使う

```yaml
routing:
  default_strategy: cheapest
  retry_attempts: 3
  request_timeout_seconds: 120
  cooldown:
    rate_limit_seconds: 900
    server_error_seconds: 300
    timeout_seconds: 180

upstreams:
  - id: cheap
    pricing:
      input_per_million: 0.2
      output_per_million: 0.8
    models:
      deepseek-chat: deepseek-chat
  - id: expensive-fast
    pricing:
      input_per_million: 1
      output_per_million: 4
    models:
      deepseek-chat: deepseek-chat
```

### browser client で CORS を使う

```yaml
server:
  host: 127.0.0.1
  port: 8787
  api_key_env: AGENTMUX_API_KEY
  allow_unauthenticated: false
  cors_origins:
    - http://localhost:5173
```

信頼できる origin だけを追加してください。

## トラブルシュート

### `Config file not found`

設定ファイルを作ります。

```bash
agentmux init --config ~/.agentmux/agentmux.yaml
```

または正しい path を渡します。

```bash
agentmux serve --config ./agentmux.yaml
```

### `Missing server API key env`

設定に次がある場合:

```yaml
server:
  api_key_env: AGENTMUX_API_KEY
```

環境変数を設定します。

```bash
export AGENTMUX_API_KEY="$(openssl rand -hex 32)"
```

または env ファイルを読み込みます。

```bash
source ~/.agentmux/accounts.env
```

### `Unauthorized`

クライアントが AgentMux のローカル API キーを送れていません。

まず curl で確認します。

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $AGENTMUX_API_KEY"
```

curl は通るのにクライアントだけ失敗する場合は、クライアントの OpenAI API key 欄に AgentMux のローカル API キーを入れてください。

### `No available upstreams for model`

考えられる原因:

- model が `models` に存在しない。
- route された upstream がすべて disabled。
- route された upstream がすべて cooldown 中。
- route された upstream がすべて budget 超過。
- `models.<model>.upstreams` に書かれた upstream が、その model を自身の `models` に mapping していない。

確認します。

```bash
agentmux status --config ~/.agentmux/agentmux.yaml
curl http://127.0.0.1:8787/health
```

### `Missing API key env for upstream`

upstream に次がある場合:

```yaml
api_key_env: DEEPSEEK_API_KEY
```

環境変数を設定します。

```bash
export DEEPSEEK_API_KEY="sk-..."
```

または AgentMux を起動する前に env ファイルを読み込みます。

### All upstreams failed

AgentMux は `routing.retry_attempts` の範囲で candidate を試しましたが、すべて失敗しました。

確認するもの:

- upstream provider の状態
- API key の有効性
- provider account の quota
- ローカルネットワーク
- `agentmux status`
- `/dashboard`

### cost が `$0.0000` のまま

`pricing` がない場合は正常です。推定 cost を出したい場合は各 upstream に pricing を追加してください。

### streaming が途中で止まる

bytes が流れ始めた後は、AgentMux は upstream を途中で切り替えられません。現在の stream は upstream の挙動に従って終了します。次の request は改めて routing されます。

### Homebrew install が fresh release で失敗する

Homebrew の Node helper は、直近1日以内に publish された npm package を formula build 時に遅延させることがあります。新しい依存が含まれている場合、時間が経つと `brew install` が通ることがあります。npm install は通常すぐ使えます。

```bash
npm install -g @ryusei-mogi/agentmux
```

## セキュリティチェックリスト

- 意図がない限り `server.allow_unauthenticated: false` のままにする。
- `server.api_key` より `server.api_key_env` を使う。
- upstream の `api_key` より `api_key_env` を使う。
- 秘密情報は `~/.agentmux/accounts.env` などの private file に置く。
- ローカル secret file には `chmod 600 ~/.agentmux/accounts.env` を設定する。
- ネットワーク公開の意図がない限り `0.0.0.0` に bind しない。
- AgentMux を localhost の外へ出す場合は、信頼できるネットワーク制御の後ろに置く。
- 実 provider key、SQLite usage database、log、コピーした env file を commit しない。

## 開発

依存を入れます。

```bash
npm install
```

チェックを実行します。

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run check:oss-safety
```

source から起動します。

```bash
npm run dev -- serve --config ./agentmux.yaml
```

build 済みの出力を使って起動します。

```bash
npm run build
node dist/cli.js serve --config ./agentmux.yaml
```
