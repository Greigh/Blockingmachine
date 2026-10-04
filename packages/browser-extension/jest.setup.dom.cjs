/**
 * Setup for the `dom` project only.
 *
 * Two things, both of which the node project has no use for:
 *
 *  1. `@testing-library/jest-dom` — the DOM-aware matchers (`toBeDisabled`,
 *     `toBeInTheDocument`, `toHaveTextContent`). They are what let a component test say
 *     what a user would notice rather than what a `querySelector` would return, which is
 *     the difference between testing the popup and testing the DOM.
 *
 *  2. React's act environment. React 19 checks this flag before it will run an update
 *     inside `act`, and Testing Library's `render`/`fireEvent` rely on that path. Without
 *     it every render logs "The current testing environment is not configured to support
 *     act(...)", which is noise that trains people to ignore the one warning that matters.
 *
 * `/jest-globals` is the entry rather than the package root because these tests import
 * `expect` from `@jest/globals` (required under ESM) and the matchers have to be attached
 * to *that* expect, not the global one.
 */
require('@testing-library/jest-dom/jest-globals');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
