# Vendored security patches

Upstream-verbatim package copies carrying fixes that have no published release, wired as root `devDependencies` with `file:` specs so npm dedupes every transitive consumer whose range they satisfy. Each `package.json` is stripped of upstream `devDependencies`/`scripts` (npm installs link-target devDeps like workspace members — node-forge's toolchain alone pulls ~900 packages).

| package | version | fix | advisory |
| --- | --- | --- | --- |
| `braces` | 3.0.4 | `lib/depth.js` — 256-level nesting cap (`NestingDepthError`) in the `compile`/`expand`/`stringify`/`append` walkers | GHSA-vfj7-8cjw-p6xm — no upstream fix; see micromatch/braces#70 |
| `node-forge` | 1.4.1 | `lib/rsa.js` — nested `DigestAlgorithm` element-count check (digitalbazaar/forge PR #1152, unmerged) | GHSA-86w9-cpqp-85rv |

`vendor/decode-uri-component` was removed 2026-10-26: `query-string` (its only consumer) left the dependency tree, so the CJS port and the nested `query-string → decode-uri-component@^0.5.0` override were deleted together. If a future dependency reintroduces `query-string@7`, `npm audit` will flag its `decode-uri-component@^0.2.2` edge — reinstate the port plus override then; upstream 0.5.x is still ESM-only and cannot serve a CJS `require()`.

**Maintenance contract:** when upstream ships real patched releases (`braces >3.0.3`, `node-forge >1.4.0`), delete the vendor dir + devDep entry and let registry versions dedupe back. Do not bump vendor versions via `version:bump` — they must stay ahead of the advisory ranges but inside the consumers' semver windows.
