# Byte formatting

`formatBytes(value, {binary = false, precision = 1} = {})` formats finite numeric bytes. SI uses
base 1000 and `kB, MB, GB, TB`; IEC uses base 1024 and `KiB, MiB, GiB, TiB`. Promote exactly at a
unit boundary, round to the requested 0–3 decimal places, remove insignificant trailing zeros, and
render both `0` and `-0` as `0 B`. Negative finite values retain their sign. Reject invalid values
and precision.
