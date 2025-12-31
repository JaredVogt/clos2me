# Clos Mult Router

A **complete global repacker** that simulates a 3-stage circuit Clos fabric and routes multicast ("mult") fanouts while preventing unintended route bridging.

Unlike a greedy/incremental placer, this version performs a **complete global repack** after every command:

- Maintains a desired end-state: `output port -> input_id`
- Re-solves the entire fabric from scratch using **backtracking**
- If a solution exists under the modeled constraints, it will find one
- Minimizes **total branching** (sum of spines used across all active inputs)

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
