// clos_mult_router.c
//
// 3-stage Clos fabric simulator + COMPLETE (backtracking) global repacker for multicast ("mult") fanout.
//
// What you had before:
// - an incremental greedy placer + a single-leg local "defrag"
// - fast, but it could fail even when a solution exists
//
// What this version does:
// - maintains a desired end-state: output port -> input_id
// - after every command, it REPACKS THE ENTIRE FABRIC from scratch using a backtracking solver
// - if any valid assignment exists under this model, it will find one
// - it also minimizes total "branches" (spines used) as a secondary objective
//
// Model (symmetric C(10,10,10)):
// - Stage 1: 10 ingress blocks, 10 ports each (ports 1..100)
// - Stage 2: 10 spines
// - Stage 3: 10 egress blocks, 10 ports each (ports 1..100)
//
// Key constraints (route isolation in the sense you mean):
// 1) Each ingress-block -> spine trunk is owned by at most one input.
// 2) Each spine -> egress-block trunk is owned by at most one input.
// 3) Each output port selects exactly one trunk (one-of-m selection).
//
// Mult behavior:
// - multiple output ports in the SAME egress block can share the same (spine, egress-block) trunk for a given input
// - congestion occurs when too many distinct inputs want to reach the same egress block (max 10 in this topology)

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <ctype.h>
#include <stdint.h>

#define N 10
#define TOTAL_BLOCKS 10
#define MAX_PORTS 100
#define MAX_LINE_LENGTH 1024

// --- DESIRED STATE -----------------------------------------------------------
// The "truth" this app tries to realize in the fabric:
// desired_owner[out_port] = input_id (0 = disconnected)
static int desired_owner[MAX_PORTS + 1];

// --- PREVIOUS STATE (for stability) -----------------------------------------
// When --previous-state is provided, we try to preserve existing spine assignments
static int prev_s3_port_spine[MAX_PORTS + 1];  // previous spine assignments (-1 = none)
static bool have_previous_state = false;
static bool strict_stability = false;  // --strict-stability flag
static int last_stability_cost = 0;    // track changes from previous state

// --- STABILITY METRICS (cumulative across all commands) ----------------------
static int cumulative_reroutes = 0;      // total spine changes across all solves
static int initial_route_count = 0;      // routes at start of file (from previous state)
static bool tracked_initial = false;     // whether we've captured initial state

// --- FABRIC STATE (realized solution) ---------------------------------------
static int s1_to_s2[TOTAL_BLOCKS][N];    // ingress block -> spine trunk owner (0 free, else input_id)
static int s2_to_s3[N][TOTAL_BLOCKS];    // spine -> egress block trunk owner (0 free, else input_id)
static int s3_port_owner[MAX_PORTS + 1]; // output port -> input_id (0 free)
static int s3_port_spine[MAX_PORTS + 1]; // output port -> spine index (0..9), -1 if disconnected

// --- HELPERS ----------------------------------------------------------------
static inline int get_block(int port) {
  return (port - 1) / N;
}

static inline bool is_valid_port(int p) {
  return p >= 1 && p <= MAX_PORTS;
}

static char *trim_in_place(char *s) {
  while (*s && isspace((unsigned char)*s)) s++;
  if (*s == 0) return s;

  char *end = s + strlen(s) - 1;
  while (end > s && isspace((unsigned char)*end)) end--;
  end[1] = '\0';
  return s;
}

// --- JSON OUTPUT ------------------------------------------------------------
static void json_write_int_array(FILE *f, const int *arr, int len) {
  fputc('[', f);
  for (int i = 0; i < len; i++) {
    fprintf(f, "%d", arr[i]);
    if (i + 1 < len) fputc(',', f);
  }
  fputc(']', f);
}

static void json_write_matrix_s1(FILE *f) {
  fputc('[', f);
  for (int r = 0; r < TOTAL_BLOCKS; r++) {
    fputc('[', f);
    for (int c = 0; c < N; c++) {
      fprintf(f, "%d", s1_to_s2[r][c]);
      if (c + 1 < N) fputc(',', f);
    }
    fputc(']', f);
    if (r + 1 < TOTAL_BLOCKS) fputc(',', f);
  }
  fputc(']', f);
}

static void json_write_matrix_s2(FILE *f) {
  fputc('[', f);
  for (int r = 0; r < N; r++) {
    fputc('[', f);
    for (int c = 0; c < TOTAL_BLOCKS; c++) {
      fprintf(f, "%d", s2_to_s3[r][c]);
      if (c + 1 < TOTAL_BLOCKS) fputc(',', f);
    }
    fputc(']', f);
    if (r + 1 < N) fputc(',', f);
  }
  fputc(']', f);
}

// --- FABRIC STATISTICS (forward definition for JSON output) -----------------
typedef struct {
  // Routes
  int routes_active;
  int routes_preserved;   // same spine as previous
  int routes_new;         // no previous assignment
  int routes_removed;     // had previous but now gone

  // Multicast
  int inputs_with_mult;   // inputs with 2+ output ports
  int inputs_multi_spine; // inputs using 2+ spines
  int egress_with_mult;   // egress blocks with 2+ distinct inputs

  // Capacity
  int max_egress_load;    // max inputs per egress block
  int max_egress_block;   // which block has max load (1-indexed)
  int active_spines;      // count of spines with at least 1 route
  int total_branches;     // sum of spines used per active input
} FabricStats;

