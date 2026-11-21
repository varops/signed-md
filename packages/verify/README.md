# signed-md

Check a [Signed.md](https://github.com/varops/signed-md) agreement offline. You don't need an account, the sender's server or an internet connection.

When everyone has signed, Signed.md gives each party an evidence package: a ZIP with the signed Markdown, the sealed PDF, a hash-chained evidence log and a signed manifest. This tool checks that nothing in it was changed.

## Usage

You need Node.js 20 or later.

```bash
npx signed-md verify agreement.zip
```

To also check who signed it, pass the sender's public keys:

```bash
npx signed-md verify agreement.zip --keys signed-md-keys.json
```

Get `signed-md-keys.json` from the sender's server once, at `https://<their server>/.well-known/signed-md-keys.json`, and keep it. Without `--keys`, the package is checked against the public key it carries. That proves the package is intact, but not who made it.

Add `--json` to print the full report as JSON.

## What it checks

- Every file matches the signed manifest, and the manifest signature is valid.
- The PDF's PAdES seal is valid and the PDF wasn't changed after sealing.
- The RFC 3161 timestamps, when the package has them.
- The evidence log's hash chain is intact.
- Every signer signed the exact text of the agreement.

Example output, shortened:

```text
Mutual NDA (doc_3ytrryxfn5b4qjhkxw18)
Revision rev_b74005c16ce436bf916218d24c7e4b0a · key smdk_b8ab402827010b3c

  ✓ manifest signature valid
  ✓ file agreement.md
  ✓ PDF signature valid  – CN=Acme (Signed.md), O=Acme
  ✓ PDF not changed after signing
  ✓ PDF signature timestamp  – 2026-11-20T12:06:14.000Z by C=US, O=DigiCert\, Inc., …
  ✓ evidence chain  – 16 events
  ✓ agreement.md matches the sent document
  ✓ signer a signed  – Jane Doe <jane@example.com>

VALID: the package is intact. Pass --keys to also check who signed it.
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Valid |
| `1` | Invalid: the package was changed or is incomplete |
| `2` | Wrong usage, or a file couldn't be read |

## License

AGPL-3.0-only. Signed.md is not a law firm and this is not legal advice. See [docs/legal.md](https://github.com/varops/signed-md/blob/main/docs/legal.md).
