#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((err) => {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exitCode = 1;
  });
