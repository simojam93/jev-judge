# Security

Please report a vulnerability privately. Don't open a public issue for it. Use **Report a vulnerability**
on the repository's [Security tab](https://github.com/simojam93/jev-judge/security/advisories/new), GitHub's
private vulnerability reporting.

Please include what you found, how to reproduce it, and the version or commit you tested. You'll get an
answer as soon as possible, and credit in the fix if you want it.

jev-judge reads your TypeSafe API key from `TYPESAFE_API_KEY`, or from `createJevClient({ apiKey })`, and
sends it only to TypeSafe. It never logs it.
