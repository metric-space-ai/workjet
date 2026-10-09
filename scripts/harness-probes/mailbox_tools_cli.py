#!/usr/bin/env python3
import json
import sys
from mailbox_tools import call
print(json.dumps(call(sys.argv[1],json.loads(sys.argv[2]))))
