<p align="center">
  <a href="https://github.com/varops/signed-md"><img src="https://raw.githubusercontent.com/varops/signed-md/main/brand/signedmd-light.svg" alt="Signed.md" height="56"></a>
</p>

<h3 align="center">Check a signed agreement yourself</h3>

<p align="center">
  The offline verifier for <a href="https://github.com/varops/signed-md">Signed.md</a> evidence packages.<br>No account, no server, no internet connection.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/signed-md"><img src="https://img.shields.io/npm/v/signed-md?color=1c1917&label=npm" alt="npm version"></a>
  <a href="https://github.com/varops/signed-md/blob/main/LICENSE"><img src="https://img.shields.io/badge/licence-AGPL--3.0-1c1917" alt="Licence: AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/dependencies-0-f6da1c" alt="No dependencies">
  <img src="https://img.shields.io/badge/works-offline-1c1917" alt="Works offline">
</p>

---

When everyone has signed, [Signed.md](https://github.com/varops/signed-md) gives each party an evidence package: a ZIP with the signed Markdown, the sealed PDF, a hash-chained evidence log and a signed manifest.

You shouldn't have to trust the company that sent it. Run one command and see for yourself that nothing was changed after signing:

```bash
npx signed-md verify agreement.zip
```

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

The output above is shortened. A real run lists every file and check.

## Also check who sent it

A package carries its own public key. That proves nothing inside it was changed, but anyone could make a package with their own key. To check it came from the sender's installation, compare it with the sender's published keys:

1. Download the keys once from the sender's server, and keep the file:

   ```bash
   curl -o signed-md-keys.json https://sign.example.com/.well-known/signed-md-keys.json
   ```

2. Verify against them:

   ```bash
   npx signed-md verify agreement.zip --keys signed-md-keys.json
   ```

```text
VALID: the package is intact and signed by a key you trust.
```

Keep the keys file you downloaded first. If a later package only matches keys fetched later, ask the sender why their key changed.

## What it checks

| Check | What it proves |
|---|---|
| Manifest and its signature | Every file in the ZIP is the one the server sealed. Nothing was added, removed or edited. |
| PDF seal (PAdES) | The PDF wasn't changed after signing. PDF readers like Adobe Acrobat check the same seal. |
| Timestamps (RFC 3161) | A trusted time authority saw the sealed PDF at that time, when the package has a timestamp. |
| Evidence chain | Each event (sent, viewed, consented, signed) links to the one before it by hash. None was removed or reordered. |
| Agreement text | Every signer signed the exact text in `agreement.md`, word for word. |
| Keys (with `--keys`) | The package was sealed by the installation whose keys you trust. |

## Options

```text
signed-md verify <agreement.zip> [--keys <keys.json>] [--json]
```

| Option | Description |
|---|---|
| `--keys <file>` | A keys file you trust, from the sender's `/.well-known/signed-md-keys.json`. |
| `--json` | Print the full report as JSON, for scripts and CI. |
| `--help` | Show the usage. |

| Exit code | Meaning |
|---|---|
| `0` | Valid |
| `1` | Invalid: the package was changed, is incomplete, or isn't a Signed.md package |
| `2` | Wrong usage, or a file couldn't be read |

You need Node.js 20 or later. The command is one bundled file with no dependencies. It reads only the files you give it and never connects to the internet.

## About Signed.md

[Signed.md](https://github.com/varops/signed-md) is open-source document signing you host yourself. AI agents draft agreements from approved Markdown templates, over MCP or a REST API. People review, approve and send them, and signers sign in the browser. Every completed agreement becomes a sealed, timestamped PDF/A plus the evidence package this tool checks.

## Licence

AGPL-3.0-only. This tool checks that a package is intact. It doesn't tell you whether an agreement is legally binding where you are, and it isn't legal advice. See [how Signed.md fits ESIGN, UETA, eIDAS and UK law](https://github.com/varops/signed-md/blob/main/docs/legal.md).
