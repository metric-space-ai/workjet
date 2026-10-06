"""Check staged Python syntax without writing bytecode or importing the scripts."""
import pathlib
import sys

for argument in sys.argv[1:]:
    source = pathlib.Path(argument)
    compile(source.read_text(encoding="utf8"), str(source), "exec")
