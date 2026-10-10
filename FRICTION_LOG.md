# Friction log

Problems we actually hit while building Home Ahead, in the order we hit them. Versions: `@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/ext-apps` 2.0.3, `@modelcontextprotocol/sdk` 1.32.1, `@strands-agents/sdk` 1.19.0, Node.js 24.

## 1. The Alexa+ add-on developer tools are not available to participants

- **Task**: test the MCP server the way Alexa+ would call it.
- **Steps**: followed the Alexa+ add-on setup guides, which point to the MCP Toolkit, CLI and Web Simulator.
- **Expected**: a way to run the server against a simulated Alexa+ device.
- **Actual**: the hackathon FAQ says these tools "are in preview and available to select partners only", and that this is sometimes missing from individual setup-guide pages.
- **Severity**: Medium. It shapes the whole project: we had to build our own device simulator and guess at host details (screen size, device class).
- **Workaround**: a web simulator (`src/sim`) that hosts MCP Apps views and passes the host-context fields the Alexa+ docs describe (`deviceClass`, `maxWidth`, `maxHeight`).
- **Suggestion**: a public, read-only Web Simulator or a documented host-context sample, even without publishing.

## 2. MCP Apps and Strands Agents need different major versions of the MCP SDK

- **Task**: one server with MCP Apps views, called by a Strands agent.
- **Steps**: installed `@modelcontextprotocol/ext-apps` 2.0.3 and `@strands-agents/sdk` 1.19.0.
- **Expected**: one MCP SDK in the project.
- **Actual**: ext-apps builds on the v2 split packages (`@modelcontextprotocol/server`, `core`), while Strands' `McpClient` takes a transport from the v1 `@modelcontextprotocol/sdk` package. Both majors are installed side by side.
- **Severity**: Medium. It works, but nothing tells you the two talk to each other until you try.
- **Workaround**: v2 on the server and in the simulator, v1 only for the Strands client, and an integration test where a v1 client initializes, calls tools and receives a resource-update notification from the v2 server (`tests/mcp/protocol.test.ts`).
- **Suggestion**: a Strands release on the v2 client packages, or a note in both READMEs about which versions interoperate.

## 3. Strands' MCP tools drop `structuredContent`

- **Task**: show an MCP Apps card for the tool result the agent got.
- **Steps**: Strands agent with `McpClient`, server tools returning `content` plus `structuredContent`.
- **Expected**: access to the full `CallToolResult`, including `structuredContent`, after the agent loop.
- **Actual**: `McpTool` maps only the `content` items to tool-result blocks; `structuredContent` (the data the MCP App view renders) never reaches the agent's result.
- **Severity**: Medium for anyone combining Strands with MCP Apps.
- **Workaround**: `RecordingTransport` in `src/agent/strands.ts` wraps the client transport, pairs each `tools/call` request with its response and keeps the raw result.
- **Suggestion**: keep `structuredContent` (and `_meta`) on the tool result, or expose a hook for raw MCP results.
- **Later, with a live model**: the model never sees `structuredContent` either. Our first run of the demo with Claude stopped at "Yes, place the order": the cart token that `confirm_supply_order` needs was only in `structuredContent`, so the model apologized that it could not place the order. Tests with a scripted model had not caught it. Fixed on the server side by also returning the serialized data in a second text block, which the MCP spec recommends for clients that only read `content`.

## 4. The v2 SDK README names a newer spec than the version it negotiates

- **Task**: meet the rule "MCP spec version 2025-11-25 over Streamable HTTP".
- **Steps**: read the `@modelcontextprotocol/server` 2.3.1 README.
- **Expected**: a clear statement of the protocol version the server negotiates.
- **Actual**: the README says it implements the "2026-07-28 MCP spec", while `LATEST_PROTOCOL_VERSION` in the package is `"2025-11-25"`, which is what an `initialize` actually returns.
- **Severity**: Low, but it costs time when a contest rule names an exact version.
- **Workaround**: a test asserts the negotiated version (and that an unknown requested version falls back to `2025-11-25`).
- **Suggestion**: list the negotiated and supported protocol versions in the README.

## 5. `McpServer` has no built-in `resources/subscribe`

- **Task**: proactive alerts. Clients subscribe to `home://alerts` and get `notifications/resources/updated`.
- **Steps**: registered the resource with `McpServer.registerResource` and declared `resources: { subscribe: true }`.
- **Expected**: subscribe and unsubscribe handled like `resources/read`.
- **Actual**: `McpServer` registers no handler for `resources/subscribe` or `resources/unsubscribe`; you add them yourself on the low-level `server.server` and track subscribers per session.
- **Severity**: Low.
- **Workaround**: `setRequestHandler('resources/subscribe' | 'resources/unsubscribe', ...)` with a per-session set, then `sendResourceUpdated` when alerts change.
- **Suggestion**: built-in subscription tracking in `McpServer`, since `sendResourceUpdated` is already there.

## 6. An AppBridge connected after the view loads silently loses `ui/initialize`

- **Task**: host MCP Apps views in iframes in the simulator.
- **Steps**: created the iframe, set `srcdoc`, waited for `load`, then `bridge.connect(new PostMessageTransport(...))`.
- **Expected**: either a working handshake or an error.
- **Actual**: the view posts `ui/initialize` as soon as its script runs, before the host listens. Nothing errors and the view still renders (tool input and result notifications arrive), but the view never finishes initializing, so `autoResize` never starts and the iframe stays at its initial height with the content clipped.
- **Severity**: Medium. It looks like a CSS problem, not a protocol one.
- **Workaround**: connect the bridge to the iframe's `contentWindow` first, then set `srcdoc`. A Playwright test now checks that the frame grows to fit.
- **Suggestion**: have the view retry `ui/initialize` until answered, or warn on the host when a view sends notifications before initializing.

## 7. Watching a view's tool calls means replacing the bridge handler

- **Task**: log every tool call in the simulator's inspector, including calls made by buttons inside a view.
- **Steps**: wrapped the MCP client's `callTool`.
- **Expected**: view calls go through the client method like everything else.
- **Actual**: AppBridge forwards a view's `tools/call` without going through that method, so those calls are invisible to the wrapper. Setting `bridge.oncalltool` works but logs "oncalltool handler replaced".
- **Severity**: Low.
- **Workaround**: `bridge.oncalltool = (p) => client.callTool(p)` right after `connect`.
- **Suggestion**: an event or middleware hook for forwarded requests.
