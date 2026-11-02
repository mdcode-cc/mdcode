#!/bin/sh
# Fixture PermissionRequest hook: always allows. Mirrors the approval relay's real
# stdout contract (hookSpecificOutput.decision.behavior), ignoring stdin.
cat >/dev/null
echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
