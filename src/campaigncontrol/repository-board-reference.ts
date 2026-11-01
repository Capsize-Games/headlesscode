const PREFIX = "http://127.0.0.1:8078/api/cards/" +
	"1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7#hc-repository-result-"

export function validPrivateBoardRef(value: string, isV2: boolean): boolean {
	const prefix = PREFIX + (isV2 ? "v2:" : "v1:")
	return value.startsWith(prefix) &&
		/^[a-f0-9]{64}$/.test(value.slice(prefix.length))
}
