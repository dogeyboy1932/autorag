# Chrome DevTools MCP Quickstart — What Matters For Our Build

**Source:** `WebMCP-org/chrome-devtools-quickstart` (MIT, 38 stars, by MiguelsPizza / Alex Nahas)
**Context:** Sep 3, 1:00pm PDT deadline. Solo. Next.js + Vercel.

---

## 0. First, what this post actually is

The organizer is not describing a project idea. They are describing a **dev loop**:
use WebMCP so your *coding agent* can drive a browser via structured tool calls
instead of screenshots. It's a productivity pitch aimed at participants.

Do not mistake it for a hint about what to build. The judging criteria haven't changed.

---

## 1. ACT ON THIS TODAY — the self-testing dev loop

This is the single most valuable thing in the post for a 3-day solo build.

```bash
claude mcp add chrome-devtools npx @mcp-b/chrome-devtools-mcp@latest
claude mcp add --transport http webmcp-docs https://docs.mcp-b.ai/mcp
```

**Why it matters:** the hardest part of building a WebMCP app solo is the test loop.
Normally you'd deploy → open ChatGPT's in-app browser → type a prompt → squint at
what happened → repeat. That's 2–3 minutes per iteration and it's not scriptable.

With `chrome-devtools-mcp` your coding agent gets `list_webmcp_tools` and
`call_webmcp_tool` against **localhost**. It can register a tool, hot-reload, call
it, read the structured response, and fix the schema — without you in the loop.

**Concretely this lets us:**
- Test schema quality by having the agent try to use a tool cold, with only the
  description to go on. If the agent picks wrong arguments, the description is bad.
  This is exactly what Alex Nahas will be judging.
- Regression-test the whole tool surface after every change.
- Exercise agent **error paths** — call a tool with garbage, confirm we return a
  structured, recoverable error. (Pattern #4 from the strategy brief.)

**Second server matters too.** `webmcp-docs` gives the coding agent current API
knowledge. The spec is in flux and the agent's training data is not reliable here.

---

## 2. ACT ON THIS — resolve the `navigator` vs `document` question NOW

The Devpost example uses `document.modelContext`. This README uses
`navigator.modelContext` and says it comes from importing `@mcp-b/global` **first**.

That's a submission-killing ambiguity if we get it wrong. Resolution:
- Install `@mcp-b/global`, import at top of the entry file.
- Feature-detect both surfaces, register against whichever exists.
- Verify the round trip works in **both** ChatGPT's in-app browser and Chrome with
  `chrome://flags/#enable-webmcp-testing`, since the graders may use either.

This is still Day 0 de-risking. Do it before committing to an idea.

---

## 3. STRONG OPPORTUNITY — steal their benchmark harness

The repo ships a real token benchmark comparing screenshot-driven automation vs
WebMCP tool calls, run against the Claude API:

| Task | Screenshot | WebMCP | Reduction |
|---|---|---|---|
| Set a counter | 3,801 tok | 433 tok | 89% |
| Create calendar event (multi-step) | 11,390 tok | 2,583 tok | 77% |

`npm run benchmark:simple:direct` / `benchmark:complex:direct`. MIT licensed.

**The play:** fork the harness, point it at *our* app, and put a measured number in
the submission write-up. "Completing [our core workflow] costs N tokens through our
tool surface vs M through DOM automation."

Why this is worth an hour:
- Judges are browser/platform people. A quantified efficiency claim about a real
  workflow is the kind of evidence they respond to, and it's rare in hackathons.
- It directly evidences the **WebMCP Leverage** criterion instead of asserting it.
- Cheap: the harness exists, it's just re-pointing it.

**Caveat:** their numbers are from a counter app and a calendar app. Don't cite 89%
as if it's ours. Measure our own or say nothing.

---

## 4. NOTE FOR LATER — the multi-tab / A2A surface

The **MCP-B Chrome extension** aggregates WebMCP tools from *all open tabs* into a
single MCP server. That is a genuine agent-to-agent composition surface and it
exists today, without needing `exposedTo` to work in the origin trial.

Interesting for the A2A research thread. **Not** a good bet for this submission —
it requires the judge to install an extension, and the Devpost deliverable is a
live URL testable in ChatGPT's browser. Park it.

---

## 5. THE TRAP

The post's framing — "WebMCP makes browser automation 90% cheaper" — is a
**developer-tooling** thesis. If we let it steer the project, we end up building a
devtool: a WebMCP debugger, a tool-surface inspector, a token profiler.

Those will be *heavily* saturated. Every developer who reads this post has the same
idea, and it's the easiest thing to build for someone already in this ecosystem.
The Devpost brief asks for an app where **humans and agents work together on a real
task**, not an app for building such apps.

Use this tooling. Don't build it.

---

## Revised Day 0 checklist

- [ ] Register on Devpost
- [ ] `npm install @mcp-b/global`; blank Next.js page on Vercel with one trivial tool
- [ ] Add `chrome-devtools` + `webmcp-docs` MCP servers to the coding agent
- [ ] Confirm agent can `list_webmcp_tools` and `call_webmcp_tool` on localhost
- [ ] Confirm the deployed page works in ChatGPT's in-app browser
- [ ] Only then: lock the idea