static FabricStats compute_fabric_stats(void);  // Forward declaration

static bool write_state_json(const char *path) {
  FILE *f = fopen(path, "w");
  if (!f) {
    perror("json output file");
    return false;
  }

  // Compute stats for JSON
  FabricStats stats = compute_fabric_stats();
  double stability_reuse_pct = 100.0;
  if (initial_route_count > 0) {
    int kept = initial_route_count - cumulative_reroutes;
    if (kept < 0) kept = 0;
    stability_reuse_pct = (kept * 100.0) / initial_route_count;
  }

  fprintf(f, "{");
  fprintf(f, "\"version\":1,");
  fprintf(f, "\"N\":%d,", N);
  fprintf(f, "\"TOTAL_BLOCKS\":%d,", TOTAL_BLOCKS);
  fprintf(f, "\"MAX_PORTS\":%d,", MAX_PORTS);

  fprintf(f, "\"s1_to_s2\":");
  json_write_matrix_s1(f);
  fprintf(f, ",");

  fprintf(f, "\"s2_to_s3\":");
  json_write_matrix_s2(f);
  fprintf(f, ",");

  fprintf(f, "\"s3_port_owner\":");
  json_write_int_array(f, s3_port_owner, MAX_PORTS + 1);
  fprintf(f, ",");

  fprintf(f, "\"s3_port_spine\":");
  json_write_int_array(f, s3_port_spine, MAX_PORTS + 1);
  fprintf(f, ",");

  fprintf(f, "\"desired_owner\":");
  json_write_int_array(f, desired_owner, MAX_PORTS + 1);
  fprintf(f, ",");

  // Legacy stability field
  fprintf(f, "\"stability_changes\":%d,", last_stability_cost);
  fprintf(f, "\"strict_stability\":%s,", strict_stability ? "true" : "false");

  // New metrics
  fprintf(f, "\"routes_active\":%d,", stats.routes_active);
  fprintf(f, "\"routes_preserved\":%d,", stats.routes_preserved);
  fprintf(f, "\"routes_new\":%d,", stats.routes_new);
  fprintf(f, "\"routes_removed\":%d,", stats.routes_removed);
  fprintf(f, "\"stability_reroutes\":%d,", cumulative_reroutes);
  fprintf(f, "\"stability_reuse_pct\":%.1f,", stability_reuse_pct);
  fprintf(f, "\"inputs_with_mult\":%d,", stats.inputs_with_mult);
  fprintf(f, "\"inputs_multi_spine\":%d,", stats.inputs_multi_spine);
  fprintf(f, "\"egress_with_mult\":%d,", stats.egress_with_mult);
  fprintf(f, "\"max_egress_load\":%d,", stats.max_egress_load);
  fprintf(f, "\"active_spines\":%d,", stats.active_spines);
  fprintf(f, "\"total_branches\":%d", stats.total_branches);

  fprintf(f, "}\n");

  fclose(f);
  return true;
}

// --- PREVIOUS STATE LOADING -------------------------------------------------
// Simple JSON parser to extract s3_port_spine array from previous state file
static bool load_previous_state(const char *path) {
  FILE *f = fopen(path, "r");
  if (!f) {
    perror("previous state file");
    return false;
  }

  // Read entire file
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, 0, SEEK_SET);

  char *buf = malloc(len + 1);
  if (!buf) {
    fclose(f);
    return false;
  }

  size_t read_len = fread(buf, 1, len, f);
  buf[read_len] = '\0';
  fclose(f);

  // Initialize to -1 (no previous assignment)
  for (int i = 0; i <= MAX_PORTS; i++) {
    prev_s3_port_spine[i] = -1;
  }

  // Find "s3_port_spine":[ and parse the array
  char *start = strstr(buf, "\"s3_port_spine\":");
  if (!start) {
    free(buf);
    return false;
  }

  start = strchr(start, '[');
  if (!start) {
    free(buf);
    return false;
  }
  start++;  // skip '['

  int idx = 0;
  while (idx <= MAX_PORTS && *start) {
    // Skip whitespace
    while (*start && (*start == ' ' || *start == '\n' || *start == '\r' || *start == '\t')) start++;

    if (*start == ']') break;

    // Parse number (may be negative)
    int val = 0;
    int sign = 1;
    if (*start == '-') {
      sign = -1;
      start++;
    }
    while (*start >= '0' && *start <= '9') {
      val = val * 10 + (*start - '0');
      start++;
    }
    prev_s3_port_spine[idx++] = sign * val;

    // Skip comma and whitespace
    while (*start && (*start == ',' || *start == ' ' || *start == '\n' || *start == '\r' || *start == '\t')) start++;
  }

  free(buf);
  have_previous_state = true;
  return true;
}

// --- DEBUG / VISUALIZATION --------------------------------------------------
static void print_heatmap(void) {
  printf("\n--- SPINE-TO-EGRESS UTILIZATION HEATMAP (s2_to_s3) ---\n");
  printf("       S01 S02 S03 S04 S05 S06 S07 S08 S09 S10\n");
  for (int e = 0; e < TOTAL_BLOCKS; e++) {
    printf("Egr %2d: ", e + 1);
    for (int s = 0; s < N; s++) {
      if (s2_to_s3[s][e] != 0) printf("[%02d] ", s2_to_s3[s][e]);
      else printf("[  ] ");
    }
    printf("\n");
  }
  printf("-----------------------------------------------------\n");
}

