#!/usr/bin/env python3
"""Inventory only; no installation, login, update, or model invocation."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
commands = {
 'claude': ['claude'],
 'codex': ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'],
 'grok': ['grok'], 'opencode': ['opencode'], 'greppy': ['greppy'], 'pi': ['pi'], 'minimax': ['mcode'],
}
for name, command in commands.items():
 for label, flag in [('help','--help'),('version','--version')]:
  invocation = [sys.executable,str(root/'scripts/harness-probes/capture.py'),
                '--name', name+'-'+label, '--out', args.out, '--cwd', str(root), '--', *command, flag]
  subprocess.run(invocation, check=False)
