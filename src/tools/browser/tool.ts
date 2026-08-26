/**
 * `browser_action` — a real browser-automation native tool for the coding
 * agent, backed by Playwright (headless Chromium).
 *
 * NEW design work, NOT a port: no browser tool exists in the upstream Zoo
 * Code sources this project vendors (re-verified: `grep -rli browser` in
 * `zoo-code/src/core/tools/` and `zoo-code/src/core/prompts/tools/
 * native-tools/` finds nothing). The only browser precedent in this
 * project's orbit is QA-side (a sibling project's `qa/runner.js` +
 * `browserInstrumentation.js`),
 * which generates structured QA reports — a different concern from this
 * interactive mid-session inspection tool. The Playwright dependency is the
 * one thing shared, deliberately.
 *
 * Scope (deliberately minimal, no full browser DSL): launch / screenshot /
 * click / type / getConsoleLogs / getNetworkErrors / close. No arbitrary
 * Playwright API passthrough.
 *
 * Image handling: ToolResult (src/engine/types.ts) carries only a string
 * `content` — there is NO image-content part in this harness's
 * ChatMessage/tool-result plumbing, and the pinned primary model
 * (deepseek/deepseek-v4-flash) cannot process images at all. Screenshots are
 * therefore described by the cloud vision captioner (src/vision/describe.ts):
 * the PNG is saved inside the workspace, sent to an OpenRouter vision model,
 * and the resulting TEXT description is embedded directly in the tool result
 * (cost flows through the session's BudgetTracker via onAuxLlmUsage). The raw
 * image never reaches the main model — but the file path is kept in the
 * result too, for callers that want the PNG itself.
 *
 * The schema's `action` union is shared with the handler in
 * src/tools/browser/handler.ts, which owns the actual session lifecycle and
 * timeout enforcement.
 */

import type OpenAI from "openai"

export const BROWSER_ACTION_NAME = "browser_action"

const BROWSER_ACTION_DESCRIPTION = `Request to control a headless Chromium browser (via Playwright) to inspect a running web app / dev server and verify UI changes visually. The browser starts on the first launch call and stays alive for the rest of the session; it is torn down automatically when the session ends, so you do not need to call close() for cleanup (but may, to free memory).

This tool is for VERIFICATION — a browser is stateful: check the page with screenshot, then interact with click/type, then screenshot again. Do not use it to run shell commands (use execute_command for that).

Parameters:
- action: (required) One of:
  - "launch": Start the headless browser and navigate to url. Re-launching later closes the previous browser and starts fresh.
  - "screenshot": Capture the current page as a PNG. The PNG is written to a file under the workspace (path: <workspaceRoot>/.headlesscode/browser-screenshots/<timestamp>.png) and then described by a cloud vision model — the result includes a real TEXT description of the page (visible text, layout, error messages, UI state) plus the file path + current page title/URL. No raw image reaches the model; act on the description directly.
  - "click": Click the first element matching selector (a CSS selector).
  - "type": Type text into the first element matching selector (a CSS selector; the element must be focusable — a text input or textarea).
  - "getConsoleLogs": Return console messages (including errors) captured from the page since the last getConsoleLogs call (each call returns only NEW entries).
  - "getNetworkErrors": Return failed network requests captured since the last getNetworkErrors call (each call returns only NEW entries).
  - "close": Shut down the browser.
- url: (required for "launch") The URL to open — typically a local dev server you started with execute_command, e.g. http://127.0.0.1:4390.
- selector: (required for "click" and "type") A CSS selector.
- text: (required for "type") The text to type into the element.

Examples:
- Inspect a local dev server: { "action": "launch", "url": "http://127.0.0.1:4390" }
- See the page: { "action": "screenshot" }
- Click a button: { "action": "click", "selector": "#btnStart" }
- Fill a field: { "action": "type", "selector": "#launchTask", "text": "check the UI" }
- Check for page errors: { "action": "getConsoleLogs" }`

const ACTION_PARAMETER_DESCRIPTION = `The browser action to perform: launch | screenshot | click | type | getConsoleLogs | getNetworkErrors | close`
const URL_PARAMETER_DESCRIPTION = `URL to navigate to (required for launch)`
const SELECTOR_PARAMETER_DESCRIPTION = `CSS selector for the element to click or type into (required for click/type)`
const TEXT_PARAMETER_DESCRIPTION = `Text to type into the element (required for type)`

export const browserActionTool = {
	type: "function",
	function: {
		name: BROWSER_ACTION_NAME,
		description: BROWSER_ACTION_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					description: ACTION_PARAMETER_DESCRIPTION,
					enum: ["launch", "screenshot", "click", "type", "getConsoleLogs", "getNetworkErrors", "close"],
				},
				url: {
					type: ["string", "null"],
					description: URL_PARAMETER_DESCRIPTION,
				},
				selector: {
					type: ["string", "null"],
					description: SELECTOR_PARAMETER_DESCRIPTION,
				},
				text: {
					type: ["string", "null"],
					description: TEXT_PARAMETER_DESCRIPTION,
				},
			},
			required: ["action", "url", "selector", "text"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
