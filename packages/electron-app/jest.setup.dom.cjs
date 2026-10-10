/**
 * Setup for the `dom` project only — mirrors packages/browser-extension/jest.setup.dom.cjs.
 *
 *  1. `@testing-library/jest-dom` — DOM-aware matchers attached to the @jest/globals
 *     `expect` (required under ESM).
 *  2. React's act environment flag, so render/fireEvent updates run through act without
 *     the "not wrapped in act" noise.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS setup file; the repo's dom-test convention requires the jest-globals entry here.
require('@testing-library/jest-dom/jest-globals');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
