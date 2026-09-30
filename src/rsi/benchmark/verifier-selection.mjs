export function selectUniqueNamedEntries(entries, expectedName) {
	const selected = entries.filter(([name]) => name === expectedName)
	if (selected.length !== 1) throw new Error("expected exactly one historical regression test named \"" + expectedName + "\", found " + selected.length)
	return selected
}
