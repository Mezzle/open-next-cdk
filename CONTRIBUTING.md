# Contributing to open-next-cdk

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- Node.js 20 or later
- [pnpm](https://pnpm.io/)
- Familiarity with [AWS CDK](https://docs.aws.amazon.com/cdk/) and [OpenNext](https://opennext.js.org/)

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm run build

# Run tests
pnpm test

# Run tests with coverage
pnpm run test:coverage

# Lint
pnpm run lint

# Lint and auto-fix
pnpm run lint:fix
```

## Pull Requests

1. Fork the repo and create a branch from `main`.
2. Make your changes and add tests for any new functionality.
3. Ensure `pnpm run build`, `pnpm test`, and `pnpm run lint` all pass.
4. Open a pull request with a clear description of the change.

## Code Style

This project uses [Biome](https://biomejs.dev/) for linting and formatting. Run `pnpm run lint:fix` to auto-fix issues. There is no separate formatter step — Biome handles both.

## Reporting Issues

Use [GitHub Issues](https://github.com/Mezzle/open-next-cdk/issues) to report bugs or request features. Please check existing issues before opening a new one.
