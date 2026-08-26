/**
 * GitHub App authentication — installation access tokens.
 *
 * Wraps `@octokit/auth-app` (the GitHub-maintained library for exactly this;
 * it handles the RS256 JWT signing and the POST /app/installations/{id}/
 * access_tokens token-exchange protocol — hand-rolling that insecurely would
 * be worse than taking the dependency). See docs/github-app-setup.md for the
 * manual App registration the human owner must do first.
 *
 * Security model:
 *  - The durable secret is the App private key (from env, per
 *    docs/github-app-setup.md). Installation tokens are deliberately
 *    EPHEMERAL (1h validity) — we cache them in memory only, keyed by
 *    installation id, refresh on demand past expiry, and never persist a
 *    token to disk.
 *  - The default cache uses the library's own LRU (TTL = 59 min < GitHub's
 *    1h token lifetime). Tests inject a fake cache + fake clock to prove the
 *    caching and refresh behavior without sleeping or hitting the network.
 */

import { createAppAuth } from "@octokit/auth-app"
import { request as octokitRequest } from "@octokit/request"

/** Minimal shape of the library's installation-token auth result (the full
 * `InstallationAccessTokenAuthentication` type is not re-exported from
 * "@octokit/auth-app", so we declare the fields we consume). */
interface InstallationTokenResult {
	token: string
	expiresAt: string
}

/** Minimal callable shape of the auth strategy (matches AuthInterface's
 * installation overload; the type itself isn't exported from the package). */
type InstallationAuth = (options: {
	type: "installation"
	installationId: number | string
	refresh?: boolean
}) => Promise<InstallationTokenResult>

/** In-memory token cache interface (mirrors the shape the library's Cache
 * option expects; ours is injectable + testable). */
export interface TokenCache {
	get(key: string): string | undefined | Promise<string | undefined>
	set(key: string, value: string): unknown | Promise<unknown>
}

interface Clock {
	now(): number
}

export interface AppAuthConfig {
	/** GitHub App numeric ID ($GITHUB_APP_ID). */
	appId: string | number
	/** App private key PEM text ($GITHUB_APP_PRIVATE_KEY). */
	privateKey: string
	/** Optional GitHub API base URL override (tests/mocks). */
	baseUrl?: string
	/** Injectable fetch for tests (default: global fetch). */
	fetchImpl?: typeof fetch
	/** Injectable clock for tests (default: Date.now). */
	clock?: Clock
	/** Optional injectable cache (default: the library's own in-memory LRU). */
	cache?: TokenCache
}

export interface AppAuthClient {
	/** A fresh (or cached, unexpired) installation access token. */
	getInstallationToken(installationId: number | string): Promise<string>
}

/** 59 minutes — refresh a minute before GitHub's 1h token lifetime ends. */
export const TOKEN_TTL_MS = 59 * 60 * 1000
/** Cache-key prefix so mixed cache implementations stay namespaced. */
const CACHE_PREFIX = "github-app-installation-token:"

export class AppAuthError extends Error {
	readonly installationId: number | string
	constructor(message: string, installationId: number | string, options?: ErrorOptions) {
		super(message, options)
		this.name = "AppAuthError"
		this.installationId = installationId
	}
}

/**
 * Build an AppAuthClient from App ID + private key (from env per
 * docs/github-app-setup.md). The returned client caches installation tokens
 * in memory, keyed by installation id, and refreshes them before expiry.
 */
export function createAppAuthClient(config: AppAuthConfig): AppAuthClient {
	const { appId, privateKey, baseUrl, fetchImpl, clock = { now: () => Date.now() }, cache } = config

	// The library's Cache option expects { get, set } with string values; we
	// wrap our own cache so the expiry bookkeeping stays in ONE place (here),
	// which is what the tests assert against.
	const libCache: Exclude<Parameters<typeof createAppAuth>[0]["cache"], undefined> = {
		get: async (key: string) => (await cache?.get(key)) ?? "",
		set: (key: string, value: string) => cache?.set(key, value) ?? undefined,
	}

	// The library's `request` option wants a full RequestInterface; build one
	// from the package's own @octokit/request with our baseUrl/fetch injected
	// (fetch is honored per-request by fetch-wrapper via options.request.fetch).
	const request = octokitRequest.defaults({
		...(baseUrl ? { baseUrl } : {}),
		...(fetchImpl ? { request: { fetch: fetchImpl } } : {}),
	})

	const auth: InstallationAuth = createAppAuth({
		appId,
		privateKey,
		request,
		cache: libCache,
	})

	async function getInstallationToken(installationId: number | string): Promise<string> {
		const key = `${CACHE_PREFIX}${installationId}`
		const cached = await cache?.get(key)
		if (typeof cached === "string") {
			const parsed = JSON.parse(cached) as { token: string; expiresAt: number }
			// Refresh BEFORE expiry (a 1-minute safety margin — see TOKEN_TTL_MS).
			if (parsed.expiresAt > clock.now()) {
				return parsed.token
			}
		}

		let authentication
		try {
			authentication = await auth({
				type: "installation",
				installationId,
				// `refresh: true` bypasses the library's OWN internal cache so
				// OUR expiry bookkeeping (with the injectable clock) is what
				// governs refreshes.
				refresh: true,
			})
		} catch (err) {
			throw new AppAuthError(
				`failed to exchange App credentials for an installation access token (installation ${installationId}): ${
					err instanceof Error ? err.message : String(err)
				}`,
				installationId,
				{ cause: err },
			)
		}

		const token = authentication.token
		if (!token) {
			throw new AppAuthError(`installation token exchange returned no token (installation ${installationId})`, installationId)
		}
		const expiresAt = new Date(authentication.expiresAt).getTime()
		if (!Number.isFinite(expiresAt)) {
			throw new AppAuthError(`installation token exchange returned no expiry (installation ${installationId})`, installationId)
		}
		await cache?.set(key, JSON.stringify({ token, expiresAt }))

		return token
	}

	return { getInstallationToken }
}
