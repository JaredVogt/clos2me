#!/usr/bin/env python3
"""
Benchmark resolves/sec for clos_mult_router.

Terminology:
- resolve: one solver run triggered by a single command line in the routes file.
  Each command is either a route (e.g. "7.31.44.92") or a clear ("!7").
  The solver processes commands sequentially, so total resolves == number of commands.

- baseline: number of initial route commands that build up a dense fabric state.
  This is the starting condition before we introduce churn.

- churn: number of additional commands that add/remove small sets of outputs
  (incremental edits) after the baseline is established.

- outputs per command: how many output ports are assigned in each route command.

- incremental: when enabled, the solver attempts a fast local repair first and
  falls back to a full repack only if repair fails. When disabled, every command
  triggers a full global repack.

What this benchmark measures:
- wall_time_s: total elapsed time for the entire command stream
- resolves_per_sec: (repacks + repairs) / wall_time_s
  This is overall throughput, not a unit test. It varies by machine/CPU load.
- nodes_per_sec: (solve_nodes_total + repair_nodes_total) / wall_time_s
  This matches the unit reported by the 5-second PROGRESS log inside the solver.
  Note: if incremental repair succeeds without backtracking, node counts can be 0.
"""
import argparse
import json
import random
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / ".context" / "clos_mult_router_bench"


def build_binary() -> None:
    (ROOT / ".context").mkdir(exist_ok=True)
    subprocess.run(
        ["cc", "-O2", "-std=c11", "clos_mult_router.c", "-o", str(BIN)],
        check=True,
        cwd=ROOT,
    )


def generate_routes(n: int, baseline: int, churn: int, outputs_per_cmd: int, seed: int) -> list[str]:
    rng = random.Random(seed)
    total = baseline + churn
    inputs = list(range(1, n * n + 1))

    # Outputs are grouped by egress block (size N)
    block_outputs = [list(range(b * n + 1, b * n + n + 1)) for b in range(n)]
    free_outputs = [set(block) for block in block_outputs]
    inputs_in_block = [set() for _ in range(n)]
    outputs_by_input_block = [[set() for _ in range(n)] for _ in range(n * n + 1)]

    def route_candidate():
        candidates = []
        for in_id in inputs:
            for b in range(n):
                if len(free_outputs[b]) < outputs_per_cmd:
                    continue
                if in_id in inputs_in_block[b] or len(inputs_in_block[b]) < n:
                    candidates.append((in_id, b))
        if not candidates:
            return None
        return rng.choice(candidates)

    def clear_candidate():
        actives = [in_id for in_id in inputs if any(outputs_by_input_block[in_id][b] for b in range(n))]
        if not actives:
            return None
        return rng.choice(actives)

    commands: list[str] = []
    route_bias = 0.7

    for _ in range(total):
        do_route = rng.random() < route_bias
        if do_route:
            cand = route_candidate()
            if cand is None:
                do_route = False
        if not do_route:
            in_id = clear_candidate()
            if in_id is None:
                cand = route_candidate()
                if cand is None:
                    raise RuntimeError("Unable to generate more valid commands")
                in_id, block = cand
                outs = rng.sample(sorted(free_outputs[block]), outputs_per_cmd)
                commands.append(f"{in_id}." + ".".join(map(str, outs)))
                for p in outs:
                    free_outputs[block].remove(p)
                    outputs_by_input_block[in_id][block].add(p)
                if in_id not in inputs_in_block[block]:
                    inputs_in_block[block].add(in_id)
                continue

            commands.append(f"!{in_id}")
            for b in range(n):
                outs = outputs_by_input_block[in_id][b]
                if not outs:
                    continue
                for p in outs:
                    free_outputs[b].add(p)
                outs.clear()
                inputs_in_block[b].discard(in_id)
            continue

        in_id, block = cand
        outs = rng.sample(sorted(free_outputs[block]), outputs_per_cmd)
        commands.append(f"{in_id}." + ".".join(map(str, outs)))
        for p in outs:
            free_outputs[block].remove(p)
            outputs_by_input_block[in_id][block].add(p)
        if in_id not in inputs_in_block[block]:
            inputs_in_block[block].add(in_id)

    return commands


def run_bench(n: int, baseline: int, churn: int, outputs_per_cmd: int, seed: int, incremental: bool) -> None:
    build_binary()
    routes = generate_routes(n, baseline, churn, outputs_per_cmd, seed)

    routes_path = ROOT / ".context" / "bench_routes.txt"
    json_path = ROOT / ".context" / "bench_state.json"
    routes_path.write_text("\n".join(routes) + "\n")

    cmd = [str(BIN), str(routes_path), "--json", str(json_path), "--size", str(n)]
    if incremental:
        cmd.append("--incremental")

    start = time.perf_counter()
    subprocess.run(cmd, check=True, cwd=ROOT, stdout=subprocess.DEVNULL)
    elapsed = time.perf_counter() - start

    data = json.loads(json_path.read_text())
    repacks = int(data.get("repack_count", 0) or 0)
    repairs = int(data.get("repair_count", 0) or 0)
    solve_nodes_total = int(data.get("solve_nodes_total", 0) or 0)
    repair_nodes_total = int(data.get("repair_nodes_total", 0) or 0)
    resolves = repacks + repairs

    resolves_per_sec = resolves / elapsed if elapsed > 0 else 0.0
    nodes_per_sec = (solve_nodes_total + repair_nodes_total) / elapsed if elapsed > 0 else 0.0

    print("Benchmark results:")
    print(f"  N={n}, baseline={baseline}, churn={churn}, outputs/cmd={outputs_per_cmd}, incremental={incremental}")
    print(f"  total_commands={len(routes)}")
    print(f"  repacks={repacks}, repairs={repairs}, resolves={resolves}")
    print(f"  solve_nodes_total={solve_nodes_total}, repair_nodes_total={repair_nodes_total}")
    print(f"  wall_time_s={elapsed:.4f}")
    print(f"  resolves_per_sec={resolves_per_sec:.2f}")
    print(f"  nodes_per_sec={nodes_per_sec:.2f}")
    if solve_nodes_total + repair_nodes_total == 0:
        print("  note: no backtracking nodes recorded (repairs likely solved greedily)")


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark resolves/sec for clos_mult_router")
    parser.add_argument("--size", type=int, default=10, help="Clos size N for C(N,N,N)")
    parser.add_argument("--baseline", type=int, default=200, help="Number of initial route commands")
    parser.add_argument("--churn", type=int, default=20, help="Number of post-baseline edit commands")
    parser.add_argument("--outputs", type=int, default=3, dest="outputs_per_cmd",
                        help="Outputs per route command")
    parser.add_argument("--seed", type=int, default=1, help="Deterministic RNG seed for command stream")
    parser.add_argument("--no-incremental", action="store_true",
                        help="Disable incremental repair (force full repack per command)")
    args = parser.parse_args()

    incremental = not args.no_incremental
    run_bench(args.size, args.baseline, args.churn, args.outputs_per_cmd, args.seed, incremental)
    return 0


if __name__ == "__main__":
    sys.exit(main())
