#!/usr/bin/env node
import { buildProgram } from "./program.js";
const origEmit = process.emit.bind(process) as any;
(process as any).emit = (name: string, ...args: any[]) =>
  name === "warning" && args[0]?.name === "ExperimentalWarning" && /SQLite/i.test(args[0]?.message ?? "")
    ? false
    : origEmit(name, ...args);
const { main } = buildProgram();
main(["mcp"]).then((code) => {
  process.exitCode = code;
});
