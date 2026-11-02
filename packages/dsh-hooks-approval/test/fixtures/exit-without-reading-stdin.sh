#!/bin/sh
# Fixture PermissionRequest hook: exits immediately WITHOUT reading stdin.
# Reproduces EPIPE on the parent's child.stdin write when the payload
# exceeds the OS pipe buffer (see test/subprocess.test.js's >64KB test).
exit 0
