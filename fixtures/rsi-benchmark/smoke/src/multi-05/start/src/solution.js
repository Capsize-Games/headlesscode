import {merge} from "./helper.js";export function solve(x){return merge({server:{host:"localhost",port:80},retry:{count:2}},x)}
