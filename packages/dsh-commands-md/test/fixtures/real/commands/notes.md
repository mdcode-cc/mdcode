Manage freeform notes for the current project. Notes are short records of things worth
remembering — a decision, a gotcha, a reminder for next time.

Note files live in the project's `docs/notes/` directory (relative to the git root or working
directory).

## Usage

`/notes` or `/notes list`:
1. Find `docs/notes/` in the current project
2. List the 5 most recent note files by date
3. Read the most recent note and summarize it

`/notes add <text>`:
1. Append a dated entry to today's note file, creating it if missing
