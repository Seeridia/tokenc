# Terrazzo bundled-DTCG adapter example

[简体中文](README.zh-CN.md)

This private, non-published workspace demonstrates the narrow interoperability boundary between
Terrazzo and tokenc. Terrazzo remains responsible for loading its sources, running plugins and
transforms, selecting modes, and producing one standard DTCG JSON bundle. The adapter accepts only
that completed bundle.

```bash
vp -C examples/terrazzo-adapter run demo
```

The adapter:

- stores the supplied JSON in a single-document in-memory `DocumentLoader`;
- submits a document request through the public `CompilerSession` API;
- performs no filesystem or network acquisition in the adapter;
- never imports a Core deep path or any Terrazzo package;
- reports unknown extension namespaces as `preserved-unsupported` without interpreting them.

An `unsupported` extension report does not make an otherwise valid DTCG Snapshot invalid. The data
remains available as Token metadata, but tokenc does not claim that it reproduced the extension's
semantics. An `invalid` report means the JSON or an `$extensions` container is malformed; the Core
Snapshot independently carries its canonical compiler diagnostics.

See the complete [Terrazzo coexistence guide](../../docs/TERRAZZO.md) before adapting this example to
a production pipeline.
