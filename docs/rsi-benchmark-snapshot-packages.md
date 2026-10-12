# RSI benchmark snapshot packages

The package-aware RSI benchmark runner can load commit-backed source snapshots from a local, content-addressed package. This supports fresh clones that do not contain every historical Git commit referenced by a benchmark manifest.

Build a package only from a repository that already has all referenced commit objects. The builder is offline and does not fetch missing objects:

```sh
npx tsx scripts/rsi/build-benchmark-snapshot-package.ts \
  --repo /path/to/repository-with-snapshot-commits \
  --manifest /path/to/fixtures/rsi-benchmark/manifest.json \
  --output /path/to/private-output/snapshots
```

The command writes an index and deduplicated source blobs at the output path, then prints a descriptor containing the format version, package-relative path, and SHA-256 digest of the canonical index. Set the benchmark manifest's `runnerVersion` to `1.1.0` and copy that descriptor into its `snapshotPackage` field. Keep the manifest task digests and verifier files unchanged. The runner rejects a missing or modified package and does not fall back to Git when `snapshotPackage` is present. Runner version `1.0.0` continues to use local Git objects and cannot declare a package.

The package preserves each referenced source tree's paths, executable bits, and bytes. It also preserves the source tree's license and attribution files without rewriting them. The package is not a replacement for the benchmark manifest or verifier files. Store and distribute it with the same access controls as the source snapshots it contains.

## Using fixtures outside the source checkout

When the manifest, verifier files, and snapshot package are stored together outside the source checkout, select their directory during an estimate or plan preview:

```sh
npx tsx scripts/rsi-proof-demonstration.ts estimate \
  --seed engineering-seed \
  --campaign-seed campaign-a \
  --campaign-seed campaign-b \
  --campaign-seed campaign-c \
  --benchmark-fixtures-root /path/to/operator-fixtures
```

The directory must contain `manifest.json`, its referenced verifier files, and the pinned snapshot package. The same `--benchmark-fixtures-root` option is available for `engineering` and `plan`. The preview records the canonical directory, manifest digest, and snapshot-package index digest in the frozen plan. Frozen `execute` uses that recorded binding and does not accept a replacement fixture root. If the option is omitted, preview uses the checkout's `fixtures/rsi-benchmark` directory.
