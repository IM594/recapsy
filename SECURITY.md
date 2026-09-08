# Security Policy

Recapsy's free tier keeps every byte on your machine, so most security questions are about what the app does locally: capture, storage, retention, export and the MCP server.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting on this repository's **Security** tab. You will get an acknowledgement within a few days and a fix or a written assessment as soon as one exists.

Include what you observed, how to reproduce it, and which version or commit you were running.

## Scope

- Data leaving the device when the "what leaves your device" page says it does not
- Capture, OCR text or summaries readable by other local users or processes without permission
- Retention or deletion behaving differently from the rules shown in the app
- MCP server exposure beyond the local machine

Findings in third-party models or endpoints you configure yourself are out of scope; report those to their providers.
