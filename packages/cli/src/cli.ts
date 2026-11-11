#!/usr/bin/env node
import { buildProgram } from "./program.js";
// Silence node:sqlite's ExperimentalWarning (it would otherwise pollute stderr on every run).
const origEmit = process.emit.bind(process) as any;
(process as any).emit = (name: string, ...args: any[]) =>
  name === "warning" && args[0]?.name === "ExperimentalWarning" && /SQLite/i.test(args[0]?.message ?? "")
    ? false
    : origEmit(name, ...args);
const { main } = buildProgram();
main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
