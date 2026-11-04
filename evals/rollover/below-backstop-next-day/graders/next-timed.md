---
type: regex
pattern: '^CALL CronCreate (?=[^\n]*"cron"\s*:\s*"0?[345] 0 5 11 [^"]*")(?=[^\n]*"recurring"\s*:\s*false)(?=[^\n]*kind=timed backstop=none)(?=[^\n]*stop=85)'
flags: m
---