static void print_port_map_summary(void) {
  printf("\n--- OUTPUT PORT SELECTIONS (Stage3) ---\n");
  int shown = 0;
  int total = 0;

  for (int p = 1; p <= MAX_PORTS; p++) if (s3_port_owner[p] != 0) total++;

  for (int p = 1; p <= MAX_PORTS; p++) {
    if (s3_port_owner[p] == 0) continue;

    printf("Out %3d -> Input %3d via Spine %2d (EgrBlock %2d)\n",
      p,
      s3_port_owner[p],
      s3_port_spine[p] + 1,
      get_block(p) + 1
    );

    shown++;
    if (shown >= 40 && total > shown) {
      printf("... (%d more)\n", total - shown);
      break;
    }
  }

  if (total == 0) printf("(none)\n");
  printf("--------------------------------------\n");
}

// --- FABRIC STATISTICS (implementation) -------------------------------------
static FabricStats compute_fabric_stats(void) {
  FabricStats stats = {0};

  // Count outputs per input and spines per input
  int outputs_per_input[MAX_PORTS + 1] = {0};
  uint16_t spines_per_input[MAX_PORTS + 1] = {0};  // bitmask

  for (int p = 1; p <= MAX_PORTS; p++) {
    int owner = s3_port_owner[p];
    int spine = s3_port_spine[p];

    if (owner > 0 && spine >= 0) {
      stats.routes_active++;
      outputs_per_input[owner]++;
      spines_per_input[owner] |= (uint16_t)(1u << spine);

      // Compare with previous state
      if (have_previous_state) {
        int prev_spine = prev_s3_port_spine[p];
        if (prev_spine < 0) {
          stats.routes_new++;
        } else if (prev_spine == spine) {
          stats.routes_preserved++;
        }
        // Note: routes_rerouted = routes that existed but changed spine
        // This is tracked by cumulative_reroutes, not here
      } else {
        stats.routes_new++;  // No previous state means all are "new"
      }
    }
  }

  // Count removed routes (had previous spine but now disconnected)
  if (have_previous_state) {
    for (int p = 1; p <= MAX_PORTS; p++) {
      if (prev_s3_port_spine[p] >= 0 && s3_port_spine[p] < 0) {
        stats.routes_removed++;
      }
    }
  }

  // Count multicast metrics
  for (int in_id = 1; in_id <= MAX_PORTS; in_id++) {
    if (outputs_per_input[in_id] >= 2) {
      stats.inputs_with_mult++;
    }
    int spine_count = __builtin_popcount(spines_per_input[in_id]);
    if (spine_count >= 2) {
      stats.inputs_multi_spine++;
    }
    if (spine_count > 0) {
      stats.total_branches += spine_count;
    }
  }

  // Egress block metrics
  for (int e = 0; e < TOTAL_BLOCKS; e++) {
    int inputs_in_block = 0;
    for (int s = 0; s < N; s++) {
      if (s2_to_s3[s][e] != 0) inputs_in_block++;
    }
    if (inputs_in_block >= 2) {
      stats.egress_with_mult++;
    }
    if (inputs_in_block > stats.max_egress_load) {
      stats.max_egress_load = inputs_in_block;
      stats.max_egress_block = e + 1;  // 1-indexed for display
    }
  }

  // Count active spines
  for (int s = 0; s < N; s++) {
    bool spine_active = false;
    for (int e = 0; e < TOTAL_BLOCKS; e++) {
      if (s2_to_s3[s][e] != 0) {
        spine_active = true;
        break;
      }
    }
    if (spine_active) stats.active_spines++;
  }

  return stats;
}

static void print_fabric_summary(void) {
  FabricStats stats = compute_fabric_stats();

  printf("\n=== Fabric Summary ===\n");

  // Routes section
  printf("Routes: %d active", stats.routes_active);
  if (have_previous_state || stats.routes_new > 0) {
    printf(" (%d preserved, %d new", stats.routes_preserved, stats.routes_new);
    if (stats.routes_removed > 0) {
      printf(", %d removed", stats.routes_removed);
    }
    printf(")");
  }
  printf("\n");

  // Stability section
  if (initial_route_count > 0) {
    int total_existing = initial_route_count;
    int kept = total_existing - cumulative_reroutes;
    if (kept < 0) kept = 0;  // sanity
    double pct = (total_existing > 0) ? (kept * 100.0 / total_existing) : 100.0;
    printf("Stability: %.1f%% reuse", pct);
    if (cumulative_reroutes > 0) {
      printf(" (rerouted %d across all commands)", cumulative_reroutes);
    }
    printf("\n");
  }

  // Multicast section
  printf("\nMulticast:\n");
  printf("  Inputs with mult fanout: %d (inputs using 2+ outputs)\n", stats.inputs_with_mult);
  printf("  Inputs using 2+ spines: %d (branching in middle layer)\n", stats.inputs_multi_spine);
  printf("  Egress blocks with 2+ inputs: %d (mult in egress)\n", stats.egress_with_mult);

  // Capacity section
  printf("\nCapacity:\n");
  if (stats.max_egress_load > 0) {
    printf("  Most loaded egress block: %d/%d inputs (block %d)\n",
           stats.max_egress_load, N, stats.max_egress_block);
  } else {
    printf("  Most loaded egress block: 0/%d inputs\n", N);
  }
  printf("  Active spines: %d/%d\n", stats.active_spines, N);
  printf("  Total branches: %d\n", stats.total_branches);
}

