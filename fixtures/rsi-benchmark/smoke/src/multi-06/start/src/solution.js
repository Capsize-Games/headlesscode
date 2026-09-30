import {ascii} from "./helper.js";export function solve(s){return ascii(s).toLowerCase().replace(/\s+/g,"-")}
