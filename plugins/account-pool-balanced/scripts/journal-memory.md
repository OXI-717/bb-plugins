Run from the plugin directory after installing dependencies:

```sh
node --expose-gc --trace-gc --heapsnapshot-near-heap-limit=1 --import tsx scripts/journal-memory.ts --check
```

The benchmark creates synthetic state only, in a temporary directory. It records
6,000 distinct hourly buckets, fills the bounded recent journal, then submits
60,000 events in 120 batches with identical explicit flush cadence. It reports
heap retained after forced GC, sampled peak heap, GC count/total/maximum duration,
and allocation sampling including collected objects. The inspector session is
attached only to this benchmark process. Never attach it to a running server.
The near-limit flag produces no snapshot unless the heap approaches its limit.

`--check` imposes a generous 1 GiB sampled allocation budget for this workload.
It catches reintroduction of per-event full-array filtering and counter-object
construction. Absolute GC times depend on runtime and machine load. The benchmark
measures journal state and allocation pressure; it does not attribute the whole
server heap or simulate model response buffers, admission, Guard or the BB core.
JSON storage format, retention and periodic flush intervals remain unchanged.
