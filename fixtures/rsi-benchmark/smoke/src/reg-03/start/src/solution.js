export function solve(xs){return [...xs].sort((a,b)=>b.p-a.p).map(x=>x.id)}
