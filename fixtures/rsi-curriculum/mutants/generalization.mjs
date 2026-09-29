export function solve(value) { if (typeof value !== 'number') return 'invalid'; return value < 0 ? 'negative' : value > 0 ? 'positive' : 'zero' }