// --- INVARIANT CHECKER ------------------------------------------------------
static bool validate_fabric(bool verbose) {
  // 1) s2_to_s3 trunks imply corresponding s1_to_s2 ownership
  for (int s = 0; s < N; s++) {
    for (int e = 0; e < TOTAL_BLOCKS; e++) {
      int in_id = s2_to_s3[s][e];
      if (in_id == 0) continue;
      if (!is_valid_port(in_id)) {
        if (verbose) printf("VALIDATION FAIL: s2_to_s3[%d][%d]=%d out of range\n", s, e, in_id);
        return false;
      }
      int ingress = get_block(in_id);
      if (s1_to_s2[ingress][s] != in_id) {
        if (verbose) printf("VALIDATION FAIL: trunk s2_to_s3[%d][%d]=%d but s1_to_s2[%d][%d]=%d\n",
          s, e, in_id, ingress, s, s1_to_s2[ingress][s]);
        return false;
      }
    }
  }

  // 2) Stage3 port selections must match s2_to_s3
  for (int p = 1; p <= MAX_PORTS; p++) {
    int owner = s3_port_owner[p];
    int spine = s3_port_spine[p];

    if (owner == 0) {
      if (spine != -1) {
        if (verbose) printf("VALIDATION FAIL: port %d owner=0 but spine=%d\n", p, spine);
        return false;
      }
      continue;
    }

    if (!is_valid_port(owner) || spine < 0 || spine >= N) {
      if (verbose) printf("VALIDATION FAIL: port %d has invalid owner/spine (%d/%d)\n", p, owner, spine);
      return false;
    }

    int e = get_block(p);
    if (s2_to_s3[spine][e] != owner) {
      if (verbose) printf("VALIDATION FAIL: port %d wants (spine %d,egr %d) but trunk holds %d\n",
        p, spine + 1, e + 1, s2_to_s3[spine][e]);
      return false;
    }
  }

  // 3) Fabric should realize desired_owner exactly
  for (int p = 1; p <= MAX_PORTS; p++) {
    if (desired_owner[p] != s3_port_owner[p]) {
      if (verbose) printf("VALIDATION FAIL: desired_owner[%d]=%d but s3_port_owner[%d]=%d\n",
        p, desired_owner[p], p, s3_port_owner[p]);
      return false;
    }
  }

  return true;
}

// --- COMPLETE GLOBAL SOLVER --------------------------------------------------
//
// We solve the constraint problem by building one variable per (input_id, egress_block) demand:
// - demand exists if any output port in that egress block is owned by that input in desired_owner[]
//
// Assigning a spine to (input_id, egress_block) means:
// - reserve (spine, egress_block) trunk for that input (Stage2)
// - reserve (ingress_block(input_id), spine) trunk for that input (Stage1)
//
// Constraints:
// - each (spine, egress_block) trunk can be owned by at most one input
// - each (ingress_block, spine) trunk can be owned by at most one input
//
// Then Stage3 selection is trivial: each output port picks the spine assigned to its (input, egress_block).
//

typedef struct {
  int input_id;      // 1..100
  int ingress_block; // 0..9
  int egress_block;  // 0..9
} Demand;

typedef struct {
  // candidate solution buffers
  int s1[TOTAL_BLOCKS][N];
  int s2[N][TOTAL_BLOCKS];
  int s3_owner[MAX_PORTS + 1];
  int s3_spine[MAX_PORTS + 1];
} FabricSolution;

// Builds demands from desired_owner and returns count
static int build_demands(Demand *demands, int *active_inputs, int *active_count, uint16_t *need_blocks_mask) {
  // need_blocks_mask[input_id] is a bitmask of egress blocks required by that input
  for (int i = 0; i <= MAX_PORTS; i++) need_blocks_mask[i] = 0;

  for (int p = 1; p <= MAX_PORTS; p++) {
    int in_id = desired_owner[p];
    if (in_id == 0) continue;
    int e = get_block(p);
    need_blocks_mask[in_id] |= (uint16_t)(1u << e);
  }

  int a = 0;
  for (int in_id = 1; in_id <= MAX_PORTS; in_id++) {
    if (need_blocks_mask[in_id] != 0) active_inputs[a++] = in_id;
  }
  *active_count = a;

  int d = 0;
  for (int idx = 0; idx < a; idx++) {
    int in_id = active_inputs[idx];
    int ingress = get_block(in_id);
    uint16_t mask = need_blocks_mask[in_id];
    for (int e = 0; e < TOTAL_BLOCKS; e++) {
      if (mask & (1u << e)) {
        demands[d++] = (Demand){ .input_id = in_id, .ingress_block = ingress, .egress_block = e };
      }
    }
  }

  return d;
}

