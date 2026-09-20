// Regenerates src/lib/sms-headers.generated.ts from TRAI's published register of SMS headers.
//
//   node scripts/build-sms-headers.ts
//
// Source: data/trai/List_SMS_Headers_16062020_0.xlsx (see data/trai/README.md for provenance).
// The register maps every header TRAI has assigned to the entity it belongs to. We keep only the
// headers held by banks, so a bank SMS can be checked against the real assignee rather than a
// hand-written guess. Reads the .xlsx directly with node:zlib so the repo needs no extra dependency.
import { inflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const SOURCE = 'data/trai/List_SMS_Headers_16062020_0.xlsx';
const OUTPUT = 'src/lib/sms-headers.generated.ts';

/** Entities that hold a header and whose name reads like a bank's. */
const BANK_NAME = /\bbank\b|\bbanking\b|\bbanc|sahakari|sahkari|grameen|gramin/i;

/**
 * Names that match BANK_NAME but are not deposit-taking banks: a bank's insurance or broking arm,
 * an employees' association, a training school, a fintech with "bank" in its name. Their SMS must
 * not count as a bank alert. Reviewed against every match in the register.
 */
const NOT_A_BANK = /insurance|\blife\b|securities|asset manag|mutual fund|employees|association|academy|institute|school of|college|foundation|broking|bankit|bazaar|consult|marketing/i;

// ---- Minimal .xlsx (zip) reader ----

/** Files in a zip archive, by name. Handles stored and deflated entries, which is all .xlsx uses. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = findEndOfCentralDirectory(zip);
  if (end < 0) throw new Error('not a zip file: no end-of-central-directory record');

  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();

  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`corrupt central directory at ${at}`);
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const localHeader = zip.readUInt32LE(at + 42);

    // The local header repeats the name and carries its own extra field, so re-read both here.
    const dataAt = localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
    const data = zip.subarray(dataAt, dataAt + compressedSize);
    files.set(name, method === 0 ? data : inflateRawSync(data));

    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  // The record is at the very end unless the archive has a trailing comment, so scan backwards.
  for (let at = zip.length - 22; at >= 0; at--) if (zip.readUInt32LE(at) === 0x06054b50) return at;
  return -1;
}

const unescapeXml = (s: string) =>
  s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const textOf = (xml: string) => unescapeXml([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

/** Rows of the first worksheet, as the columns the register uses: header, then assignee. */
function readRows(xlsx: Buffer): Array<[string, string]> {
  const files = unzip(xlsx);
  const read = (name: string) => {
    const file = files.get(name);
    if (!file) throw new Error(`${name} missing from ${basename(SOURCE)}`);
    return file.toString('utf8');
  };

  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const rows: Array<[string, string]> = [];

  for (const [, row] of read('xl/worksheets/sheet1.xml').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: Record<string, string> = {};
    for (const cell of row.matchAll(/<c r="([A-Z]+)\d+"(?:[^>]*\st="(\w+)")?[^>]*>([\s\S]*?)<\/c>/g)) {
      const [, column, type, body] = cell;
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if (value === undefined) cells[column] = type === 'inlineStr' ? textOf(body) : '';
      else cells[column] = type === 's' ? shared[Number(value)] : unescapeXml(value);
    }
    rows.push([(cells.A ?? '').trim().toUpperCase(), (cells.B ?? '').trim()]);
  }
  return rows;
}

// ---- Build ----

const rows = readRows(readFileSync(SOURCE));
const [heading, ...entries] = rows;
if (!/header/i.test(heading[0]) || !/entity/i.test(heading[1])) {
  throw new Error(`unexpected columns in ${SOURCE}: ${heading.join(', ')}`);
}

const banks = new Map<string, string>();
const rejected: Array<[string, string]> = [];

for (const [header, entity] of entries) {
  // Only the six-character alphanumeric headers a bank alert can arrive from. The register also
  // lists short numeric codes, which are not DLT headers and never carry a bank's SMS.
  if (!/^[A-Z0-9]{6}$/.test(header) || !entity) continue;
  if (!BANK_NAME.test(entity)) continue;
  if (NOT_A_BANK.test(entity)) { rejected.push([header, entity]); continue; }

  const already = banks.get(header);
  if (already && already !== entity) throw new Error(`header ${header} claimed by "${already}" and "${entity}"`);
  banks.set(header, entity);
}

const sorted = [...banks].sort(([a], [b]) => a.localeCompare(b));
const lines = sorted.map(([header, entity]) => `  ${JSON.stringify(header)}: ${JSON.stringify(entity)},`).join('\n');

writeFileSync(OUTPUT, `// Generated by scripts/build-sms-headers.ts from ${SOURCE}. Do not edit by hand.
//
// Every SMS header TRAI has assigned to a bank, mapped to the bank that holds it. An Indian operator
// only delivers SMS from a header registered to the entity sending it, so a header that resolves to
// a bank here is evidence the message really came from that bank.
//
// ${sorted.length} headers held by ${new Set(banks.values()).size} banks.

export const BANK_SMS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
${lines}
});
`);

console.log(`${OUTPUT}: ${sorted.length} headers, ${new Set(banks.values()).size} banks`);
console.log(`excluded ${rejected.length} bank-like entities that are not banks:`);
for (const [header, entity] of rejected) console.log(`  ${header}  ${entity}`);
