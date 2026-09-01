import { createLanguageServer } from "@tokenc/language-server";
import { createConnection, ProposedFeatures } from "vscode-languageserver/node.js";

const connection = createConnection(ProposedFeatures.all);
const server = createLanguageServer(connection, {
  onExit: (code) => {
    process.exitCode = code;
  },
});

server.listen();
