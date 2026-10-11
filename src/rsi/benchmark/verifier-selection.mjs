export function selectUniqueNamedEntries(entries, expectedName) {
	const selected = entries.filter(([name]) => name === expectedName)
	if (selected.length !== 1) throw new Error('expected exactly one matching name; found ' + selected.length)
	return selected
}
