export async function solve(xs){let o=[];await Promise.all(xs.map(async x=>o.push(x)));return o}
