---
name: triage
description: Turn a raw bug report or feature idea into a tracked item, classify it, and stop for approval unless the fix is simple and obvious. Use whenever a new report arrives and no item exists yet.
argument-hint: "<report text | id>"
arguments: [report]
allowed-tools: Agent, SendMessage, Bash, Read, Write, Edit, Glob, Grep, Skill
---

# /triage

Classify `$ARGUMENTS` into a tracked item: PROBLEM / NOT A PROBLEM / JUDGMENT CALL, with a
reason for each. Simple and obvious fixes proceed without approval; everything else stops
for a decision.
