#!/usr/bin/env node
/**
 * The thin part. The Worker cannot watch a job that runs for half an hour -- a scheduled
 * invocation is over in fifteen minutes at the outside -- so the container does not make it
 * watch. A POST starts the job and returns at once; every minute afterwards the Worker asks how it
 * is going, and the answer is a few hundred bytes.
 *
 * That polling is also what keeps the container awake. An instance sleeps after a stretch with no
 * requests, and a job compressing a gigabyte makes no requests at all, so the once-a-minute
 * question is doing two things: reporting, and saying "still needed".
 *
 */
import { spawn } from 'node:child_process';
import http from 'node:http';

/** The one job this container ever runs, and what is known about it */
let job = null;

function start(body) {
  if (job && job.state === 'running') return { started: false, reason: 'already running' };
  const mode = body.mode || 'all';
  const day = body.day || '';
  const args = ['/app/backup.mjs', mode];
  if (day) args.push(day);
  const child = spawn('node', args, {
    env: { ...process.env, ...(body.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  job = { state: 'running', mode, day, startedAt: Date.now(), line: '', result: null, error: null, code: null };

  // Keep the last line, not the whole log: the Worker wants to show progress, and a container
  // holding an hour of output in memory to answer that is a container doing the wrong job.
  const watch = (stream, isErr) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const l of lines) {
        if (!l.trim()) continue;
        process[isErr ? 'stderr' : 'stdout'].write(l + '\n');
        if (l.startsWith('CFMAIL_BACKUP_RESULT ')) {
          try { job.result = JSON.parse(l.slice('CFMAIL_BACKUP_RESULT '.length)); } catch {}
        } else {
          job.line = l.replace(/^\[[^\]]*\]\s*/, '').slice(0, 200);
        }
        if (isErr) job.error = l.slice(0, 300);
      }
    });
  };
  watch(child.stdout, false);
  watch(child.stderr, true);

  child.on('exit', (code) => {
    job.code = code;
    job.state = code === 0 && job.result ? 'done' : 'failed';
    job.finishedAt = Date.now();
  });
  return { started: true };
}

http.createServer((req, res) => {
  const send = (obj, status = 200) => {
    const s = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  };
  if (req.method === 'POST' && req.url === '/run') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      send(start(parsed));
    });
    return;
  }
  if (req.url === '/status') {
    send(job
      ? {
          state: job.state, mode: job.mode, day: job.day, line: job.line,
          started_at: job.startedAt, finished_at: job.finishedAt || null,
          result: job.result, error: job.state === 'failed' ? job.error : null, code: job.code,
        }
      : { state: 'idle' });
    return;
  }
  send({ ok: true, service: 'cfmail-backup' });
}).listen(8080, () => console.log('cfmail-backup container listening on 8080'));
