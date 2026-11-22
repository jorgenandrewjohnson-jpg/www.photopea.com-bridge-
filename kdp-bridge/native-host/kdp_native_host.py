#!/usr/bin/env python3
"""Read-only, allowlisted KDP native messaging host for locally approved PDF staging.

Native messaging is explicitly installed by the Mac owner. It never writes, deletes,
opens a browser, accesses credentials, or transfers any file except a PDF inside
Desktop or Downloads. Every read is bounded and checks the file's mtime and size.
"""
import base64
import json
import os
from pathlib import Path
import struct
import sys

MAX_FILE = 250 * 1024 * 1024
CHUNK = 256 * 1024
HOME = Path.home().resolve()
ROOTS = tuple((HOME / name).resolve() for name in ('Desktop', 'Downloads'))


def reply(data):
    payload = json.dumps(data, separators=(',', ':')).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def location(value):
    if not isinstance(value, str) or len(value) > 1024 or not value.startswith('/'):
        raise ValueError('Expected an absolute path')
    path = Path(value)
    if path.suffix.lower() != '.pdf' or path.is_symlink():
        raise ValueError('Only non-symlink PDF files are allowed')
    resolved = path.resolve(strict=True)
    if resolved.parent not in ROOTS or not resolved.is_file():
        raise ValueError('The PDF must be directly on Desktop or in Downloads')
    st = resolved.stat()
    if st.st_size <= 0 or st.st_size > MAX_FILE:
        raise ValueError('PDF is empty or exceeds the 250-MiB limit')
    with resolved.open('rb') as stream:
        if stream.read(5) != b'%PDF-':
            raise ValueError('Selected file is not a valid PDF header')
    return resolved, st


def handle(a):
    action = a.get('action')
    if action == 'health':
        return {'ok': True, 'version': '0.3.1'}
    path, st = location(a.get('path'))
    if action == 'stat':
        return {'ok': True, 'name': path.name, 'size': st.st_size,
                'mtime_ns': str(st.st_mtime_ns), 'mime': 'application/pdf'}
    if action == 'read':
        offset, count = a.get('offset'), a.get('count')
        if not isinstance(offset, int) or not isinstance(count, int):
            raise ValueError('Invalid PDF chunk offset')
        if not (0 <= offset < st.st_size and 1 <= count <= CHUNK and offset + count <= st.st_size):
            raise ValueError('Chunk outside PDF bounds')
        if str(st.st_mtime_ns) != a.get('mtime_ns') or st.st_size != a.get('size'):
            raise ValueError('PDF changed during staging')
        with path.open('rb') as f:
            f.seek(offset)
            data = f.read(count)
        if len(data) != count:
            raise ValueError('File changed while reading')
        return {'ok': True, 'offset': offset, 'data': base64.b64encode(data).decode('ascii')}
    raise ValueError('Unsupported command')


def main():
    while True:
        raw = sys.stdin.buffer.read(4)
        if not raw:
            break
        if len(raw) != 4:
            break
        length = struct.unpack('<I', raw)[0]
        if length < 2 or length > 4096:
            break
        a = None
        try:
            a = json.loads(sys.stdin.buffer.read(length))
            if not isinstance(a, dict):
                raise ValueError('Expected a JSON object')
            reply({'id': a.get('id'), **handle(a)})
        except Exception as exc:
            reply({'id': a.get('id') if isinstance(a, dict) else None, 'ok': False, 'error': str(exc)[:300]})


if __name__ == '__main__':
    main()
