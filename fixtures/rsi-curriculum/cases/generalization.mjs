export function solve(value) { const number = Number(value); if (!Number.isFinite(number)) return 'invalid'; return number < 0 ? 'negative' : number > 0 ? 'positive' : 'zero' }
