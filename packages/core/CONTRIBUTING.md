# Contributing to @blockingmachine/core

Thank you for your interest in contributing to Blockingmachine! This document provides guidelines and instructions for contributing.

## Development Setup

1. Fork and clone the repository:

```bash
git clone https://github.com/yourusername/Blockingmachine.git
cd Blockingmachine/packages/core
```

2. Install dependencies:

```bash
npm install
```

3. Run tests:

```bash
npm test
```

## Development Workflow

1. Create a new branch:

```bash
git checkout -b feature/your-feature-name
```

2. Make your changes and ensure:

   - Tests pass (`npm test`)
   - Code is properly formatted (`npm run format`)
   - Linter is happy (`npm run lint`)

3. Write or update tests for your changes

4. Update documentation as needed

## Commit Guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/). Your commit messages should be structured as follows:

```
feat: add new rule processing feature
^--^  ^-----------------------^
|     |
|     +-> Summary in present tense
|
+-------> Type: feat, fix, docs, style, refactor, test, or chore
```

## Pull Request Process

1. Update the README.md with details of changes if needed
2. Add tests for any new functionality
3. Ensure the test suite passes
4. Update documentation
5. Link any relevant issues

## Code Style

- Use TypeScript
- Follow existing code style
- Include JSDoc comments for public APIs
- Keep functions focused and small
- Write meaningful variable names

## Testing

- Write unit tests for new features
- Maintain existing tests
- Aim for high test coverage
- Run tests before submitting PR:

```bash
npm test
```

## Documentation

- Update README.md for user-facing changes
- Add JSDoc comments for new functions
- Update API documentation
- Include examples for new features

## Questions?

- Open an issue for discussion
- Join our discussions forum
- Check existing documentation

## License and Copyright

By contributing to @blockingmachine/core, you agree that your contributions will be licensed under the BSD 3-Clause License.

### Copyright Notice Requirements

When contributing new files, include this copyright header at the top:

```typescript
/**
 * Copyright (c) 2025, Daniel Hipskind
 * All rights reserved.
 *
 * This source code is licensed under the BSD-3-Clause license found in the
 * LICENSE file in the root directory of this source tree.
 */
```

### License Compliance

Ensure your contributions:

- Do not include code from projects with incompatible licenses
- Maintain all existing copyright and license notices
- Include attribution for any third-party code or resources
- Comply with the BSD 3-Clause license terms

For more details, see the [LICENSE](LICENSE) file in the root directory.
