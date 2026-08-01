/**
 * SHIM — local replacement for the tiny `strip-bom` npm package.
 *
 * The vendored `src/core/config/CustomModesManager.ts` imports a default
 * `stripBom()` function that removes a leading UTF-8 byte order mark. This shim
 * implements exactly that so the dependency count stays at the project minimum.
 *
 * Maps to this file via the "strip-bom" entry in tsconfig.json "paths".
 */

export default function stripBom(string: string): string {
	return string.replace(/^\uFEFF/, "")
}
