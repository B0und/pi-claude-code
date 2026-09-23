# pi-claude-code

Experimental [pi](https://pi.dev) provider that uses an existing Claude Code login to access Claude models. Pi retains ownership of the agent loop, tools, approvals, session history, and compaction.

The transport intentionally drives the official `claude` executable through its native `stream-json` protocol. It does not use `@anthropic-ai/claude-agent-sdk`: the high-level Agent SDK wants to own tool execution, while a Pi provider must return tool calls to Pi without executing them itself.

## Requirements

- pi 0.87 or newer
- Node.js 22.19 or newer
- The official Claude Code CLI installed and logged in

```sh
npm install -g @anthropic-ai/claude-code
claude auth login
```

Claude Code credentials remain owned by the CLI. This package does not read, copy, refresh, or persist them. When login is initiated through Pi, Pi stores only a non-secret `claude-code-external` marker so its auth UI can classify the provider as subscription-backed; the real tokens stay in Claude Code's credential store.

## Try it locally

```sh
pi -e .
```

Select **Claude Code Subscription (Experimental)** from `/model`, or run directly:

```sh
pi -e . \
  --provider claude-code \
  --model claude-sonnet-5
```

From an interactive Pi session, `/login` can launch Claude Code's browser authorization flow: choose **Claude Code Subscription (Experimental)**. Pi dismisses its optional code field automatically when the browser callback completes; paste the authorization code only when Claude Code requests one. You can also authenticate externally with `claude auth login`.

Check the executable and login:

```text
/claude-code-status
```

Pi's `/logout` removes only its non-secret external-auth marker. Use `claude auth logout` to log Claude Code itself out.

Install the local checkout persistently with:

```sh
pi install /absolute/path/to/pi-claude-sdk
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `PI_CLAUDE_CODE_COMMAND` | Absolute path or command name for Claude Code; defaults to `claude` |
| `PI_CLAUDE_CODE_CONFIG_DIR` | Claude Code configuration directory; mapped to `CLAUDE_CONFIG_DIR` in the child process |
| `CLAUDE_CONFIG_DIR` | Native Claude Code configuration directory |

The provider rejects inherited `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and cloud-backend overrides. This prevents a supposedly subscription-backed request from silently using API-key, proxy, Bedrock, Vertex, or Foundry billing.

## How it works

Each model request:

1. Starts a fresh Claude Code process in Pi's working directory, while keeping transport settings and manifests in a private temporary directory.
2. Replays Pi's canonical history through `stream-json`; historical users use `shouldQuery: false` and the final user/tool result performs the query.
3. Passes Pi's fully rendered system prompt through `--system-prompt-file`, replacing Claude Code's coding-agent prompt. On models with native transcript changes, the initial prompt stays there and later system updates remain at their historical positions. The small native Claude Agent SDK identity and billing blocks remain because Claude Code adds them outside the configurable prompt.
4. Disables native tools, skills, setting sources, session persistence, and autocompaction.
5. Advertises Pi's current tool inventory through an inert MCP server. Claude Code can describe and request these tools but cannot execute them. On supported models, historical declarations are separately represented in the Anthropic request so additions and removals retain their original positions.
6. Converts native text, signed thinking, tool calls, stop reasons, and usage into Pi's streaming event protocol.
7. Preserves Claude Code's first-turn native user/system reminder layout, then removes redundant copies of the same user-context reminder from later user and tool-result messages. Current Claude Code versions otherwise inject those copies only on the live edge and omit or reposition them during replay, invalidating the prompt-cache prefix after every tool call.
8. Uses a request-scoped loopback admission relay that forwards exactly one Anthropic Messages request and rejects native recovery attempts.
9. Kills the Claude Code process tree and active upstream connection when the Pi request is aborted.

The relay forwards native authorization headers in memory. On follow-up turns it restores the exact initial reminder layout, strips redundant later copies of the user-context reminder, removes a moving duplicate date reminder, and places cache breakpoints on the previous and current query boundaries. The explicit previous boundary avoids relying on Anthropic's automatic block lookback, which is unreliable for some multimodal tool-result requests. It does not log credentials or persist authorization headers.

For models that support Anthropic's native mid-conversation tool protocol (currently Opus 5.5 and Fable 5.1), the relay also appends the required beta and injects historical system/tool changes. Initial tools stay active at request level, a stable deferred placeholder is present from the first request, and later declarations use `defer_loading: true` until their `tool_addition` block. This keeps the cached tool prefix stable across additions and removals. Same-name schema redefinitions, sessions that begin without an active tool, and models without protocol support fall back to replaying the complete current tool state, which intentionally incurs a new cache prefix.

## Models

At startup the provider asks the installed Claude Code process for the logged-in account's selectable model catalog through its control protocol. The pinned offline fallback currently contains:

- Default (currently Opus 5.5, 1M)
- Claude Opus 5.5, 1M
- Claude Fable 5.1, 1M
- Claude Sonnet 5
- Claude Haiku 4.5

The live catalog is authoritative and can add, remove, rename, or retarget these entries according to the account and Claude Code version. Model IDs, display names, context windows, output limits, thinking-level maps, and prices are copied from Pi's corresponding built-in Anthropic models. Pi model IDs therefore omit Claude Code's transport-only `[1m]` suffix; the provider restores the discovered native route when launching Claude Code. Prices are API list-price equivalents for accounting, not subscription invoices or proof of extra-usage charges. When `claude auth status` reports a subscription login, Pi marks that list-price accounting as `(sub)`; API-key-backed Claude Code authentication remains ordinary priced usage.

## Development

```sh
npm install
npm run check
npm test
```

Tests use fake Claude executables and loopback HTTP fixtures. A manual live smoke test is:

```sh
pi --no-extensions -e . -p --no-tools \
  --provider claude-code \
  --model claude-haiku-4-5-20251001 \
  --thinking off \
  'Reply with exactly: provider-ok'
```

## Experimental status

Claude Code's replay acknowledgements, `CLAUDE_CODE_EXTRA_BODY`, and parts of the `stream-json` protocol are version-sensitive interfaces rather than a public arbitrary-history provider API. The implementation follows the admission and replay design of Nous Research's `hermes-plugin-claude-subscription-directsdk`, but should be requalified when Claude Code changes.
