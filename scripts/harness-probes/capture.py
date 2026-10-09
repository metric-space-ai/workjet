#!/usr/bin/env python3
"""Bound a CLI probe and save a reviewable, sanitized receipt (stdlib only)."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time


def redact(text):
    text = re.sub(r'(?i)(Bearer\s+)[^\s"\\]+', r'\1<redacted>', text)
    text = re.sub(r'\b(?:sk-|gho_|ghp_)[A-Za-z0-9_-]{12,}', '<redacted>', text)
    text = re.sub(r'(?i)("(?:access_token|refresh_token|api_key|apiKey|authorization|cookie|credential|ticket|sessionToken|desktopBootstrapToken)"\s*:\s*")[^"]*', r'\1<redacted>', text)
    text = re.sub(r'(?i)([?&](?:token|wsTicket|pairingToken)=)[^&\s"\\]+', r'\1<redacted>', text)
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--name', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--cwd', required=True)
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    cmd = args.command[1:] if args.command[:1] == ['--'] else args.command
    started = time.monotonic()
    result = {'name': args.name, 'time': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'command': cmd, 'cwd': args.cwd, 'timeout_seconds': args.timeout}
    child = None
    try:
        child = subprocess.Popen(cmd, cwd=args.cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, start_new_session=True)
        result['pid'] = child.pid
        try:
            stdout, stderr = child.communicate(timeout=args.timeout)
        except subprocess.TimeoutExpired:
            result['timed_out'] = True
            child.terminate()
            try:
                stdout, stderr = child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                stdout, stderr = child.communicate()
        result.update(exit_code=child.returncode, stdout=redact(stdout), stderr=redact(stderr))
    except OSError as error:
        result.update(exit_code=None, error=str(error))
    result['elapsed_seconds'] = round(time.monotonic() - started, 3)
    target = Path(args.out) / (args.name + '.json')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'receipt': str(target), **{k:v for k,v in result.items() if k not in ['stdout','stderr']}}))
    print(result.get('stdout', '')[-18000:])
    print(result.get('stderr', '')[-3000:])
    return 0 if result.get('exit_code') == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
