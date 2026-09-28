#!/usr/bin/env python3
"""Offline, dependency-free reference fit for the monitor pilot.

The TypeScript supervisor is the runtime authority. This script exists only
for an offline parity check and uses the same fixed feature order, L2=1,
standardization, optimizer settings, and threshold grid. It never opens a
workspace, executes a command, or contacts a model.
"""

from __future__ import annotations

import hashlib
import json
import math
import pathlib
import sys

FEATURES = [
    "identicalCallStreak",
    "sameToolErrorStreak",
    "readOnlyStreak",
    "uniqueCallFraction4",
    "errorFraction4",
    "turnsSinceSuccessfulVirtualWrite",
    "repeatedResultFraction4",
    "iterationBudgetFraction",
]


def sigmoid(value: float) -> float:
    if value >= 0:
        z = math.exp(-value)
        return 1.0 / (1.0 + z)
    z = math.exp(value)
    return z / (1.0 + z)


def fit(rows: list[dict]) -> dict:
    if not rows:
        raise ValueError("training data is empty")
    means = {name: sum(float(row["features"][name]) for row in rows) / len(rows) for name in FEATURES}
    scales = {}
    for name in FEATURES:
        variance = sum((float(row["features"][name]) - means[name]) ** 2 for row in rows) / len(rows)
        scales[name] = math.sqrt(variance) or 1.0
    coefficients = {name: 0.0 for name in FEATURES}
    intercept = 0.0
    for _ in range(2000):
        gradient = {name: 0.0 for name in FEATURES}
        intercept_gradient = 0.0
        for row in rows:
            vector = [(float(row["features"][name]) - means[name]) / scales[name] for name in FEATURES]
            logit = intercept + sum(coefficients[name] * vector[index] for index, name in enumerate(FEATURES))
            error = sigmoid(logit) - int(row["label"])
            intercept_gradient += error
            for index, name in enumerate(FEATURES):
                gradient[name] += error * vector[index]
        intercept -= 0.08 * intercept_gradient / max(1, len(rows))
        for name in FEATURES:
            coefficients[name] -= 0.08 * (gradient[name] / max(1, len(rows)) + coefficients[name] / max(1, len(rows)))
    artifact = {
        "schemaVersion": 1,
        "featureOrder": FEATURES,
        "coefficients": coefficients,
        "intercept": intercept,
        "standardization": {"mean": means, "scale": scales},
        "calibration": {"intercept": 0.0, "slope": 1.0},
        "threshold": 0.5,
        "l2": 1,
        "modelDigest": "offline-reference",
        "templatesHash": "supplied-by-caller",
    }
    canonical = json.dumps(artifact, sort_keys=True, separators=(",", ":"))
    artifact["artifactHash"] = hashlib.sha256(canonical.encode()).hexdigest()
    return artifact


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: train.py rows.jsonl predictor.json", file=sys.stderr)
        return 2
    source = pathlib.Path(sys.argv[1])
    target = pathlib.Path(sys.argv[2])
    rows = [json.loads(line) for line in source.read_text().splitlines() if line.strip()]
    target.write_text(json.dumps(fit(rows), indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
