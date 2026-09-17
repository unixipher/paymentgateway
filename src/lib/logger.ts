type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

function serialize(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

// One JSON object per line, which Vercel and most log drains index as structured fields.
function write(level: Level, msg: string, fields: Fields = {}) {
  const entry: Fields = { level, msg, time: new Date().toISOString() };
  for (const [key, value] of Object.entries(fields)) entry[key] = serialize(value);
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, fields?: Fields) => {
    if (process.env.NODE_ENV !== 'production') write('debug', msg, fields);
  },
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
};
