# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.
Use GitHub's [private vulnerability reporting](https://github.com/xyoluastudios/xyolua-filedrop/security/advisories/new) instead.
You will get an answer as soon as possible, and a fix will be released before the issue is disclosed.

## Supported versions

Only the latest release receives security fixes.

## Security model in short

- Files are stored **unencrypted** on the server. Operators can read them.
- Drop IDs (~71 bits) and management keys (256 bits) come from a cryptographically secure RNG.
- Drop passwords are hashed with scrypt (N=16384, r=8, p=1). A successful unlock sets an HMAC-signed, HttpOnly,
  `SameSite=Strict` cookie that is scoped to that single drop and valid for at most one hour.
- Wrong drop passwords are rate-limited per IP and per drop, wrong upload passwords per IP.
- State-changing endpoints reject cross-site browser requests (`Sec-Fetch-Site`) and require custom headers or JSON bodies.
- Uploaded files are never executed or rendered by the instance: downloads are `application/octet-stream` attachments,
  the UI uses a strict Content-Security-Policy and never inserts user content as HTML.
- File names are sanitised (path components, control and bidi characters removed) and never used as file-system paths.
