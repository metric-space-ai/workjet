# Retired relay prototype

This directory contains provider-neutral protocol and security reference code
from the former relay prototype. It is not a deployable Workjet service and is
excluded from release builds.

Production signaling and device-session control run on Cloudflare. Business OS
records remain on the CTOX Sync Engine over RxDB/WebRTC and are never stored in
this control-plane directory.
