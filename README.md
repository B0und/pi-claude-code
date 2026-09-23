# pi-claude-code

This Pi extension routes all Claude model communication through the official
Claude Code CLI. It uses your existing Claude Code login, communicates through
Claude Code's native `stream-json` protocol, and translates streamed responses
back into Pi's message format. Linear conversations may reuse a warm Claude Code
process; other requests replay Pi's conversation in a fresh process.

Install the extension with:

```sh
pi install https://github.com/earendil-works/pi-claude-code
```

Pi remains responsible for conversation history, approvals, compaction, and tool
execution. The extension exposes Pi's tools to Claude Code through an inert MCP
inventory, so Claude can request a tool but Claude Code cannot execute it; the
request is returned to Pi instead. Claude Code continues to own and store its
credentials. The extension does not read its credential files, refresh its
tokens, or persist them. Authenticated request headers do pass transiently
through the local turn relay described below.

Requests made through this extension count against your Claude subscription's
usage quota and rate limits exactly like other Claude Code usage. This extension
does not provide separate or unlimited usage.

## Local Turn Relay

Each Claude Code worker receives an `ANTHROPIC_BASE_URL` that points to a
random, loopback-only HTTP route owned by this extension.

The relay exists because Pi, rather than Claude Code, owns the agent loop and
tool execution. In particular, it:

- forwards exactly one Anthropic Messages request for each Pi turn and rejects
  additional native recovery attempts. Claude Code can otherwise issue another
  generation after an inert MCP tool call, even with one turn and HTTP retries
  disabled;
- captures and streams the first upstream response before Claude Code processes
  it, preserving signed thinking, tool arguments, usage, and the native stop
  reason. This lets Pi retain a valid tool request even when Claude Code later
  reports an `error_max_turns` boundary or a synthetic recovery error;
- records Claude Code's initial native user and system reminders, then restores
  their stable layout during full-history replay. It removes redundant moving
  reminders and adjusts cache breakpoints so tool rounds do not continually
  invalidate the prompt-cache prefix;
- injects supported mid-conversation tool additions and removals at their
  original assistant boundaries and adds the corresponding Anthropic beta
  header; and
- ties cancellation to the active upstream socket as well as the Claude Code
  process.

## Login and logout

Run `/login` in Pi and select **Claude Code Subscription (Experimental)**. This
launches Claude Code's authorization flow in your browser.  If Claude Code
requests an authorization code, paste it into Pi; otherwise the prompt closes
after the browser callback completes.

Run `/logout` in Pi and select the same provider to remove Pi's login marker.
Claude Code still owns the actual credentials, so use `claude auth logout` if
you also want to log out of Claude Code.

The authentication is reused with Claude Code which it routes through.

## Limitations

- Warm Claude Code processes are reused only for exact linear continuations.
  Branches, edits, configuration changes, errors, and tool-use boundaries fall
  back to a fresh process and full replay. At most two processes are retained,
  and no process is retained for more than five minutes.
- Tool schemas are normalized for Claude Code. Nullable variants and schema
  composition such as `oneOf`, `allOf`, and `anyOf` may be simplified or
  removed.
- Exact mid-conversation tool additions and removals, including prompt-cache
  preservation, work only on supported models. Other cases fall back to the
  current tool state and may lose prompt-cache reuse.
- Inherited API-key, proxy, Bedrock, Vertex, and Foundry overrides are rejected
  to avoid silently changing authentication or billing.
