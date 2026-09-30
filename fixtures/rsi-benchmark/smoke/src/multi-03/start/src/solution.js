import {cents} from "./helper.js";export function solve(xs){return cents(xs.reduce((s,x)=>s+x.qty*x.price,0))}
