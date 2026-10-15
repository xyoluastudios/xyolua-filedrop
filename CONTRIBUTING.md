# Contributing

Thanks for helping to improve XyoLua FileDrop!

## Getting started

```bash
git clone https://github.com/xyoluastudios/xyolua-filedrop.git
cd xyolua-filedrop
npm install
npm run dev
```

Open <http://localhost:8080>. Uploads end up in `./data`, which is ignored by git.

## Guidelines

- Keep it lightweight: no build step, no frontend framework, and please discuss new runtime dependencies in an issue first.
- Run `npm test` before opening a pull request and add tests for new behaviour (`test/*.test.js`, using `node:test`).
- New UI text goes into `public/assets/i18n.js` in **every** language (English is the fallback).
- Never insert user-provided content with `innerHTML`; use the `h()` helper from `common.js`.
- Security issues: please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change with a clear commit message.
3. Open a pull request describing what changed and why.
