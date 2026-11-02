#!/bin/sh
# Fixture PermissionRequest hook: always denies, with a message. Mirrors
# the approval relay's real stdout contract, ignoring stdin.
cat >/dev/null
echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied by fixture"}}}'
