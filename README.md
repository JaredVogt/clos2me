# Clos Mult Router

A **complete global repacker** that simulates a 3-stage circuit Clos fabric and routes multicast ("mult") fanouts while preventing unintended route bridging.

Unlike a greedy/incremental placer, this version performs a **complete global repack** after every command:

- Maintains a desired end-state: `output port -> input_id`
- Re-solves the entire fabric from scratch using **backtracking**
- If a solution exists under the modeled constraints, it will find one
- Reports **total branching** (sum of spines used across all active inputs) but optimizes for **stability**

## Topology

Symmetric 3-stage Clos, equivalent to **C(10,10,10)**:

| Stage | Description | Ports |
|-------|-------------|-------|
| **Stage 1 (Ingress)** | 10 ingress blocks, 10 ports each | 1–100 |
| **Stage 2 (Middle)** | 10 spines | — |
| **Stage 3 (Egress)** | 10 egress blocks, 10 ports each | 1–100 |

Ports are grouped into blocks of 10:

- Block 1: ports 1–10
- Block 2: ports 11–20
- ...
- Block 10: ports 91–100

## Problem Statement

### Mult Congestion

Mult requires that an input be present in the destination egress block(s) via the middle stage.

This model has **one trunk per (spine, egress block)**, so each egress block can accept at most **10 distinct inputs** at the same time (one per spine). When more than 10 distinct sources demand the same egress block, the problem is unsatisfiable.

### Route Isolation

Isolation ensures:

- A mult group cannot accidentally touch other routes
- Output ports cannot "bridge" between two different trunks

This is enforced by modeling Stage 3 as **one-of-m selection per output port**:

- Each output port selects exactly one spine trunk
- Multiple output ports may select the same trunk for mult
- A port cannot be connected to two trunks simultaneously

## How It Works

### In Plain English

You have 100 input ports and 100 output ports. You want to connect inputs to outputs—sometimes one input to a single output, sometimes one input to many outputs (that's multicast).

The catch: everything has to pass through a middle layer of 10 "spines." The solver's job is to figure out which spine each connection should use.

**Why it's tricky:**
- Each spine can only carry one input's signal to each output group (10 outputs share a group)
- If 11 different inputs all need to reach the same output group, the request is rejected immediately—no solving needed, it's a capacity violation
- Inputs from the same group also compete for spine access on their side

**What the solver does:**
1. Checks if the configuration is even possible (quick capacity check)
2. Finds a valid spine assignment for every connection
3. Tries to reuse existing assignments when adding new routes (stability)
4. Minimizes the total number of spine connections used (efficiency)

**What "REPACK OK: total branches = 84" means:**
- The solver found a valid configuration
- 84 = total spine connections across all active inputs
- Lower is better (means the fabric is being used efficiently)

### Desired State

The app stores `desired_owner[output_port] = input_id` (or 0 if disconnected).

Commands modify `desired_owner`.

### Complete Solver / Global Repack

After each command, the fabric is rebuilt by solving variables of the form:

```
(input_id, egress_block) -> spine
```

A variable exists if that input owns any outputs in that egress block.

**Constraints enforced:**

1. **Stage 2 trunk constraint:** each `(spine, egress_block)` trunk has at most one input owner
2. **Stage 1 trunk constraint:** each `(ingress_block, spine)` trunk has at most one input owner

**Stage 3 derivation:**

Each output port picks the spine assigned to its `(input, egress_block)`.

### Why This Is "Complete"

The solver backtracks over spine assignments and explores alternatives. Under this model, if any assignment exists, it will find one.

## Solver Strategy Tree

The solver applies three sequential stages:

### Stage 1: Demand Building

Analyzes `desired_owner[]` to extract `(input_id, egress_block)` pairs that need spine assignments. If no routes are configured, there's nothing to solve—the solver exits with an empty (but valid) fabric state.

### Stage 2: Fast Capacity Pre-check

Before expensive backtracking, performs quick feasibility tests:

- **Egress capacity**: No more than 10 distinct inputs can target the same egress block
- **Ingress capacity**: No more than 10 active inputs can originate from the same ingress block

If either check fails, the solver prints `UNSAT DETAILS` and exits—no solution exists.

### Stage 3: Complete Backtracking Search

The core solver uses two key optimizations:

**MRV Variable Selection (Minimum Remaining Values):**
- At each recursion level, selects the demand with the fewest valid spine choices
- Prioritizes harder-to-satisfy constraints first
- Detects failures early when a demand has zero valid options

**3-Pass Value Ordering:**
For each demand, spines are tried in priority order:

| Pass | Strategy | Purpose |
|------|----------|---------|
| 0 | Try **previous spine** first | Preserves existing routes (stability) |
| 1 | Try **already-used spines** by this input | Reduces total branches |
| 2 | Try **remaining spines** | Exhaustive fallback |

### Cost Function

The solver optimizes for **stability only** (see [WOL-598](https://linear.app/wolffaudio/issue/WOL-598/consider-restoring-branch-cost-optimization-in-solver)):

- **stability_cost** = number of spine assignments that differ from previous state

Branch cost was removed from the optimization to improve solver performance. The solver still reports total branches for informational purposes, but the search prioritizes minimizing route changes.

**Key behavior:**
- If stability_cost = 0 is achievable, the solver finds it (perfect stability)
- Otherwise, it finds the minimum stability_cost that yields a valid solution
- Correctness always wins over stability

### Transition Triggers

| From | To | Trigger |
|------|-----|---------|
| Demand Building | Success | 0 demands (empty config) |
| Demand Building | Capacity Check | 1+ demands |
| Capacity Check | **FAIL** | Capacity exceeded |
| Capacity Check | Backtracking | Capacity OK |
| Backtracking | Prune branch | Stability cost ≥ best known |
| Backtracking | **Stop early** | Perfect stability achieved (0 route changes) |

### Key Insight

The solver is **mathematically complete**: if any valid assignment exists, it will find one. The stability preference minimizes route changes when multiple solutions exist, but never prevents finding a solution that requires changes.

## Input File Format

### Route Command

```
<input>.<out>.<out>...
```

**Example:**
```
7.31.44.92
```

### Clear Command

```
!<input>
```

**Example:**
```
!7
```

### Multiple Requests Per Line

Comma-separated:

```
1.21.22, 2.31.41, !1
```

### Comments

Anything after `#` is ignored:

```
7.31.44.92  # mult input 7
```

## Output

At the end it prints:

1. A heatmap of **spine -> egress block trunk ownership**
2. A summary of **output port selections** (Out -> Input via Spine)

## Build & Run

```bash
gcc -O2 -Wall -Wextra -std=c11 clos_mult_router.c -o clos_mult_router
./clos_mult_router routes.txt
```

## License

[Add your license here]
