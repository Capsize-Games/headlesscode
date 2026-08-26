/**
 * SHIM — replaces zoo-code/src/i18n/index.ts.
 *
 * The original is a full i18n catalog keyed to the webview UI. The vendored
 * CustomModesManager uses `t()` only to build user-facing error strings. The
 * headless harness surfaces those as plain console output, so this shim returns
 * the key (with `{param}` interpolation applied).
 */

export function t(key: string, params?: Record<string, unknown>): string {
	if (!params) {
		return key
	}
	let result = key
	for (const [name, value] of Object.entries(params)) {
		result = result.replaceAll(`{${name}}`, String(value))
	}
	return result
}
