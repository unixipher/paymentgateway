# TRAI sources for bank SMS verification

Indian commercial SMS runs under TRAI's **Telecom Commercial Communications Customer Preference
Regulations, 2018** (TCCCPR) and its amendments. Two things in that framework make a bank's SMS
worth trusting, and both are used by [`src/lib/dlt.ts`](../../src/lib/dlt.ts):

- An operator may only deliver an alphanumeric-sender SMS from a **header registered to the sender**,
  and TRAI publishes who holds each header. So a header is a claim of identity that can be checked.
- No international incoming SMS may carry an alphanumeric header at all, which is what stops a
  stranger abroad from sending as `VM-HDFCBK`.

## Files

| File | What it is |
| --- | --- |
| `List_SMS_Headers_16062020_0.xlsx` | TRAI's register of assigned SMS headers: 23,192 rows of header → the entity that holds it. Published 16 June 2020. |

Checked in because `scripts/build-sms-headers.ts` reads it to generate
[`src/lib/sms-headers.generated.ts`](../../src/lib/sms-headers.generated.ts). Regenerate with:

```sh
node scripts/build-sms-headers.ts
```

The generator keeps the 1,582 headers held by the 673 entities whose names read like a bank's, and
prints the bank-like entities it excluded (insurance and broking arms, an employees' association, a
training school, a fintech called BANKIT) so the exclusions can be reviewed on every run.

## Not checked in

These are reference only, and are large. Download them again from TRAI if needed:

- **`Detail_Header_Prefixes_16062020_0.pdf`** — the header format `XY-ABCDEF`, with the tables of
  operator codes (`X`) and licensed service area codes (`Y`). Both tables are transcribed into
  `OPERATOR_CODES` and `SERVICE_AREA_CODES` in `src/lib/dlt.ts`.
- **`trai-tcccp-regulation-2025.pdf`** — TCCCP (Second Amendment) Regulations, 2025, gazetted
  12 February 2025. Source of the `-P`/`-S`/`-T`/`-G` suffix meaning promotional, service,
  transactional and government, which is why a `-P` message is never treated as a bank alert.
- **`CA_21052026.pdf`** — the 2018 regulations consolidated with every amendment, as of
  21 May 2026. The authoritative text.

Source: <https://www.trai.gov.in/node/7411>

## Staleness

The register is from 2020, so a header assigned since then is genuine but absent from it. Two ways
to add one, both in preference to loosening the check:

- `HEADERS_ADDED_SINCE_THE_REGISTER` in `src/lib/dlt.ts`, for a bank many merchants use, with a
  comment saying how the header was confirmed. `KOTAKD` (Kotak811) is there for this reason.
- The `TRUSTED_SMS_SENDERS` environment variable, for one deployment's own banks.

If TRAI publishes a newer register, replace the `.xlsx` here and re-run the generator.
