import { spawn } from 'node:child_process';
import express from 'express';

type CliResult =
  | { ok: true; stdout: string }
  | { ok: false; stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null };

function runCli(args: string[], opts?: { timeoutMs?: number }): Promise<CliResult> {
  const bin = process.env.POLYMARKET_BIN || 'polymarket';
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    const timeoutId = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      stdout += String(buf);
    });
    child.stderr.on('data', (buf) => {
      stderr += String(buf);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeoutId);
      if (code === 0) resolve({ ok: true, stdout });
      else resolve({ ok: false, stdout, stderr, code, signal });
    });
  });
}

function json(res: express.Response, status: number, body: unknown) {
  res.status(status);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

const app = express();

app.get('/api/health', async (_req, res) => {
  const version = await runCli(['--version'], { timeoutMs: 5_000 });
  json(res, 200, {
    ok: true,
    data: {
      polymarket: version.ok ? version.stdout.trim() : null,
      note: 'Set POLYMARKET_BIN to the full path if needed.',
    },
  });
});

app.get('/api/markets', async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 20) || 20));
  const out = await runCli(['--output', 'json', 'markets', 'list', '--limit', String(limit)]);
  if (!out.ok) return json(res, 502, { ok: false, error: 'cli_failed', details: out.stderr || out.stdout });
  try {
    return json(res, 200, { ok: true, data: JSON.parse(out.stdout) });
  } catch {
    return json(res, 502, { ok: false, error: 'bad_json', raw: out.stdout.slice(0, 4000) });
  }
});

app.get('/api/markets/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 20) || 20));
  if (!q) return json(res, 400, { ok: false, error: 'missing_q' });
  const out = await runCli(['--output', 'json', 'markets', 'search', q, '--limit', String(limit)]);
  if (!out.ok) return json(res, 502, { ok: false, error: 'cli_failed', details: out.stderr || out.stdout });
  try {
    return json(res, 200, { ok: true, data: JSON.parse(out.stdout) });
  } catch {
    return json(res, 502, { ok: false, error: 'bad_json', raw: out.stdout.slice(0, 4000) });
  }
});

app.get('/api/markets/get/:slug', async (req, res) => {
  const slug = String(req.params.slug ?? '').trim();
  if (!slug) return json(res, 400, { ok: false, error: 'missing_slug' });
  const out = await runCli(['--output', 'json', 'markets', 'get', slug]);
  if (!out.ok) return json(res, 502, { ok: false, error: 'cli_failed', details: out.stderr || out.stdout });
  try {
    return json(res, 200, { ok: true, data: JSON.parse(out.stdout) });
  } catch {
    return json(res, 502, { ok: false, error: 'bad_json', raw: out.stdout.slice(0, 4000) });
  }
});

app.get('/api/clob/book/:token', async (req, res) => {
  const token = String(req.params.token ?? '').trim();
  if (!token) return json(res, 400, { ok: false, error: 'missing_token' });
  const out = await runCli(['--output', 'json', 'clob', 'book', token]);
  if (!out.ok) return json(res, 502, { ok: false, error: 'cli_failed', details: out.stderr || out.stdout });
  try {
    return json(res, 200, { ok: true, data: JSON.parse(out.stdout) });
  } catch {
    return json(res, 502, { ok: false, error: 'bad_json', raw: out.stdout.slice(0, 4000) });
  }
});

/** Parallel `clob book` for multiple token ids (comma-separated), max 4. */
app.get('/api/clob/books', async (req, res) => {
  const raw = String(req.query.tokens ?? '').trim();
  if (!raw) return json(res, 400, { ok: false, error: 'missing_tokens' });
  const tokens = raw.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 4);
  if (tokens.length === 0) return json(res, 400, { ok: false, error: 'missing_tokens' });

  const books = await Promise.all(
    tokens.map(async (token) => {
      const out = await runCli(['--output', 'json', 'clob', 'book', token]);
      if (!out.ok) {
        return {
          token,
          book: null,
          error: String(out.stderr || out.stdout || 'cli_failed').slice(0, 800),
        };
      }
      try {
        return { token, book: JSON.parse(out.stdout) as unknown, error: null as string | null };
      } catch {
        return { token, book: null, error: 'bad_json' };
      }
    }),
  );

  return json(res, 200, { ok: true, data: books });
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://127.0.0.1:${port}`);
});