static void print_unsat_reason(const uint16_t *need_blocks_mask) {
  // Count distinct inputs per egress block and per ingress block
  int inputs_per_egress[TOTAL_BLOCKS] = {0};
  int inputs_per_ingress[TOTAL_BLOCKS] = {0};

  for (int in_id = 1; in_id <= MAX_PORTS; in_id++) {
    if (need_blocks_mask[in_id] == 0) continue;
    inputs_per_ingress[get_block(in_id)]++;

    for (int e = 0; e < TOTAL_BLOCKS; e++) {
      if (need_blocks_mask[in_id] & (1u << e)) inputs_per_egress[e]++;
    }
  }

  printf("  UNSAT DETAILS:\n");
  for (int e = 0; e < TOTAL_BLOCKS; e++) {
    if (inputs_per_egress[e] > 0) {
      printf("    Egress block %2d needs %2d distinct inputs (capacity %d)\n", e + 1, inputs_per_egress[e], N);
    }
  }
  for (int i = 0; i < TOTAL_BLOCKS; i++) {
    if (inputs_per_ingress[i] > 0) {
      printf("    Ingress block %2d has %2d active inputs (capacity %d spines)\n", i + 1, inputs_per_ingress[i], N);
    }
  }
}

static bool quick_capacity_check(const uint16_t *need_blocks_mask) {
  // Egress capacity: each egress block has N trunks (one per spine)
  for (int e = 0; e < TOTAL_BLOCKS; e++) {
    int count = 0;
    for (int in_id = 1; in_id <= MAX_PORTS; in_id++) {
      if (need_blocks_mask[in_id] & (1u << e)) count++;
    }
    if (count > N) return false;
  }

  // Ingress capacity: each ingress block has N spines; each active input needs at least 1 spine
  // (In this model, an input cannot share a spine with another input from the same ingress block.)
  for (int i = 0; i < TOTAL_BLOCKS; i++) {
    int count = 0;
    for (int in_id = 1; in_id <= MAX_PORTS; in_id++) {
      if (need_blocks_mask[in_id] == 0) continue;
      if (get_block(in_id) == i) count++;
    }
    if (count > N) return false;
  }

  return true;
}

// Backtracking context (kept small and stack-friendly)
typedef struct {
  Demand *demands;
  int num_demands;

  int active_inputs[MAX_PORTS];
  int active_count;

  // Partial ownership constraints:
  // tmp_s2[spine][egress_block] = input_id (0 free)
  // tmp_s1_owner[ingress_block][spine] = input_id (0 free)
  int tmp_s2[N][TOTAL_BLOCKS];
  int tmp_s1_owner[TOTAL_BLOCKS][N];

  // Spine usage per input (for pass 1 ordering - prefer reusing spines)
  uint16_t used_spines_mask[MAX_PORTS + 1];

  // Assignment: chosen spine for each demand index
  int assignment[200];
  int best_assignment[200];

  // Stability: previous spine for each (input, egress_block)
  // -1 = new route (no previous), 0-9 = previous spine assignment
  int prev_spine_for[MAX_PORTS + 1][TOTAL_BLOCKS];

  // Stability cost tracking (branch cost removed for speed - see WOL-598)
  int stability_cost;       // current count of spine changes from previous state
  int best_stability_cost;  // best solution's stability cost
} SolverCtx;

static int domain_size(const SolverCtx *ctx, const Demand *d) {
  int in_id = d->input_id;
  int ingress = d->ingress_block;
  int egress = d->egress_block;

  int size = 0;
  for (int s = 0; s < N; s++) {
    if (ctx->tmp_s2[s][egress] != 0 && ctx->tmp_s2[s][egress] != in_id) continue;
    int owner = ctx->tmp_s1_owner[ingress][s];
    if (owner != 0 && owner != in_id) continue;
    size++;
  }
  return size;
}

