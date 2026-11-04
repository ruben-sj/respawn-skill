---
type: regex
pattern: '^CALL CronCreate (?=[^\n]*"cron"\s*:\s*"0?9 0 4 11 [^"]*")(?=[^\n]*"recurring"\s*:\s*false)(?=[^\n]*kind=followup)(?=[^\n]*windows=1)(?=[^\n]*backstop=none)'
flags: m
---
