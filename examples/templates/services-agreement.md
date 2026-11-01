---
fields:
  $fee:
    label: Monthly fee
    minimum: "500.00"
  $notice_days:
    label: Notice period (days)
    allowed_values: [30, 60, 90]
    default: 30
  $start_date:
    label: Start date
---

# Software development services agreement

This agreement is made between **Automaze Ltd** ("Provider") and {{$client_name:text}} ("Client"). It starts on {{$start_date:date}}.

## 1. Services

Provider will deliver software development services as agreed in writing between the parties. Each piece of work is described in a statement of work that both parties approve by email.

## 2. Fees

| Item | Amount |
|---|---|
| Monthly retainer | {{$fee:currency(USD)}} |

Provider invoices at the start of each month. Invoices are due within 14 days.

## 3. Intellectual property

Client owns the work product once it has paid for it in full. Provider keeps its pre-existing tools and know-how.

## 4. Confidentiality

Each party keeps the other party's confidential information private and uses it only for this agreement.

## 5. Termination

Either party may end this agreement with {{$notice_days:number}} days' written notice.

## 6. Signatures

**Client**

Name: {{client.full_name:text}}

Title: {{client.title:text}}

Signature: {{client.signature:signature}}

Date: {{client.date:date}}

**Provider**

Signature: {{provider.signature:signature}}