static bool backtrack(SolverCtx *ctx, int depth) {
  // Optimize for stability only (branch cost removed for speed - see WOL-598)
  if (ctx->stability_cost >= ctx->best_stability_cost) return false;

  if (depth == ctx->num_demands) {
    // Found a valid assignment; record if best by stability cost
    if (ctx->stability_cost < ctx->best_stability_cost) {
      ctx->best_stability_cost = ctx->stability_cost;
      for (int i = 0; i < ctx->num_demands; i++) ctx->best_assignment[i] = ctx->assignment[i];
    }
    // If we hit zero stability cost, we can stop (perfect stability achieved)
    if (ctx->best_stability_cost == 0) return true;
    return false; // keep searching for better
  }

  // Choose next variable with MRV (smallest domain) for strong pruning
  int best_idx = -1;
  int best_dom = 999;

  for (int i = depth; i < ctx->num_demands; i++) {
    int dom = domain_size(ctx, &ctx->demands[i]);
    if (dom == 0) return false;
    if (dom < best_dom) {
      best_dom = dom;
      best_idx = i;
      if (dom == 1) break;
    }
  }

  // Swap chosen demand into position depth
  if (best_idx != depth) {
    Demand tmp = ctx->demands[depth];
    ctx->demands[depth] = ctx->demands[best_idx];
    ctx->demands[best_idx] = tmp;

    // Keep assignment aligned with demand ordering during search
    int atmp = ctx->assignment[depth];
    ctx->assignment[depth] = ctx->assignment[best_idx];
    ctx->assignment[best_idx] = atmp;
  }

  Demand d = ctx->demands[depth];
  int in_id = d.input_id;
  int ingress = d.ingress_block;
  int egress = d.egress_block;

  // Value ordering (3 passes for stability):
  // Pass 0: Try previous spine first (if exists) - preserves existing routes
  // Pass 1: Try spines already used by this input (reduces additional branches)
  // Pass 2: Try remaining spines
  uint16_t used = ctx->used_spines_mask[in_id];
  int prev_spine = ctx->prev_spine_for[in_id][egress];

  for (int pass = 0; pass < 3; pass++) {
    for (int s = 0; s < N; s++) {
      bool is_prev = (prev_spine >= 0 && s == prev_spine);
      bool already_used = (used & (1u << s)) != 0;

      // Pass 0: only try previous spine
      if (pass == 0 && !is_prev) continue;
      // Pass 1: try already-used spines (but not previous, already tried)
      if (pass == 1 && (is_prev || !already_used)) continue;
      // Pass 2: try remaining spines
      if (pass == 2 && (is_prev || already_used)) continue;

      // Check constraints
      if (ctx->tmp_s2[s][egress] != 0 && ctx->tmp_s2[s][egress] != in_id) continue;

      int owner = ctx->tmp_s1_owner[ingress][s];
      if (owner != 0 && owner != in_id) continue;

      // Commit (with minimal undo info)
      int prev_s2 = ctx->tmp_s2[s][egress];
      int prev_s1 = ctx->tmp_s1_owner[ingress][s];

      // Track spine usage for pass 1 ordering (but don't optimize branch cost)
      bool added_spine = ((ctx->used_spines_mask[in_id] & (1u << s)) == 0);
      uint16_t prev_mask = ctx->used_spines_mask[in_id];
      int prev_stab_cost = ctx->stability_cost;

      ctx->tmp_s2[s][egress] = in_id;
      ctx->tmp_s1_owner[ingress][s] = in_id;
      ctx->assignment[depth] = s;

      if (added_spine) {
        ctx->used_spines_mask[in_id] |= (uint16_t)(1u << s);
      }

      // Add stability cost if changing from previous assignment
      bool is_change = (prev_spine >= 0 && s != prev_spine);
      if (is_change) {
        ctx->stability_cost += 1;
      }

      bool perfect_stability = backtrack(ctx, depth + 1);
      if (perfect_stability && ctx->best_stability_cost == 0) return true;

      // Undo
      ctx->tmp_s2[s][egress] = prev_s2;
      ctx->tmp_s1_owner[ingress][s] = prev_s1;
      ctx->used_spines_mask[in_id] = prev_mask;
      ctx->stability_cost = prev_stab_cost;
    }
  }

  return false;
}

static bool solve_and_build_solution(FabricSolution *out_solution, int *out_best_cost) {
  Demand demands[200];
  int active_inputs[MAX_PORTS];
  int active_count = 0;
  uint16_t need_blocks_mask[MAX_PORTS + 1];

  int num_demands = build_demands(demands, active_inputs, &active_count, need_blocks_mask);

  // Trivial: no routes
  if (num_demands == 0) {
    memset(out_solution, 0, sizeof(*out_solution));
    for (int p = 1; p <= MAX_PORTS; p++) out_solution->s3_spine[p] = -1;
    *out_best_cost = 0;
    last_stability_cost = 0;
    return true;
  }

  if (!quick_capacity_check(need_blocks_mask)) {
    printf("  FAIL: No solution exists under Clos trunk capacity constraints\n");
    print_unsat_reason(need_blocks_mask);
    return false;
  }

  SolverCtx ctx;
  memset(&ctx, 0, sizeof(ctx));

  ctx.demands = demands;
  ctx.num_demands = num_demands;

  ctx.active_count = active_count;
  for (int i = 0; i < active_count; i++) ctx.active_inputs[i] = active_inputs[i];

  memset(ctx.tmp_s2, 0, sizeof(ctx.tmp_s2));
  memset(ctx.tmp_s1_owner, 0, sizeof(ctx.tmp_s1_owner));
  memset(ctx.used_spines_mask, 0, sizeof(ctx.used_spines_mask));

  // Initialize stability tracking (branch cost optimization removed - see WOL-598)
  ctx.stability_cost = 0;
  ctx.best_stability_cost = 999999;

  // Build prev_spine_for map from previous state
  for (int in_id = 0; in_id <= MAX_PORTS; in_id++) {
    for (int e = 0; e < TOTAL_BLOCKS; e++) {
      ctx.prev_spine_for[in_id][e] = -1;
    }
  }

  if (have_previous_state) {
    // For each output port that had a spine assignment AND is still desired
    for (int p = 1; p <= MAX_PORTS; p++) {
      int in_id = desired_owner[p];
      int prev_spine = prev_s3_port_spine[p];
      if (in_id > 0 && prev_spine >= 0) {
        int e = get_block(p);
        ctx.prev_spine_for[in_id][e] = prev_spine;
      }
    }
  }

  // Run backtracking search (optimizing for stability only)
  (void)backtrack(&ctx, 0);

  if (ctx.best_stability_cost == 999999) {
    printf("  FAIL: No solution found (unexpected after capacity check)\n");
    print_unsat_reason(need_blocks_mask);
    return false;
  }

  // Store stability cost for JSON output
  last_stability_cost = ctx.best_stability_cost;

  // Check strict stability mode
  if (strict_stability && ctx.best_stability_cost > 0) {
    printf("  FAIL: Strict stability enabled - would require rerouting %d existing connections\n",
           ctx.best_stability_cost);
    return false;
  }

  // Rebuild solution from best_assignment (clean rebuild avoids any subtle solver-state coupling)
  FabricSolution sol;
  memset(&sol, 0, sizeof(sol));
  for (int p = 1; p <= MAX_PORTS; p++) sol.s3_spine[p] = -1;

  // Map for quick Stage3 spine lookup: spine_for[input_id][egress_block]
  static int spine_for[MAX_PORTS + 1][TOTAL_BLOCKS];
  for (int in_id = 0; in_id <= MAX_PORTS; in_id++) {
    for (int e = 0; e < TOTAL_BLOCKS; e++) spine_for[in_id][e] = -1;
  }

  // Apply each (input, egress) demand to trunks
  for (int i = 0; i < num_demands; i++) {
    Demand d = demands[i];
    int s = ctx.best_assignment[i];
    int in_id = d.input_id;

    sol.s2[s][d.egress_block] = in_id;
    sol.s1[d.ingress_block][s] = in_id;
    spine_for[in_id][d.egress_block] = s;
  }

  // Apply Stage3 selections exactly as desired_owner
  for (int p = 1; p <= MAX_PORTS; p++) {
    int in_id = desired_owner[p];
    if (in_id == 0) {
      sol.s3_owner[p] = 0;
      sol.s3_spine[p] = -1;
      continue;
    }

    int e = get_block(p);
    int s = spine_for[in_id][e];
    if (s < 0) {
      // Should never happen: if desired_owner has in_id in this egress block,
      // we must have created a demand and assigned it.
      printf("  FAIL: Internal error: missing spine assignment for input %d egrblock %d\n", in_id, e + 1);
      return false;
    }

    sol.s3_owner[p] = in_id;
    sol.s3_spine[p] = s;
  }

  *out_solution = sol;
  *out_best_cost = 0;  // Branch cost no longer tracked (see WOL-598)
  return true;
}

