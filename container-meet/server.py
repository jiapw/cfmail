#!/usr/bin/env python3
# The thin part. The Worker starts a broadcast with one POST and ends it with another; in between
# it asks, every so often, how things are going -- which is also what keeps the container awake,
# since an instance with no requests coming in is put to sleep and a compositor makes none.
#
# The compositor itself runs as a child process. A media pipeline can die in ways a Python
# `except` never sees; when it does, this part is still here to say so, and to be told to start
# another.
#
#   GET  /health   -> {"ok": true}
#   POST /start    {"ws": "...", "origin": "...", "out": "rtmps://...", "width": 1280, "height": 720, "fps": 30}
#   POST /stop
#   GET  /status   -> {"running": bool, "code": int|null, "status": {...last status line...}, "tail": [...]}
#
# 薄的那一层。Worker 用一个 POST 开始一场直播,用另一个结束它;其间每隔一阵来问一句进展如何 ——
# 这也正是让容器保持清醒的东西,因为没有请求进来的实例会被休眠,而合成器自己不发任何请求。
#
# 合成器本身作为子进程运行。媒体管线有些死法是 Python 的 `except` 永远看不到的;
# 真到那时,这一层仍然在这里把话说清楚,也能被要求再起一个。
import json
import os
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
lock = threading.Lock()
job = {'proc': None, 'code': None, 'status': None, 'tail': [], 'started': 0, 'out': ''}


def watch(proc):
    for raw in proc.stdout:
        line = raw.rstrip('\n')
        with lock:
            job['tail'].append(line[:400])
            del job['tail'][:-60]
            at = line.find(' status {')
            if at > 0:
                try:
                    job['status'] = json.loads(line[at + 8:])
                except ValueError:
                    pass
    code = proc.wait()
    with lock:
        if job['proc'] is proc:
            job['code'] = code


def start(body):
    with lock:
        if job['proc'] is not None and job['proc'].poll() is None:
            return 409, {'ok': False, 'error': 'already_running'}
    ws = str(body.get('ws') or '')
    out = str(body.get('out') or '')
    if not ws.startswith(('ws://', 'wss://')) or not out.startswith(('rtmp://', 'rtmps://')):
        return 400, {'ok': False, 'error': 'bad_request'}
    args = [sys.executable, '-X', 'faulthandler', os.path.join(HERE, 'compositor.py'), '--ws', ws, '--out', out,
            '--origin', str(body.get('origin') or ''), '--width', str(int(body.get('width') or 1280)),
            '--height', str(int(body.get('height') or 720)), '--fps', str(int(body.get('fps') or 30))]
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    with lock:
        # The address it pushes to carries the stream key; what is remembered is where, not the key.
        # 推流地址里带着推流密钥;记下来的只是"推到哪",不含密钥。
        job.update({'proc': proc, 'code': None, 'status': None, 'tail': [], 'started': time.time(), 'out': out.split('/live/')[0]})
    threading.Thread(target=watch, args=(proc,), daemon=True).start()
    return 200, {'ok': True}


def stop():
    with lock:
        proc = job['proc']
    if proc is None or proc.poll() is not None:
        return 200, {'ok': True, 'running': False}
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()
    return 200, {'ok': True, 'running': False}


def status():
    with lock:
        proc = job['proc']
        running = proc is not None and proc.poll() is None
        return 200, {'running': running, 'code': None if running else job['code'], 'status': job['status'],
                     'since': job['started'], 'tail': job['tail'][-20:]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def reply(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/health'):
            return self.reply(200, {'ok': True})
        if self.path.startswith('/status'):
            return self.reply(*status())
        self.reply(404, {'error': 'not_found'})

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        try:
            body = json.loads(self.rfile.read(n) or b'{}') if n else {}
        except ValueError:
            return self.reply(400, {'ok': False, 'error': 'bad_json'})
        if self.path.startswith('/start'):
            return self.reply(*start(body))
        if self.path.startswith('/stop'):
            return self.reply(*stop())
        self.reply(404, {'error': 'not_found'})


def main():
    port = int(os.environ.get('PORT', '8080'))
    srv = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    signal.signal(signal.SIGTERM, lambda *_a: (stop(), os._exit(0)))
    print(f'meet compositor control on :{port}', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
