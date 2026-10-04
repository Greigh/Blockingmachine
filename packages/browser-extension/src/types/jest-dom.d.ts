/**
 * Ambient types for the DOM matchers, declared once for the package.
 *
 * `jest.setup.dom.cjs` requires `@testing-library/jest-dom/jest-globals` at runtime, which
 * is what actually installs `toBeDisabled`, `toBeInTheDocument` and the rest. Types do not
 * travel through a `require` in a `.cjs` file — `tsc` reads this package, not the setup
 * file — so without this declaration every component test that used a DOM matcher failed
 * `npm run type-check` while passing under jest, which is the worst combination available.
 *
 * `/jest-globals` rather than the package root, to match the runtime entry: the matchers
 * have to augment the `expect` these tests import from `@jest/globals`, which is required
 * under ESM.
 *
 * A `.d.ts` with an import is types-only, so nothing here reaches the extension bundle.
 */
import '@testing-library/jest-dom/jest-globals';
