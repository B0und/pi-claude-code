# @earendil-works/pi-claude-code

Install the extension with:

```sh
pi install npm:@earendil-works/pi-claude-code
```

This Pi extension routes all Claude model communication through the official Claude Code CLI. It uses your existing Claude Code login, starts Claude Code for each request, replays Pi's conversation through Claude Code's native `stream-json` protocol, and translates the streamed response back into Pi's message format.

Pi remains responsible for conversation history, approvals, compaction, and tool execution. The extension exposes Pi's tools to Claude Code through an inert MCP inventory, so Claude can request a tool but Claude Code cannot execute it; the request is returned to Pi instead. Claude Code continues to own and store its credentials, which are not copied into Pi.

Requests made through this extension count against your Claude subscription's usage quota and rate limits exactly like other Claude Code usage. This extension does not provide separate or unlimited usage.

## Login and logout

Run `/login` in Pi and select **Claude Code Subscription (Experimental)**. This launches Claude Code's authorization flow in your browser. If Claude Code requests an authorization code, paste it into Pi; otherwise the prompt closes after the browser callback completes.

Run `/logout` in Pi and select the same provider to remove Pi's login marker. Claude Code still owns the actual credentials, so use `claude auth logout` if you also want to log out of Claude Code.