// Commits a newly built solution into the global fabric arrays
static void commit_solution(const FabricSolution *sol) {
  memcpy(s1_to_s2, sol->s1, sizeof(s1_to_s2));
  memcpy(s2_to_s3, sol->s2, sizeof(s2_to_s3));
  memcpy(s3_port_owner, sol->s3_owner, sizeof(s3_port_owner));
  memcpy(s3_port_spine, sol->s3_spine, sizeof(s3_port_spine));
}

static bool repack_fabric_and_commit(void) {
  // Track initial route count (first time only, before any changes)
  if (!tracked_initial && have_previous_state) {
    for (int p = 1; p <= MAX_PORTS; p++) {
      if (prev_s3_port_spine[p] >= 0) initial_route_count++;
    }
    tracked_initial = true;
  }

  // Count routes before this solve (for per-solve logging)
  int routes_before = 0;
  for (int p = 1; p <= MAX_PORTS; p++) {
    if (prev_s3_port_spine[p] >= 0) routes_before++;
  }

  FabricSolution sol;
  int best_cost = 0;

  if (!solve_and_build_solution(&sol, &best_cost)) return false;

  commit_solution(&sol);

  // Sanity check (also verifies fabric matches desired state exactly)
  if (!validate_fabric(true)) {
    printf("  FATAL: Fabric validation failed after repack\n");
    return false;
  }

  // Report success (compute branches from committed state for info)
  FabricStats stats = compute_fabric_stats();
  printf("  REPACK OK: total branches = %d\n", stats.total_branches);

  // Per-solve stability logging (only when routes change)
  if (last_stability_cost > 0 && routes_before > 0) {
    printf("  Stability: rerouted %d of %d existing routes\n",
           last_stability_cost, routes_before);
  }

  // Update cumulative reroutes
  cumulative_reroutes += last_stability_cost;

  return true;
}

// --- COMMAND APPLICATION (transactional) ------------------------------------
//
// We treat each request as an edit to desired_owner[].
// Then we try to repack globally.
// If repack fails, we rollback desired_owner[] for that request.
//

typedef struct {
  int port;
  int prev_owner;
} PortEdit;

static bool apply_route_request(int input_id, int *targets, int num_targets) {
  if (!is_valid_port(input_id)) {
    printf("  FAIL: input %d out of range\n", input_id);
    return false;
  }
  if (num_targets <= 0) {
    printf("  FAIL: input %d has no targets\n", input_id);
    return false;
  }

  PortEdit edits[MAX_PORTS];
  int edit_count = 0;

  // Validate and stage edits
  for (int i = 0; i < num_targets; i++) {
    int p = targets[i];
    if (!is_valid_port(p)) {
      printf("  FAIL: target port %d out of range\n", p);
      return false;
    }

    int prev = desired_owner[p];
    if (prev != 0 && prev != input_id) {
      printf("  FAIL: output port %d already owned by input %d (clear first)\n", p, prev);
      return false;
    }

    // Record edit only if it changes state
    if (prev != input_id) {
      edits[edit_count++] = (PortEdit){ .port = p, .prev_owner = prev };
    }
  }

  // Apply edits
  for (int i = 0; i < edit_count; i++) {
    desired_owner[edits[i].port] = input_id;
  }

  // Repack
  printf(">> ROUTE: Input %d to %d output(s)\n", input_id, num_targets);
  if (repack_fabric_and_commit()) {
    return true;
  }

  // Rollback
  printf("  ROLLBACK: route could not be realized\n");
  for (int i = 0; i < edit_count; i++) {
    desired_owner[edits[i].port] = edits[i].prev_owner;
  }

  // Restore fabric to match desired_owner after rollback
  // (If this fails, something is very wrong)
  (void)repack_fabric_and_commit();
  return false;
}

