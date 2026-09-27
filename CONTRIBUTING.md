# Contributing to jev-judge

Thanks for looking. Bug fixes, sharper rubrics, new judgments and better docs are all welcome. For a new
judgment or a change to what one returns, open an issue first so we can agree on the shape.

## Set up

```bash
npm install     # builds dist/ too (the prepare script)
npm test        # the whole suite, against a fake JevClient: no network, no key
npm run lint    # type check
npm run build   # dist/, ESM and CJS with types
```

`npm run smoke` runs one real call against Jev. It needs `TYPESAFE_API_KEY`, is skipped without it, and
bills your TypeSafe account.

## Where things live

| File | What's there |
| --- | --- |
| `src/client.ts` | `createJevClient` and the retries: the only file that talks to TypeSafe's SDK. |
| `src/judge.ts` | `judgePosts`, `sortByRank`, the rank weights, the relevance gate. |
| `src/kinds.ts` | Kinds of post: validating them, the `choice` question, `classifyPosts`. |
| `src/slop.ts`, `src/humanize.ts` | `checkSlop`, `rateAiStyle`, and the Humanize loop. |
| `src/learn.ts` | Style traits, their contrast, the lessons, and the style guide update. |
| `src/scroll.ts` | `shouldContinueScrolling`. |
| `src/index.ts` | The public API: everything exported is documented in the README. |

## The library's rules

- **Judge, don't write.** jev-judge asks Jev typed questions and returns numbers. Anything that writes text
  takes the caller's own writer as a function, as `humanize` does.
- **Calibrated questions, not parsed prose.** A new judgment asks a `score`, `noul` or `choice` question
  with an explicit rubric. It never asks for JSON in free text.
- **Testable without the network.** Everything goes through `JevClient`, so every test runs on a fake.
- **Degrade, don't fail,** where a caller can go on without an answer: say so in the docs when a function
  does.
- **The README documents every export.** A new one comes with its row in the API table and an example.

## Pull requests

- One change per pull request, with a commit message that starts with its kind: `feat`, `fix`, `docs`,
  `test`, `ci` or `chore`.
- Say what changed and why, with the tests that cover it.
- By contributing, you agree that your work is released under the [MIT license](LICENSE).

Please follow the [code of conduct](CODE_OF_CONDUCT.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md).
