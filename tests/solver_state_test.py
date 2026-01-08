#!/usr/bin/env python3
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / ".context" / "clos_mult_router_test"

STATE_KEYS = [
    "s1_to_s2",
    "s2_to_s3",
    "s3_port_owner",
    "s3_port_spine",
    "desired_owner",
]

CASES = [
    ("test_routes.txt", "5a44a6f9aef9a8aa44fa2a7df72e80525debc513f110a5a5147da2d6a4075250"),
    ("test_100.txt", "91820cb1130d2098673f1474b9909bd5f3e4b495df03036d7bca38af787297e5"),
]


def build_binary() -> None:
    (ROOT / ".context").mkdir(exist_ok=True)
    subprocess.run(
        ["cc", "-O2", "-std=c11", "clos_mult_router.c", "-o", str(BIN)],
        check=True,
        cwd=ROOT,
    )


def hash_state(json_path: Path) -> str:
    with json_path.open() as f:
        data = json.load(f)
    state = {key: data[key] for key in STATE_KEYS}
    blob = json.dumps(state, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


def run_case(routes_file: str, expected_hash: str) -> None:
    out_path = ROOT / ".context" / f"{Path(routes_file).stem}.json"
    subprocess.run(
        [str(BIN), str(ROOT / routes_file), "--json", str(out_path)],
        check=True,
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
    )
    actual = hash_state(out_path)
    if actual != expected_hash:
        raise AssertionError(
            f"State hash mismatch for {routes_file}: expected {expected_hash}, got {actual}"
        )


def main() -> int:
    build_binary()
    for routes_file, expected_hash in CASES:
        run_case(routes_file, expected_hash)
    return 0


if __name__ == "__main__":
    sys.exit(main())
