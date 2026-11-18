# Legal compatibility

> **This is not legal advice.** This page explains how Signed.md is designed to meet common requirements for electronic signatures. Whether a particular signature is valid depends on your country, the type of document, the people signing and the facts of each case. Consult an attorney before relying on Signed.md for agreements that matter to you. Signed.md is provided as is, without warranty (see the [licence](../LICENSE)).

## What Signed.md creates

Signed.md creates **simple electronic signatures** (SES), the most common kind, used for most business agreements. A signer opens a personal link sent to their email, agrees to sign electronically, fills in their fields, adopts a typed or drawn signature and selects **Finish**.

Signed.md does not create advanced or qualified electronic signatures (eIDAS AES or QES). Those need stronger identity checks, such as an ID document or a qualified trust service. Some agreements, or some countries, require them.

## How Signed.md meets common requirements

### United States: ESIGN Act and UETA

The federal ESIGN Act (15 U.S.C. §7001 and following) and the Uniform Electronic Transactions Act, adopted by most states, give electronic signatures and records the same legal effect as paper, if certain conditions are met.

| Requirement | How Signed.md meets it | Where it is recorded |
|---|---|---|
| **Intent to sign.** The person meant to sign. | The signer adopts a signature next to the statement "By selecting Adopt and sign, I agree that this is my electronic signature for this document", then selects **Finish**. | `signer.signed` event; the adopted signature on the PDF's completion page |
| **Consent to do business electronically** (UETA §5). | Before the document opens, the signer must agree to sign electronically. They can decline at any time before finishing. | `signer.consented` event with the exact text shown |
| **Consumer disclosures** (ESIGN §101(c)). Before consenting, consumers must be told about paper copies, withdrawing consent, what the consent covers, updating contact details, and the hardware and software needed, and must consent in a way that shows they can open electronic records. | The signer sees a disclosure covering each point, with the sender's contact details, and confirms they can open and read it. | The full disclosure text and its version are stored with the consent event |
| **Signature linked to the record.** | Each signature is tied to one exact revision of the document. The revision is a hash of the content, values, signers and settings. | `agreement.json`, `signatures.json`, the evidence log |
| **Attribution** (UETA §9). The signature can be shown to be the act of the person. | Each signer gets their own expiring link, sent to their email. The IP address, device and time of each step are recorded. | The evidence log, and the completion page of the PDF |
| **Accurate, retainable records** (ESIGN §101(d)). The record can be kept and reproduced accurately. | The signed PDF is PDF/A-2b (archival), sealed (PAdES) and timestamped. Every signer gets it by email. The sender keeps the full evidence package. | `signed.pdf`, the package ZIP |

### European Union: eIDAS

Under the eIDAS Regulation (EU) No 910/2014, Article 25(1), an electronic signature cannot be denied legal effect or admissibility as evidence just because it is electronic, or because it is not advanced or qualified. A simple electronic signature is data in electronic form, attached to or logically linked with other data, that the signer uses to sign.

| What courts look at | How Signed.md meets it |
|---|---|
| The signature is linked to the document | The signature is part of the sealed PDF and tied to the document's revision hash. |
| Who signed | The signer's personal email link, plus IP address, device and times for each step. |
| The document hasn't changed since | The PDF seal (PAdES) and the signed package manifest show any change. Anyone can check this offline with `npx signed-md verify`. |
| When it was signed | RFC 3161 timestamps on the PDF seal and on the package, from DigiCert by default (`TSA_URL`). These are trusted, but not "qualified" timestamps under eIDAS. Qualified timestamps carry a stronger legal presumption of accuracy. |

### United Kingdom

UK law accepts electronic signatures under the Electronic Communications Act 2000 and the retained UK eIDAS Regulation, and English courts have long accepted them for most contracts. The same evidence applies.

### Other countries

Many countries have similar laws based on the UNCITRAL Model Law on Electronic Signatures. Check the rules where you and your signers are.

## What Signed.md doesn't cover

- **Documents some laws exclude from electronic signature.** Examples include wills and testamentary trusts, some family law matters, court orders, some real-estate transfers, notarised or witnessed documents, and certain consumer notices (in the US, for example, utility shut-off and eviction notices). The list differs by country and state.
- **Advanced and qualified signatures** (eIDAS AES and QES), and identity checks beyond email.
- **A "trusted signer" check in Adobe Reader.** By default, each installation seals PDFs with its own self-signed certificate. Adobe shows the document as unchanged and the timestamp as valid, but the signer as unknown. To get the green check, install a certificate from a provider on the Adobe Approved Trust List (`PDF_SIGNING_KEY_FILE` and `PDF_SIGNING_CERT_FILE`).

## The sender's responsibilities

Signed.md is a tool. The people and organisations that send documents with it are responsible for how they use it. In particular:

- Use it only for documents that may be signed electronically where you and your signers are.
- Send each signing link to the right person's email address. The link is the main evidence of who signed.
- Keep the contact details in the disclosure accurate. Signed.md uses the document owner's name and email.
- Honour what the disclosure promises signers, such as a free paper copy on request.
- Keep the completed packages for as long as you need them as records.
- For high-value or high-risk agreements, consider extra identity checks outside Signed.md.

## The evidence in each package

Each completed agreement comes as a ZIP:

- **`agreement.md`**: the exact Markdown that was signed.
- **`signed.pdf`**: the PDF/A-2b document, sealed and timestamped, with a completion page listing each signer's events, IP address, device and signature.
- **`evidence.json`**: a hash-chained log of every event: sent, opened, consented (with the full disclosure text), signed, declined, completed.
- **`signatures.json`** and **`agreement.json`**: the signatures and the document's details.
- **`manifest.json`**, **`manifest.sig`**, **`manifest.tsr`**: the list of files with their hashes, signed by the installation's key and timestamped.

Anyone can check a package offline, without contacting the server:

```bash
npx signed-md verify agreement.zip
```

## Again: not legal advice

This page describes how Signed.md works and how it is designed to line up with these laws. It doesn't say that any particular agreement is valid or enforceable. If it matters, ask an attorney.
