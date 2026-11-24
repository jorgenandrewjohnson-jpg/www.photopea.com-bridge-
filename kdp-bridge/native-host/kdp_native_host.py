#!/usr/bin/env python3
"""Read-only, allowlisted KDP native messaging host for locally approved PDF staging.

Native messaging is explicitly installed by the Mac owner. It never writes, deletes,
opens a browser, accesses credentials, or transfers any file except a PDF inside
an owner-authorized publishing folder. Every read is bounded and checks the file's mtime and size.
"""
import base64
import json
import os
from pathlib import Path
import stat
from contextlib import contextmanager
import struct
import sys

MAX_FILE = 250 * 1024 * 1024
CHUNK = 256 * 1024
HOME = Path.home().absolute()
PUBLISHING = HOME / 'Library/Application Support/KDP Brave Bridge/Publishing'
ROOTS = (HOME / 'Desktop', HOME / 'Downloads', PUBLISHING)


def reply(data):
    payload = json.dumps(data, separators=(',', ':')).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


@contextmanager
def open_pdf(value):
    if not isinstance(value, str) or len(value) > 1024:
        raise ValueError('Expected an absolute PDF path')
    path = Path(value)
    if path.parent not in ROOTS or path.suffix.lower() != '.pdf':
        raise ValueError('Select a PDF directly inside Publishing, Desktop or Downloads')
    try:
        root_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=root_fd)
        finally:
            os.close(root_fd)
    except PermissionError as exc:
        raise PermissionError('macOS denied access. Use the private Publishing folder, '
                              'or allow Desktop/Downloads in Files & Folders.') from exc
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_FILE:
            raise ValueError('Expected a regular PDF up to 250 MiB')
        if stream.read(5) != b'%PDF-':
            raise ValueError('Invalid PDF header')
        yield path, stream, info


def handle(a):
    action = a.get('action')
    if action == 'health':
        return {'ok': True, 'version': '0.3.7'}
    if action not in ('stat', 'read'):
        raise ValueError('Unsupported command')
    with open_pdf(a.get('path')) as (path, stream, info):
        if action == 'stat':
            return {'ok': True, 'name': path.name, 'size': info.st_size,
                    'mtime_ns': str(info.st_mtime_ns), 'mime': 'application/pdf'}
        offset, count = a.get('offset'), a.get('count')
        if type(offset) is not int or type(count) is not int:
            raise ValueError('Invalid PDF chunk offset')
        if not (0 <= offset < info.st_size and 1 <= count <= CHUNK and offset + count <= info.st_size):
            raise ValueError('Chunk outside PDF bounds')
        if str(info.st_mtime_ns) != a.get('mtime_ns') or info.st_size != a.get('size'):
            raise ValueError('PDF changed during staging')
        stream.seek(offset)
        data = stream.read(count)
        after = os.fstat(stream.fileno())
        if len(data) != count or (after.st_mtime_ns, after.st_size) != (info.st_mtime_ns, info.st_size):
            raise ValueError('File changed while reading')
        return {'ok': True, 'offset': offset, 'data': base64.b64encode(data).decode('ascii')}


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
