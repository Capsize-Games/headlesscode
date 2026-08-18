/**
 * SHIM — replaces zoo-code/src/utils/globalContext.ts.
 *
 * The original resolves the extension's global storage directory from the VS
 * Code ExtensionContext. Headless, we use `~/.roo` (the same directory Roo Code
 * uses for global custom modes), creating it if needed.
 */

import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"
import type { ExtensionContext } from "../../shim/vscode"

export async function ensureSettingsDirectoryExists(_context?: ExtensionContext): Promise<string> {
	const dir = path.join(os.homedir(), ".roo")
	try {
		await fs.mkdir(dir, { recursive: true })
	} catch {
		// Ignore: read-only home dirs fall back to the path anyway.
	}
	return dir
}
