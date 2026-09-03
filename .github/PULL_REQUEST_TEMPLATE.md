## Summary of Changes

Brief description of what this PR introduces, fixes, or refactors in `luminarail-backend`.

Related Contributor Issue: Closes #

---

## Type of Change

- [ ] Bug fix (non-breaking change fixing an API issue)
- [ ] New feature (non-breaking change adding an endpoint or worker feature)
- [ ] Breaking change (change breaking existing API contracts or schema)
- [ ] Documentation update
- [ ] Refactoring / Test coverage addition

---

## Verification & Quality Checklist

- [ ] TypeScript check passes cleanly: `npm run type-check`
- [ ] ESLint passes cleanly: `npm run lint`
- [ ] Production build compiles cleanly: `npm run build`
- [ ] All Vitest tests pass cleanly: `npm test`
- [ ] Zod schema validation added for new request parameters
- [ ] Financial amounts use string representation / Decimal handling (no float rounding)
- [ ] Idempotency-Key headers respected for financial mutations
- [ ] No API keys, JWT secrets, database credentials, or Stellar seed phrases committed

---

## Test Verification Output

```bash
npm test
# Paste test results here
```
