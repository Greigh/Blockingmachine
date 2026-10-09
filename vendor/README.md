# Vendored security patches

Upstream-verbatim package copies carrying fixes that have no published release,
wired as root `devDependencies` with `file:` specs so npm dedupes every
transitive consumer whose range they satisfy. Each `package.json` is stripped
of upstream `devDependencies`/`scripts` (npm installs link-target devDeps like
workspace members — node-forge's toolchain alone pulls ~900 packages).

| package | version | fix | advisory |
| --- | --- | --- | --- |
| `braces` | 3.0.4 | `lib/depth.js` — 256-level nesting cap (`NestingDepthError`) in the `compile`/`expand`/`stringify`/`append` walkers | GHSA-vfj7-8cjw-p6xm — no upstream fix; see micromatch/braces#70 |
| `node-forge` | 1.4.1 | `lib/rsa.js` — nested `DigestAlgorithm` element-count check (digitalbazaar/forge PR #1152, unmerged) | GHSA-86w9-cpqp-85rv |
| `decode-uri-component` | 0.5.0 | CJS port of upstream 0.5.0's O(n) decoder (upstream ships ESM-only, uncallable from `query-string@7`'s `require()`) | GHSA-vcc3-ghjq-m6fr |

`decode-uri-component@0.5.0` cannot satisfy `query-string@7`'s `^0.2.2` range,
so `package.json` carries a nested override
(`query-string → decode-uri-component@^0.5.0`) pointing that one edge at the
vendored copy.

**Maintenance contract:** when upstream ships real patched releases
(`braces >3.0.3`, `node-forge >1.4.0`, `decode-uri-component >0.4.2`), delete
the vendor dir + devDep entry + override and let registry versions dedupe back.
Do not bump vendor versions via `version:bump` — they must stay ahead of the
advisory ranges but inside the consumers' semver windows.