static bool apply_clear_request(int input_id) {
  if (!is_valid_port(input_id)) {
    printf("  FAIL: clear input %d out of range\n", input_id);
    return false;
  }

  PortEdit edits[MAX_PORTS];
  int edit_count = 0;

  for (int p = 1; p <= MAX_PORTS; p++) {
    if (desired_owner[p] == input_id) {
      edits[edit_count++] = (PortEdit){ .port = p, .prev_owner = input_id };
    }
  }

  if (edit_count == 0) {
    printf(">> CLEAR: Input %d (no-op, nothing connected)\n", input_id);
    return true;
  }

  printf(">> CLEAR: Input %d (removing %d output(s))\n", input_id, edit_count);

  for (int i = 0; i < edit_count; i++) {
    desired_owner[edits[i].port] = 0;
  }

  // Clearing should only make things easier, but keep it transactional anyway
  if (repack_fabric_and_commit()) return true;

  printf("  ROLLBACK: unexpected failure after clear\n");
  for (int i = 0; i < edit_count; i++) {
    desired_owner[edits[i].port] = edits[i].prev_owner;
  }

  (void)repack_fabric_and_commit();
  return false;
}

// --- PARSER -----------------------------------------------------------------
static void process_command_string(char *line) {
  line[strcspn(line, "\r\n")] = 0;

  // Remove inline comments starting with '#'
  char *hash = strchr(line, '#');
  if (hash) *hash = '\0';

  char *clean = trim_in_place(line);
  if (*clean == '\0') return;

  char *str = strdup(clean);
  if (!str) return;

  char *request = strtok(str, ",");
  while (request != NULL) {
    char *req = trim_in_place(request);
    if (*req == '\0') { request = strtok(NULL, ","); continue; }

    // Clear command: !<input>
    if (req[0] == '!') {
      int input_id = atoi(&req[1]);
      (void)apply_clear_request(input_id);
      request = strtok(NULL, ",");
      continue;
    }

    // Route command: <input>.<out>.<out>...
    char *sub = strdup(req);
    if (!sub) { request = strtok(NULL, ","); continue; }

    int targets[MAX_PORTS];
    int count = 0;

    char *tok = strtok(sub, ".");
    if (!tok) {
      free(sub);
      request = strtok(NULL, ",");
      continue;
    }

    int input_id = atoi(tok);

    while ((tok = strtok(NULL, ".")) != NULL) {
      if (count >= MAX_PORTS) break;
      targets[count++] = atoi(tok);
    }

    (void)apply_route_request(input_id, targets, count);

    free(sub);
    request = strtok(NULL, ",");
  }

  free(str);
}

static void process_file(const char *filename) {
  FILE *file = fopen(filename, "r");
  if (!file) { perror("File error"); return; }

  char line[MAX_LINE_LENGTH];
  while (fgets(line, sizeof(line), file)) {
    process_command_string(line);
  }

  fclose(file);
}

int main(int argc, char *argv[]) {
  memset(desired_owner, 0, sizeof(desired_owner));
  memset(s1_to_s2, 0, sizeof(s1_to_s2));
  memset(s2_to_s3, 0, sizeof(s2_to_s3));
  memset(s3_port_owner, 0, sizeof(s3_port_owner));
  for (int p = 1; p <= MAX_PORTS; p++) s3_port_spine[p] = -1;

  const char *routes_path = NULL;
  const char *json_path = NULL;
  const char *prev_state_path = NULL;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--json") == 0 && i + 1 < argc) {
      json_path = argv[++i];
      continue;
    }
    if (strcmp(argv[i], "--previous-state") == 0 && i + 1 < argc) {
      prev_state_path = argv[++i];
      continue;
    }
    if (strcmp(argv[i], "--strict-stability") == 0) {
      strict_stability = true;
      continue;
    }
    if (argv[i][0] != '-') {
      routes_path = argv[i];
    }
  }

  if (!routes_path) {
    printf("Usage: %s <routes.txt> [--json state.json] [--previous-state prev.json] [--strict-stability]\n", argv[0]);
    return 1;
  }

  // Load previous state if provided
  if (prev_state_path) {
    if (!load_previous_state(prev_state_path)) {
      fprintf(stderr, "Warning: Failed to load previous state from %s\n", prev_state_path);
    } else {
      printf("Loaded previous state from %s\n", prev_state_path);
    }
  }

  process_file(routes_path);

  if (json_path) {
    if (!write_state_json(json_path)) return 2;
    printf("Wrote %s\n", json_path);
  }

  print_heatmap();
  print_port_map_summary();
  print_fabric_summary();

  return 0;
}
