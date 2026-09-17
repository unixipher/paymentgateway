// Prisma 7 generates its client as TypeScript. Convert it to plain JavaScript (types are only stripped,
// nothing else changes) so any Node host and bundler can load it without TypeScript support.
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const root = path.join(import.meta.dirname, '..', 'src', 'generated', 'prisma');

function convert(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) convert(file);
    else if (entry.name.endsWith('.ts')) {
      fs.writeFileSync(file.replace(/\.ts$/, '.js'), stripTypeScriptTypes(fs.readFileSync(file, 'utf8')));
      fs.rmSync(file);
    }
  }
}

convert(root);
