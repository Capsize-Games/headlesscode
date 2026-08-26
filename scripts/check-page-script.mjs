// Parse-guard for the dashboard page's inline <script>: src/dashboard/page.ts
// is ONE big template literal. A syntax error in the inline JS (e.g. a
// missing brace, like the pre-existing groupEvents bug this guard exists to
// catch, or a raw "\n" inside a string, which the template literal turns into
// a real newline) silently kills the whole dashboard — no console error
// reaches the server. So the test chain re-checks it on every run.
//
// IMPORTANT: this evaluates the REAL renderPage() template literal and checks
// the ACTUAL served script, rather than regex-unescaping the raw template
// source. Template literals interpret \n, \t, \\, \uXXXX etc., not just \`
// and \${ — an approximation that only unescaped the delimiters missed those
// and let a broken page through. Calling renderPage() is exactly what the
// browser gets. Run this with tsx (it imports a .ts module). Exit 1 with a
// clear message on any parse failure.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const { renderPage } = await import("../src/dashboard/page.ts")

const html = renderPage()
const m = html.match(/<script>([\s\S]*?)<\/script>/)
if (!m) {
	console.error("FAIL dashboard-page-parse: no <script> block found in renderPage() output")
	process.exit(1)
}
const code = m[1]

const tmp = path.join(os.tmpdir(), `headlesscode-page-script-${process.pid}.js`)
try {
	fs.writeFileSync(tmp, code)
	execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" })
} catch (error) {
	const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : ""
	console.error("FAIL dashboard-page-parse: inline script does not parse")
	console.error(stderr.split("\n").slice(0, 6).join("\n"))
	process.exit(1)
} finally {
	fs.rmSync(tmp, { force: true })
}
console.log(`  ok   dashboard-page-parse: inline script parses (${code.length} chars from renderPage())`)
