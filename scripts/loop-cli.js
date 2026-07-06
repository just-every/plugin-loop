#!/usr/bin/env node
"use strict";

const { main } = require("./ultracode-cli");

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
