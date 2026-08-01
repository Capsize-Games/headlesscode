/**
 * Local embedder — Phase 3 placeholder for a real local embedding model.
 *
 * `createLocalEmbedder()` returns a dependency-free, deterministic embedder:
 * the text is tokenized into lowercase word tokens + character bigrams, each
 * token is hashed into a fixed-dimension vector (default 256) with a stable
 * 32-bit hash, and the vector is L2-normalized. Cosine similarity over these
 * vectors gives a cheap lexical-overlap similarity signal.
 *
 * This is the ZERO-DEPENDENCY stand-in the spec calls for (a local embedding
 * model with no cloud routing / no rate limiter / no encryption). A real local
 * embedding model can be swapped in behind the `Embedder` interface
 * (src/memory/types.ts) later WITHOUT touching any caller.
 *
 * Determinism guarantees:
 *   - Same input string → same vector (across calls AND across processes).
 *   - No Math.random, no platform-dependent iteration order.
 *   - Hashing is pure FNV-1a; dims must be ≥ 1.
 */

import type { Embedder } from "./types.js"

/** FNV-1a 32-bit hash — pure, deterministic, platform-independent. */
export function fnv1a(text: string): number {
	let hash = 0x811c9dc5
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return hash >>> 0
}

/**
 * Tokenize into lowercase word tokens (len > 1) + character bigrams of the
 * lowercased string. Deterministic order: words first, then bigrams.
 */
export function tokenize(text: string): string[] {
	const lower = text.toLowerCase()
	const words = lower.match(/[a-z0-9]+/g) ?? []
	const tokens = words.filter((w) => w.length > 1)
	for (let i = 0; i + 1 < lower.length; i++) {
		const bigram = lower.slice(i, i + 2)
		if (/[a-z0-9]/.test(bigram[0]) && /[a-z0-9]/.test(bigram[1])) {
			tokens.push(bigram)
		}
	}
	return tokens
}

/**
 * Create a deterministic local embedder.
 *
 * @param dims  fixed vector dimension (default 256). Must be a positive int.
 */
export function createLocalEmbedder(dims = 256): Embedder {
	if (!Number.isInteger(dims) || dims <= 0) {
		throw new Error(`createLocalEmbedder: dims must be a positive integer (got ${dims})`)
	}
	return {
		embed(text: string): number[] {
			const vector = new Array<number>(dims).fill(0)
			for (const token of tokenize(text)) {
				vector[fnv1a(token) % dims] += 1
			}
			return l2Normalize(vector)
		},
	}
}

/**
 * Cosine similarity between two vectors. Zero vectors (or zero norms) yield 0.
 * Handles different lengths by treating missing entries as 0.
 */
export function cosine(a: number[], b: number[]): number {
	let dot = 0
	let normA = 0
	let normB = 0
	const len = Math.max(a.length, b.length)
	for (let i = 0; i < len; i++) {
		const av = a[i] ?? 0
		const bv = b[i] ?? 0
		dot += av * bv
		normA += av * av
		normB += bv * bv
	}
	if (normA === 0 || normB === 0) {
		return 0
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** Convenience: cosine similarity of two texts through an embedder. */
export function similarity(embedder: Embedder, a: string, b: string): number {
	return cosine(embedder.embed(a), embedder.embed(b))
}

function l2Normalize(vector: number[]): number[] {
	let norm = 0
	for (const v of vector) {
		norm += v * v
	}
	if (norm === 0) {
		return vector
	}
	const scale = 1 / Math.sqrt(norm)
	for (let i = 0; i < vector.length; i++) {
		vector[i] *= scale
	}
	return vector
}
