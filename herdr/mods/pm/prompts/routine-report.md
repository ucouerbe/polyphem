This is routine "{routine}", an unattended run. Nobody is watching the terminal: do the work, then write a report the user can read in two minutes.

Write the report to `.routines/{routine}/reports/<YYYY-MM-DD>.md` (use `date +%F`) with exactly this shape:

```
---
routine: {routine}
run: <YYYY-MM-DDTHH:MM, from `date +%FT%H:%M`>
status: to-review
---
# <Routine title>

<one or two sentences: what the reader needs to know>

## What I did
- <each change or finding, one line; name the files you touched>

## What I recommend
- <next steps, one line each>

## Questions for you
1. <a question only the user can answer, one line each; leave the section empty if none>
```

Keep it short and concrete. Questions must be answerable in a sentence. {reports}
