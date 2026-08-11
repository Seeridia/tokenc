# Compiler benchmarks

Run the repeatable local benchmark foundation with:

```bash
vp run bench
```

The suite measures tokenc against itself. It covers 1k and 10k independent-token cold compiles, a 10k alias chain, high fan-out, sparse theme contexts, and a 10k-token incremental session where one primitive has eleven dependents.

Results are wall-clock measurements and vary by runtime and machine. They are not claims against other token tools. Record the Node.js version, CPU, and commit when using results for regression analysis.
