## Description

<!-- Provide a clear and concise description of what this PR does -->

## Related Issue

<!-- This PR should be linked to an approved issue. If not, please create an issue first. -->

Fixes #<!-- issue number -->

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Code refactoring (no functional changes)
- [ ] Performance improvement

## Component(s) Affected

- [ ] Backend (`backend/`)
- [ ] CLI (`cli/`)
- [ ] Daemon (`packages/daemon/`)
- [ ] Protocol Core (`packages/protocol-core/`)
- [ ] Frontend (`frontend/`)

## How Has This Been Tested?

- [ ] Backend tests pass (`cd backend && uv run pytest tests/`)
- [ ] Frontend builds successfully (`cd frontend && npm run build`)
- [ ] Package tests pass for changed TypeScript packages
- [ ] Manual testing performed (describe below)

**Test Details:**
<!-- Describe your testing approach -->

## Checklist

### Code Quality
- [ ] My code follows the project's style guidelines
- [ ] Server code uses `async def` for all route handlers and I/O functions
- [ ] I have performed a self-review of my code
- [ ] My changes generate no new warnings or errors

### Testing
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing tests pass locally with my changes

### Documentation
- [ ] I have updated relevant documentation (if applicable)
- [ ] I have added/updated docstrings for new/modified functions

### Cross-Component
- [ ] If modifying crypto/signing logic, changes are consistent across backend and package consumers
- [ ] If modifying session key derivation, changes are consistent across backend and daemon paths

## Screenshots (if applicable)

<!-- Add screenshots for UI changes -->

## Additional Context

<!-- Add any other context about the PR here -->

## Pre-Submission Verification

- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] This PR addresses an approved issue that was assigned to me
- [ ] I have not included unrelated changes in this PR
- [ ] My PR title follows conventional commits format (e.g., `feat: add user authentication`)
