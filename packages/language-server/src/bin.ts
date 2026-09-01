#!/usr/bin/env node

import { createConnection, ProposedFeatures } from "vscode-languageserver/node.js";

import { createLanguageServer } from "./server.js";

const connection = createConnection(ProposedFeatures.all);
const server = createLanguageServer(connection, {
  onExit: (code) => {
    process.exitCode = code;
  },
});

server.listen();
