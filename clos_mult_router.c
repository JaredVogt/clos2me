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
// Model (symmetric C(N,N,N), default N=10):
// - Stage 1: N ingress blocks, N ports each (ports 1..N^2)
// - Stage 2: N spines
// - Stage 3: N egress blocks, N ports each (ports 1..N^2)
//
// Key constraints (route isolation in the sense you mean):
// 1) Each ingress-block -> spine trunk is owned by at most one input.
// 2) Each spine -> egress-block trunk is owned by at most one input.
// 3) Each output port selects exactly one trunk (one-of-m selection).
//
// Mult behavior:
// - multiple output ports in the SAME egress block can share the same (spine, egress-block) trunk for a given input
// - congestion occurs when too many distinct inputs want to reach the same egress block (max N in this topology)

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <ctype.h>
#include <stdint.h>
#include <limits.h>
#include <sys/time.h>

#define MAX_LINE_LENGTH 1024

// --- SIZE CONFIG ------------------------------------------------------------
// Runtime-configurable Clos size (C(N,N,N)). Defaults to N=10.
static int g_N = 10;
static int g_total_blocks = 10;
static int g_max_ports = 100;
static size_t g_max_demands = 0;

#define N (g_N)
#define TOTAL_BLOCKS (g_total_blocks)
#define MAX_PORTS (g_max_ports)

// --- DESIRED STATE -----------------------------------------------------------
// The "truth" this app tries to realize in the fabric:
// desired_owner[out_port] = input_id (0 = disconnected)
static int *desired_owner = NULL;

// --- PREVIOUS STATE (for stability) -----------------------------------------
// When --previous-state is provided, we try to preserve existing spine assignments
static int *prev_s3_port_spine = NULL;  // previous spine assignments (-1 = none)
static bool have_previous_state = false;
static bool strict_stability = false;  // --strict-stability flag
static int last_stability_cost = 0;    // track changes from previous state

// --- STABILITY METRICS (cumulative across all commands) ----------------------
static int cumulative_reroutes = 0;      // total spine changes across all solves
static int cumulative_output_reroutes = 0; // total output-port spine changes across all solves
static int initial_route_count = 0;      // routes at start of file (from previous state)
static bool tracked_initial = false;     // whether we've captured initial state
static long long total_solve_us = 0;     // cumulative solve time across all repacks
static long long last_solve_us = 0;      // last repack solve time
static int repack_count = 0;             // number of successful repacks

// --- FABRIC STATE (realized solution) ---------------------------------------
static int **s1_to_s2 = NULL;            // ingress block -> spine trunk owner (0 free, else input_id)
static int *s1_to_s2_storage = NULL;
static int **s2_to_s3 = NULL;            // spine -> egress block trunk owner (0 free, else input_id)
static int *s2_to_s3_storage = NULL;
static int *s3_port_owner = NULL;        // output port -> input_id (0 free)
static int *s3_port_spine = NULL;        // output port -> spine index (0..N-1), -1 if disconnected

// --- LOCKED PATHS -----------------------------------------------------------
// lock_spine_for[input_id][egress_block] = spine (0..N-1), or -1 if unlocked
static int **lock_spine_for = NULL;
static int *lock_spine_for_storage = NULL;
static bool have_locks = false;
static int last_locked_demands = 0;
static int last_locked_outputs = 0;

typedef struct {
  int input_id;
  int egress_block;
  int spine;
  const char *reason;
} LockConflict;

static LockConflict *lock_conflicts = NULL;
static int lock_conflict_count = 0;
static int lock_conflict_cap = 0;

static int last_rerouted_outputs = 0;

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

// --- DYNAMIC ALLOCATION HELPERS ---------------------------------------------
static int **alloc_int_matrix(int rows, int cols, int **out_storage) {
  if (out_storage) *out_storage = NULL;
  int *storage = calloc((size_t)rows * (size_t)cols, sizeof(int));
  if (!storage) return NULL;

  int **rows_ptr = malloc((size_t)rows * sizeof(int *));
  if (!rows_ptr) {
    free(storage);
    return NULL;
  }

  for (int r = 0; r < rows; r++) {
    rows_ptr[r] = storage + (size_t)r * cols;
  }

  if (out_storage) *out_storage = storage;
  return rows_ptr;
}

static void free_int_matrix(int **matrix, int *storage) {
  free(storage);
  free(matrix);
}

static inline int bitset_words(int bits) {
  return (bits + 63) / 64;
}

static inline uint64_t *bitset_row(uint64_t *base, int row, int word_count) {
  return base + (size_t)row * (size_t)word_count;
}

static inline const uint64_t *bitset_row_const(const uint64_t *base, int row, int word_count) {
  return base + (size_t)row * (size_t)word_count;
}

static inline bool bitset_any(const uint64_t *row, int word_count) {
  for (int i = 0; i < word_count; i++) {
    if (row[i]) return true;
  }
  return false;
}

static inline bool bitset_test(const uint64_t *row, int bit) {
  return (row[bit >> 6] & (1ULL << (bit & 63))) != 0;
}

static inline void bitset_set(uint64_t *row, int bit) {
  row[bit >> 6] |= (1ULL << (bit & 63));
}

static inline int bitset_popcount(const uint64_t *row, int word_count) {
  int count = 0;
  for (int i = 0; i < word_count; i++) {
    count += __builtin_popcountll(row[i]);
  }
  return count;
}

static inline long long now_us(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (long long)tv.tv_sec * 1000000LL + (long long)tv.tv_usec;
}

static void compute_lock_counts(const uint64_t *need_blocks_mask, int block_words) {
  last_locked_demands = 0;
  last_locked_outputs = 0;
  if (!have_locks) return;

  for (int in_id = 1; in_id <= MAX_PORTS; in_id++) {
    for (int e = 0; e < TOTAL_BLOCKS; e++) {
      int s = lock_spine_for[in_id][e];
      if (s < 0) continue;
      if (bitset_test(bitset_row_const(need_blocks_mask, in_id, block_words), e)) {
        last_locked_demands++;
      }
    }
  }

  for (int p = 1; p <= MAX_PORTS; p++) {
    int owner = desired_owner[p];
    if (owner <= 0) continue;
    int e = get_block(p);
    if (lock_spine_for[owner][e] >= 0) {
      last_locked_outputs++;
    }
  }
}

// --- LOCK HELPERS -----------------------------------------------------------
static void clear_lock_conflicts(void) {
  lock_conflict_count = 0;
}

static void add_lock_conflict(int input_id, int egress_block, int spine, const char *reason) {
  if (lock_conflict_count >= lock_conflict_cap) {
    int new_cap = lock_conflict_cap == 0 ? 8 : lock_conflict_cap * 2;
    LockConflict *next = realloc(lock_conflicts, sizeof(LockConflict) * (size_t)new_cap);
    if (!next) return;
    lock_conflicts = next;
    lock_conflict_cap = new_cap;
  }
  lock_conflicts[lock_conflict_count++] = (LockConflict){
    .input_id = input_id,
    .egress_block = egress_block,
    .spine = spine,
    .reason = reason
  };
}

static void reset_locks(void) {
  free_int_matrix(lock_spine_for, lock_spine_for_storage);
  lock_spine_for = alloc_int_matrix(MAX_PORTS + 1, TOTAL_BLOCKS, &lock_spine_for_storage);
  if (!lock_spine_for) return;
  for (int i = 0; i <= MAX_PORTS; i++) {
    for (int e = 0; e < TOTAL_BLOCKS; e++) {
      lock_spine_for[i][e] = -1;
    }
  }
  have_locks = false;
}

static bool parse_int_after_key(const char *start, const char *key, int *out) {
  char *k = strstr((char *)start, key);
  if (!k) return false;
  char *colon = strchr(k, ':');
  if (!colon) return false;
  char *p = colon + 1;
  while (*p && isspace((unsigned char)*p)) p++;
  int sign = 1;
  if (*p == '-') { sign = -1; p++; }
  if (*p < '0' || *p > '9') return false;
  int val = 0;
  while (*p >= '0' && *p <= '9') {
    val = val * 10 + (*p - '0');
    p++;
  }
  *out = sign * val;
  return true;
}

static bool load_locks(const char *path) {
  clear_lock_conflicts();
  reset_locks();
  if (!path) return true;

  FILE *f = fopen(path, "r");
  if (!f) {
    perror("locks file");
    return false;
  }

  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, 0, SEEK_SET);

  char *buf = malloc((size_t)len + 1);
  if (!buf) {
    fclose(f);
    return false;
  }

  size_t read_len = fread(buf, 1, (size_t)len, f);
  buf[read_len] = '\0';
  fclose(f);

  char *p = buf;
  while ((p = strstr(p, "\"input\"")) != NULL) {
    int input_id = -1;
    int egress_block = -1;
    int spine = -1;

    if (!parse_int_after_key(p, "\"input\"", &input_id)) { p += 6; continue; }
    if (!parse_int_after_key(p, "\"egressBlock\"", &egress_block)) {
      if (!parse_int_after_key(p, "\"egress\"", &egress_block)) { p += 6; continue; }
    }
    if (!parse_int_after_key(p, "\"spine\"", &spine)) { p += 6; continue; }

    if (!is_valid_port(input_id) || egress_block < 0 || egress_block >= TOTAL_BLOCKS || spine < 0 || spine >= N) {
      add_lock_conflict(input_id, egress_block, spine, "RANGE");
      p += 6;
      continue;
    }

    int existing = lock_spine_for[input_id][egress_block];
    if (existing >= 0 && existing != spine) {
      add_lock_conflict(input_id, egress_block, spine, "CONFLICT");
      p += 6;
      continue;
    }

    lock_spine_for[input_id][egress_block] = spine;
    have_locks = true;
    p += 6;
  }

  free(buf);
  return true;
}

static bool validate_locks_against_demands(const uint64_t *need_blocks_mask, int block_words) {
  if (!have_locks) return lock_conflict_count == 0;

  int *locked_s2_storage = NULL;
  int **locked_s2 = alloc_int_matrix(N, TOTAL_BLOCKS, &locked_s2_storage);
  int *locked_s1_storage = NULL;
  int **locked_s1 = alloc_int_matrix(TOTAL_BLOCKS, N, &locked_s1_storage);
  if (!locked_s2 || !locked_s1) {
    free_int_matrix(locked_s2, locked_s2_storage);
    free_int_matrix(locked_s1, locked_s1_storage);
    return false;
  }

  bool ok = true;
  for (int in_id = 1; in_id <= MAX_PORTS; in_id++) {
    for (int e = 0; e < TOTAL_BLOCKS; e++) {
      int s = lock_spine_for[in_id][e];
      if (s < 0) continue;

      if (!bitset_test(bitset_row_const(need_blocks_mask, in_id, block_words), e)) {
        continue; // lock applies only when the demand exists
      }

      int ingress = get_block(in_id);
      int s2_owner = locked_s2[s][e];
      if (s2_owner != 0 && s2_owner != in_id) {
        add_lock_conflict(in_id, e, s, "CONFLICT");
        printf("  LOCK CONFLICT: input %d egress %d spine %d (CONFLICT)\n", in_id, e + 1, s + 1);
        ok = false;
      } else {
        locked_s2[s][e] = in_id;
      }

      int s1_owner = locked_s1[ingress][s];
      if (s1_owner != 0 && s1_owner != in_id) {
        add_lock_conflict(in_id, e, s, "CONFLICT");
        printf("  LOCK CONFLICT: input %d egress %d spine %d (CONFLICT)\n", in_id, e + 1, s + 1);
        ok = false;
      } else {
        locked_s1[ingress][s] = in_id;
      }
    }
  }

  free_int_matrix(locked_s2, locked_s2_storage);
  free_int_matrix(locked_s1, locked_s1_storage);
  return ok && lock_conflict_count == 0;
}

static void free_fabric(void) {
  free(desired_owner);
  free(prev_s3_port_spine);
  free(s3_port_owner);
  free(s3_port_spine);
  free_int_matrix(s1_to_s2, s1_to_s2_storage);
  free_int_matrix(s2_to_s3, s2_to_s3_storage);
  free_int_matrix(lock_spine_for, lock_spine_for_storage);
  free(lock_conflicts);
  desired_owner = NULL;
  prev_s3_port_spine = NULL;
  s3_port_owner = NULL;
  s3_port_spine = NULL;
  s1_to_s2 = NULL;
  s1_to_s2_storage = NULL;
  s2_to_s3 = NULL;
  s2_to_s3_storage = NULL;
  lock_spine_for = NULL;
  lock_spine_for_storage = NULL;
  lock_conflicts = NULL;
  lock_conflict_count = 0;
  lock_conflict_cap = 0;
  last_locked_demands = 0;
  last_locked_outputs = 0;
  last_rerouted_outputs = 0;
  cumulative_output_reroutes = 0;
  total_solve_us = 0;
  last_solve_us = 0;
  repack_count = 0;
}

static bool init_fabric(int size) {
  if (size < 2) {
    fprintf(stderr, "Invalid size %d (must be >= 2)\n", size);
    return false;
  }

  long long max_ports = (long long)size * (long long)size;
  if (max_ports > INT_MAX - 1) {
    fprintf(stderr, "Invalid size %d (MAX_PORTS would overflow int)\n", size);
    return false;
  }

  g_N = size;
  g_total_blocks = size;
  g_max_ports = (int)max_ports;
  g_max_demands = (size_t)g_max_ports * (size_t)g_total_blocks;
  if (g_max_demands > (size_t)INT_MAX) {
    fprintf(stderr, "Invalid size %d (max demands exceed int range)\n", size);
    return false;
  }

  desired_owner = calloc((size_t)g_max_ports + 1, sizeof(int));
  prev_s3_port_spine = malloc(sizeof(int) * ((size_t)g_max_ports + 1));
  s3_port_owner = calloc((size_t)g_max_ports + 1, sizeof(int));
  s3_port_spine = malloc(sizeof(int) * ((size_t)g_max_ports + 1));
  s1_to_s2 = alloc_int_matrix(g_total_blocks, g_N, &s1_to_s2_storage);
  s2_to_s3 = alloc_int_matrix(g_N, g_total_blocks, &s2_to_s3_storage);

  if (!desired_owner || !prev_s3_port_spine || !s3_port_owner || !s3_port_spine || !s1_to_s2 || !s2_to_s3) {
    fprintf(stderr, "Out of memory initializing fabric\n");
    free_fabric();
    return false;
  }

  reset_locks();
  if (!lock_spine_for) {
    fprintf(stderr, "Out of memory initializing locks\n");
    free_fabric();
    return false;
  }

  for (int p = 0; p <= MAX_PORTS; p++) {
    prev_s3_port_spine[p] = -1;
    s3_port_spine[p] = -1;
  }

  return true;
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

static void json_write_lock_conflicts(FILE *f) {
  fputc('[', f);
  for (int i = 0; i < lock_conflict_count; i++) {
    const LockConflict *c = &lock_conflicts[i];
    fprintf(f, "{\"input\":%d,\"egress_block\":%d,\"spine\":%d,\"reason\":\"%s\"}",
            c->input_id, c->egress_block, c->spine, c->reason);
    if (i + 1 < lock_conflict_count) fputc(',', f);
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
  fprintf(f, "\"lock_conflicts\":");
  json_write_lock_conflicts(f);
  fprintf(f, ",");
  fprintf(f, "\"solve_ms\":%.3f,", last_solve_us / 1000.0);
  fprintf(f, "\"solve_total_ms\":%.3f,", total_solve_us / 1000.0);
  fprintf(f, "\"repack_count\":%d,", repack_count);
  fprintf(f, "\"reroutes_demands\":%d,", last_stability_cost);
  fprintf(f, "\"reroutes_outputs\":%d,", last_rerouted_outputs);
  fprintf(f, "\"locked_demands\":%d,", last_locked_demands);
  fprintf(f, "\"locked_outputs\":%d,", last_locked_outputs);

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
  printf("       ");
  for (int s = 0; s < N; s++) {
    printf("S%02d ", s + 1);
  }
  printf("\n");
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
  int *outputs_per_input = calloc((size_t)MAX_PORTS + 1, sizeof(int));
  int spine_words = bitset_words(N);
  uint64_t *spines_per_input = calloc(((size_t)MAX_PORTS + 1) * (size_t)spine_words, sizeof(uint64_t));
  if (!outputs_per_input || !spines_per_input) {
    free(outputs_per_input);
    free(spines_per_input);
    return stats;
  }

  for (int p = 1; p <= MAX_PORTS; p++) {
    int owner = s3_port_owner[p];
    int spine = s3_port_spine[p];

    if (owner > 0 && spine >= 0) {
      stats.routes_active++;
      outputs_per_input[owner]++;
      bitset_set(bitset_row(spines_per_input, owner, spine_words), spine);

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
    int spine_count = bitset_popcount(bitset_row(spines_per_input, in_id, spine_words), spine_words);
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

  free(outputs_per_input);
  free(spines_per_input);
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
    if (cumulative_reroutes > 0 || cumulative_output_reroutes > 0) {
      printf(" (rerouted demands %d, outputs %d across all commands)", cumulative_reroutes, cumulative_output_reroutes);
    }
    printf("\n");
  }

  if (repack_count > 0) {
    printf("Solve time: last %.3f ms, total %.3f ms (%d repack%s)\n",
           last_solve_us / 1000.0, total_solve_us / 1000.0, repack_count, repack_count == 1 ? "" : "s");
  }

  // Multicast section
  printf("\nMulticast:\n");
  printf("  Inputs with mult fanout: %d (inputs using 2+ outputs)\n", stats.inputs_with_mult);
  printf("  Inputs using 2+ spines: %d (branching in middle layer)\n", stats.inputs_multi_spine);
  printf("  Egress blocks with 2+ inputs: %d (mult in egress)\n", stats.egress_with_mult);

  if (last_locked_demands > 0 || last_locked_outputs > 0) {
    printf("  Locked demands: %d (locked outputs: %d)\n", last_locked_demands, last_locked_outputs);
  }

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
  int **s1;
  int *s1_storage;
  int **s2;
  int *s2_storage;
  int *s3_owner;
  int *s3_spine;
} FabricSolution;

static void free_solution(FabricSolution *sol) {
  if (!sol) return;
  free_int_matrix(sol->s1, sol->s1_storage);
  free_int_matrix(sol->s2, sol->s2_storage);
  free(sol->s3_owner);
  free(sol->s3_spine);
  *sol = (FabricSolution){0};
}

// Builds demands from desired_owner and returns count
static int build_demands(Demand *demands, int max_demands, int *active_inputs, int *active_count,
                         uint64_t *need_blocks_mask, int block_words) {
  // need_blocks_mask[input_id] is a bitset of egress blocks required by that input
  memset(need_blocks_mask, 0, sizeof(uint64_t) * ((size_t)MAX_PORTS + 1) * (size_t)block_words);

  for (int p = 1; p <= MAX_PORTS; p++) {
    int in_id = desired_owner[p];
    if (in_id == 0) continue;
    int e = get_block(p);
    bitset_set(bitset_row(need_blocks_mask, in_id, block_words), e);
  }

  int a = 0;
  for (int in_id = 1; in_id <= MAX_PORTS; in_id++) {
    if (bitset_any(bitset_row_const(need_blocks_mask, in_id, block_words), block_words)) {
      active_inputs[a++] = in_id;
    }
  }
  *active_count = a;

  int d = 0;
  for (int idx = 0; idx < a; idx++) {
    int in_id = active_inputs[idx];
    int ingress = get_block(in_id);
    for (int e = 0; e < TOTAL_BLOCKS; e++) {
      if (bitset_test(bitset_row_const(need_blocks_mask, in_id, block_words), e)) {
        if (d >= max_demands) {
          fprintf(stderr, "INTERNAL ERROR: demand overflow (%d >= %d)\n", d, max_demands);
          return -1;
        }
        demands[d++] = (Demand){ .input_id = in_id, .ingress_block = ingress, .egress_block = e };
      }
    }
  }

  return d;
}

static void print_unsat_reason(const uint64_t *need_blocks_mask, int block_words) {
  // Count distinct inputs per egress block and per ingress block
  int *inputs_per_egress = calloc((size_t)TOTAL_BLOCKS, sizeof(int));
  int *inputs_per_ingress = calloc((size_t)TOTAL_BLOCKS, sizeof(int));
  if (!inputs_per_egress || !inputs_per_ingress) {
    free(inputs_per_egress);
    free(inputs_per_ingress);
    return;
  }

  for (int in_id = 1; in_id <= MAX_PORTS; in_id++) {
    if (!bitset_any(bitset_row_const(need_blocks_mask, in_id, block_words), block_words)) continue;
    inputs_per_ingress[get_block(in_id)]++;

    for (int e = 0; e < TOTAL_BLOCKS; e++) {
      if (bitset_test(bitset_row_const(need_blocks_mask, in_id, block_words), e)) inputs_per_egress[e]++;
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

  free(inputs_per_egress);
  free(inputs_per_ingress);
}

static bool quick_capacity_check(const uint64_t *need_blocks_mask, int block_words) {
  // Egress capacity: each egress block has N trunks (one per spine)
  for (int e = 0; e < TOTAL_BLOCKS; e++) {
    int count = 0;
    for (int in_id = 1; in_id <= MAX_PORTS; in_id++) {
      if (bitset_test(bitset_row_const(need_blocks_mask, in_id, block_words), e)) count++;
    }
    if (count > N) return false;
  }

  // Ingress capacity: each ingress block has N spines; each active input needs at least 1 spine
  // (In this model, an input cannot share a spine with another input from the same ingress block.)
  for (int i = 0; i < TOTAL_BLOCKS; i++) {
    int count = 0;
    for (int in_id = 1; in_id <= MAX_PORTS; in_id++) {
      if (!bitset_any(bitset_row_const(need_blocks_mask, in_id, block_words), block_words)) continue;
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

  // Partial ownership constraints:
  // tmp_s2[spine][egress_block] = input_id (0 free)
  // tmp_s1_owner[ingress_block][spine] = input_id (0 free)
  int **tmp_s2;
  int *tmp_s2_storage;
  int **tmp_s1_owner;
  int *tmp_s1_owner_storage;

  // Spine usage per input (for pass 1 ordering - prefer reusing spines)
  uint64_t *used_spines_mask;
  int spine_words;

  // Assignment: chosen spine for each demand index
  int *assignment;
  int *best_assignment;

  // Stability: previous spine for each (input, egress_block)
  // -1 = new route (no previous), 0..N-1 = previous spine assignment
  int **prev_spine_for;
  int *prev_spine_for_storage;

  // Stability cost tracking (branch cost removed for speed - see WOL-598)
  int stability_cost;       // current count of spine changes from previous state
  int best_stability_cost;  // best solution's stability cost
} SolverCtx;

static int domain_size(const SolverCtx *ctx, const Demand *d) {
  int in_id = d->input_id;
  int ingress = d->ingress_block;
  int egress = d->egress_block;

  if (have_locks) {
    int locked = lock_spine_for[in_id][egress];
    if (locked >= 0) {
      if (ctx->tmp_s2[locked][egress] != 0 && ctx->tmp_s2[locked][egress] != in_id) return 0;
      int owner = ctx->tmp_s1_owner[ingress][locked];
      if (owner != 0 && owner != in_id) return 0;
      return 1;
    }
  }

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
  // Time-based progress reporting (every 5 seconds)
  static long long solve_attempts = 0;
  static struct timeval last_report = {0, 0};
  solve_attempts++;

  struct timeval now;
  gettimeofday(&now, NULL);
  long elapsed_ms = (now.tv_sec - last_report.tv_sec) * 1000 +
                    (now.tv_usec - last_report.tv_usec) / 1000;
  if (elapsed_ms >= 5000 || last_report.tv_sec == 0) {  // Every 5 seconds
    printf("[S] PROGRESS: %lld attempts in %lds (depth=%d/%d, best_cost=%d)\n",
           solve_attempts, now.tv_sec - last_report.tv_sec, depth, ctx->num_demands, ctx->best_stability_cost);
    last_report = now;
  }

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

  int locked_spine = -1;
  if (have_locks) {
    locked_spine = lock_spine_for[in_id][egress];
  }

  // Value ordering (3 passes for stability):
  // Pass 0: Try previous spine first (if exists) - preserves existing routes
  // Pass 1: Try spines already used by this input (reduces additional branches)
  // Pass 2: Try remaining spines
  int prev_spine = ctx->prev_spine_for[in_id][egress];
  uint64_t *used_row = bitset_row(ctx->used_spines_mask, in_id, ctx->spine_words);

  if (locked_spine >= 0) {
    int s = locked_spine;
    if (ctx->tmp_s2[s][egress] != 0 && ctx->tmp_s2[s][egress] != in_id) return false;
    int owner = ctx->tmp_s1_owner[ingress][s];
    if (owner != 0 && owner != in_id) return false;

    int prev_s2 = ctx->tmp_s2[s][egress];
    int prev_s1 = ctx->tmp_s1_owner[ingress][s];
    bool already_used = bitset_test(used_row, s);
    int word_index = s >> 6;
    uint64_t prev_word = used_row[word_index];
    int prev_stab_cost = ctx->stability_cost;

    ctx->tmp_s2[s][egress] = in_id;
    ctx->tmp_s1_owner[ingress][s] = in_id;
    ctx->assignment[depth] = s;

    if (!already_used) {
      used_row[word_index] = prev_word | (1ULL << (s & 63));
    }

    bool is_change = (prev_spine >= 0 && s != prev_spine);
    if (is_change) {
      ctx->stability_cost += 1;
    }

    bool perfect_stability = backtrack(ctx, depth + 1);
    if (perfect_stability && ctx->best_stability_cost == 0) return true;

    ctx->tmp_s2[s][egress] = prev_s2;
    ctx->tmp_s1_owner[ingress][s] = prev_s1;
    used_row[word_index] = prev_word;
    ctx->stability_cost = prev_stab_cost;
    return false;
  }

  for (int pass = 0; pass < 3; pass++) {
    for (int s = 0; s < N; s++) {
      bool is_prev = (prev_spine >= 0 && s == prev_spine);
      bool already_used = bitset_test(used_row, s);

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
      bool added_spine = !already_used;
      int word_index = s >> 6;
      uint64_t prev_word = used_row[word_index];
      int prev_stab_cost = ctx->stability_cost;

      ctx->tmp_s2[s][egress] = in_id;
      ctx->tmp_s1_owner[ingress][s] = in_id;
      ctx->assignment[depth] = s;

      if (added_spine) {
        used_row[word_index] = prev_word | (1ULL << (s & 63));
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
      used_row[word_index] = prev_word;
      ctx->stability_cost = prev_stab_cost;
    }
  }

  return false;
}

static bool solve_and_build_solution(FabricSolution *out_solution, int *out_best_cost) {
  int active_count = 0;
  int max_demands = (int)g_max_demands;
  int block_words = bitset_words(TOTAL_BLOCKS);
  int spine_words = bitset_words(N);

  Demand *demands = calloc((size_t)max_demands, sizeof(Demand));
  int *active_inputs = malloc(sizeof(int) * ((size_t)MAX_PORTS + 1));
  uint64_t *need_blocks_mask = calloc(((size_t)MAX_PORTS + 1) * (size_t)block_words, sizeof(uint64_t));
  if (!demands || !active_inputs || !need_blocks_mask) {
    free(demands);
    free(active_inputs);
    free(need_blocks_mask);
    return false;
  }

  int num_demands = build_demands(demands, max_demands, active_inputs, &active_count, need_blocks_mask, block_words);
  if (num_demands < 0) {
    free(demands);
    free(active_inputs);
    free(need_blocks_mask);
    return false;
  }

  compute_lock_counts(need_blocks_mask, block_words);

  if (!validate_locks_against_demands(need_blocks_mask, block_words)) {
    printf("  FAIL: Locked path conflict\n");
    free(demands);
    free(active_inputs);
    free(need_blocks_mask);
    return false;
  }

  // Trivial: no routes
  if (num_demands == 0) {
    *out_solution = (FabricSolution){0};
    out_solution->s1 = alloc_int_matrix(TOTAL_BLOCKS, N, &out_solution->s1_storage);
    out_solution->s2 = alloc_int_matrix(N, TOTAL_BLOCKS, &out_solution->s2_storage);
    out_solution->s3_owner = calloc((size_t)MAX_PORTS + 1, sizeof(int));
    out_solution->s3_spine = malloc(sizeof(int) * ((size_t)MAX_PORTS + 1));
    if (!out_solution->s1 || !out_solution->s2 || !out_solution->s3_owner || !out_solution->s3_spine) {
      free_int_matrix(out_solution->s1, out_solution->s1_storage);
      free_int_matrix(out_solution->s2, out_solution->s2_storage);
      free(out_solution->s3_owner);
      free(out_solution->s3_spine);
      free(demands);
      free(active_inputs);
      free(need_blocks_mask);
      return false;
    }
    for (int p = 1; p <= MAX_PORTS; p++) out_solution->s3_spine[p] = -1;
    *out_best_cost = 0;
    last_stability_cost = 0;
    free(demands);
    free(active_inputs);
    free(need_blocks_mask);
    return true;
  }

  if (!quick_capacity_check(need_blocks_mask, block_words)) {
    printf("  FAIL: No solution exists under Clos trunk capacity constraints\n");
    print_unsat_reason(need_blocks_mask, block_words);
    free(demands);
    free(active_inputs);
    free(need_blocks_mask);
    return false;
  }

  SolverCtx ctx;
  memset(&ctx, 0, sizeof(ctx));

  ctx.demands = demands;
  ctx.num_demands = num_demands;
  ctx.tmp_s2 = alloc_int_matrix(N, TOTAL_BLOCKS, &ctx.tmp_s2_storage);
  ctx.tmp_s1_owner = alloc_int_matrix(TOTAL_BLOCKS, N, &ctx.tmp_s1_owner_storage);
  ctx.used_spines_mask = calloc(((size_t)MAX_PORTS + 1) * (size_t)spine_words, sizeof(uint64_t));
  ctx.spine_words = spine_words;
  ctx.assignment = malloc(sizeof(int) * (size_t)max_demands);
  ctx.best_assignment = malloc(sizeof(int) * (size_t)max_demands);
  ctx.prev_spine_for = alloc_int_matrix(MAX_PORTS + 1, TOTAL_BLOCKS, &ctx.prev_spine_for_storage);

  if (!ctx.tmp_s2 || !ctx.tmp_s1_owner || !ctx.used_spines_mask || !ctx.assignment ||
      !ctx.best_assignment || !ctx.prev_spine_for) {
    free_int_matrix(ctx.tmp_s2, ctx.tmp_s2_storage);
    free_int_matrix(ctx.tmp_s1_owner, ctx.tmp_s1_owner_storage);
    free(ctx.used_spines_mask);
    free(ctx.assignment);
    free(ctx.best_assignment);
    free_int_matrix(ctx.prev_spine_for, ctx.prev_spine_for_storage);
    free(demands);
    free(active_inputs);
    free(need_blocks_mask);
    return false;
  }
  memset(ctx.assignment, 0, sizeof(int) * (size_t)max_demands);
  memset(ctx.best_assignment, 0, sizeof(int) * (size_t)max_demands);

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
    print_unsat_reason(need_blocks_mask, block_words);
    free_int_matrix(ctx.tmp_s2, ctx.tmp_s2_storage);
    free_int_matrix(ctx.tmp_s1_owner, ctx.tmp_s1_owner_storage);
    free(ctx.used_spines_mask);
    free(ctx.assignment);
    free(ctx.best_assignment);
    free_int_matrix(ctx.prev_spine_for, ctx.prev_spine_for_storage);
    free(demands);
    free(active_inputs);
    free(need_blocks_mask);
    return false;
  }

  // Store stability cost for JSON output
  last_stability_cost = ctx.best_stability_cost;

  // Check strict stability mode
  if (strict_stability && ctx.best_stability_cost > 0) {
    printf("  FAIL: Strict stability enabled - would require rerouting %d existing connections\n",
           ctx.best_stability_cost);
    free_int_matrix(ctx.tmp_s2, ctx.tmp_s2_storage);
    free_int_matrix(ctx.tmp_s1_owner, ctx.tmp_s1_owner_storage);
    free(ctx.used_spines_mask);
    free(ctx.assignment);
    free(ctx.best_assignment);
    free_int_matrix(ctx.prev_spine_for, ctx.prev_spine_for_storage);
    free(demands);
    free(active_inputs);
    free(need_blocks_mask);
    return false;
  }

  // Rebuild solution from best_assignment (clean rebuild avoids any subtle solver-state coupling)
  FabricSolution sol;
  memset(&sol, 0, sizeof(sol));
  sol.s1 = alloc_int_matrix(TOTAL_BLOCKS, N, &sol.s1_storage);
  sol.s2 = alloc_int_matrix(N, TOTAL_BLOCKS, &sol.s2_storage);
  sol.s3_owner = calloc((size_t)MAX_PORTS + 1, sizeof(int));
  sol.s3_spine = malloc(sizeof(int) * ((size_t)MAX_PORTS + 1));
  if (!sol.s1 || !sol.s2 || !sol.s3_owner || !sol.s3_spine) {
    free_int_matrix(sol.s1, sol.s1_storage);
    free_int_matrix(sol.s2, sol.s2_storage);
    free(sol.s3_owner);
    free(sol.s3_spine);
    free_int_matrix(ctx.tmp_s2, ctx.tmp_s2_storage);
    free_int_matrix(ctx.tmp_s1_owner, ctx.tmp_s1_owner_storage);
    free(ctx.used_spines_mask);
    free(ctx.assignment);
    free(ctx.best_assignment);
    free_int_matrix(ctx.prev_spine_for, ctx.prev_spine_for_storage);
    free(demands);
    free(active_inputs);
    free(need_blocks_mask);
    return false;
  }
  for (int p = 1; p <= MAX_PORTS; p++) sol.s3_spine[p] = -1;

  // Map for quick Stage3 spine lookup: spine_for[input_id][egress_block]
  int *spine_for_storage = NULL;
  int **spine_for = alloc_int_matrix(MAX_PORTS + 1, TOTAL_BLOCKS, &spine_for_storage);
  if (!spine_for) {
    free_int_matrix(sol.s1, sol.s1_storage);
    free_int_matrix(sol.s2, sol.s2_storage);
    free(sol.s3_owner);
    free(sol.s3_spine);
    free_int_matrix(ctx.tmp_s2, ctx.tmp_s2_storage);
    free_int_matrix(ctx.tmp_s1_owner, ctx.tmp_s1_owner_storage);
    free(ctx.used_spines_mask);
    free(ctx.assignment);
    free(ctx.best_assignment);
    free_int_matrix(ctx.prev_spine_for, ctx.prev_spine_for_storage);
    free(demands);
    free(active_inputs);
    free(need_blocks_mask);
    return false;
  }
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
      free_int_matrix(spine_for, spine_for_storage);
      free_int_matrix(sol.s1, sol.s1_storage);
      free_int_matrix(sol.s2, sol.s2_storage);
      free(sol.s3_owner);
      free(sol.s3_spine);
      free_int_matrix(ctx.tmp_s2, ctx.tmp_s2_storage);
      free_int_matrix(ctx.tmp_s1_owner, ctx.tmp_s1_owner_storage);
      free(ctx.used_spines_mask);
      free(ctx.assignment);
      free(ctx.best_assignment);
      free_int_matrix(ctx.prev_spine_for, ctx.prev_spine_for_storage);
      free(demands);
      free(active_inputs);
      free(need_blocks_mask);
      return false;
    }

    sol.s3_owner[p] = in_id;
    sol.s3_spine[p] = s;
  }

  *out_solution = sol;
  *out_best_cost = 0;  // Branch cost no longer tracked (see WOL-598)
  free_int_matrix(spine_for, spine_for_storage);
  free_int_matrix(ctx.tmp_s2, ctx.tmp_s2_storage);
  free_int_matrix(ctx.tmp_s1_owner, ctx.tmp_s1_owner_storage);
  free(ctx.used_spines_mask);
  free(ctx.assignment);
  free(ctx.best_assignment);
  free_int_matrix(ctx.prev_spine_for, ctx.prev_spine_for_storage);
  free(demands);
  free(active_inputs);
  free(need_blocks_mask);
  return true;
}

// Commits a newly built solution into the global fabric arrays
static void commit_solution(const FabricSolution *sol) {
  memcpy(s1_to_s2_storage, sol->s1_storage, sizeof(int) * (size_t)TOTAL_BLOCKS * (size_t)N);
  memcpy(s2_to_s3_storage, sol->s2_storage, sizeof(int) * (size_t)N * (size_t)TOTAL_BLOCKS);
  memcpy(s3_port_owner, sol->s3_owner, sizeof(int) * ((size_t)MAX_PORTS + 1));
  memcpy(s3_port_spine, sol->s3_spine, sizeof(int) * ((size_t)MAX_PORTS + 1));
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

  long long solve_start_us = now_us();
  if (!solve_and_build_solution(&sol, &best_cost)) return false;
  long long solve_us = now_us() - solve_start_us;
  last_solve_us = solve_us;
  total_solve_us += solve_us;
  repack_count++;
  double solve_ms = solve_us / 1000.0;
  double total_ms = total_solve_us / 1000.0;

  commit_solution(&sol);
  free_solution(&sol);

  // Sanity check (also verifies fabric matches desired state exactly)
  if (!validate_fabric(true)) {
    printf("  FATAL: Fabric validation failed after repack\n");
    return false;
  }

  // Report success (compute branches from committed state for info)
  FabricStats stats = compute_fabric_stats();
  if (have_previous_state) {
    last_rerouted_outputs = 0;
    for (int p = 1; p <= MAX_PORTS; p++) {
      int prev_spine = prev_s3_port_spine[p];
      int spine = s3_port_spine[p];
      if (prev_spine >= 0 && spine >= 0 && spine != prev_spine) {
        last_rerouted_outputs++;
      }
    }
    cumulative_output_reroutes += last_rerouted_outputs;
  } else {
    last_rerouted_outputs = 0;
  }

  printf("  REPACK OK: total branches = %d (solve %.3f ms, total %.3f ms)\n",
         stats.total_branches, solve_ms, total_ms);
  printf("  STATS: reroutes demands=%d outputs=%d | locks demands=%d outputs=%d\n",
         last_stability_cost, last_rerouted_outputs, last_locked_demands, last_locked_outputs);

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

  PortEdit *edits = malloc(sizeof(PortEdit) * (size_t)num_targets);
  int edit_count = 0;
  if (!edits) {
    printf("  FAIL: out of memory\n");
    return false;
  }

  // Validate and stage edits
  for (int i = 0; i < num_targets; i++) {
    int p = targets[i];
    if (!is_valid_port(p)) {
      printf("  FAIL: target port %d out of range\n", p);
      free(edits);
      return false;
    }

    int prev = desired_owner[p];
    if (prev != 0 && prev != input_id) {
      printf("  FAIL: output port %d already owned by input %d (clear first)\n", p, prev);
      free(edits);
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
    free(edits);
    return true;
  }

  // Rollback
  printf("  ROLLBACK: route could not be realized\n");
  for (int i = 0; i < edit_count; i++) {
    desired_owner[edits[i].port] = edits[i].prev_owner;
  }
  free(edits);

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

  PortEdit *edits = malloc(sizeof(PortEdit) * ((size_t)MAX_PORTS + 1));
  int edit_count = 0;
  if (!edits) {
    printf("  FAIL: out of memory\n");
    return false;
  }

  for (int p = 1; p <= MAX_PORTS; p++) {
    if (desired_owner[p] == input_id) {
      edits[edit_count++] = (PortEdit){ .port = p, .prev_owner = input_id };
    }
  }

  if (edit_count == 0) {
    printf(">> CLEAR: Input %d (no-op, nothing connected)\n", input_id);
    free(edits);
    return true;
  }

  printf(">> CLEAR: Input %d (removing %d output(s))\n", input_id, edit_count);

  for (int i = 0; i < edit_count; i++) {
    desired_owner[edits[i].port] = 0;
  }

  // Clearing should only make things easier, but keep it transactional anyway
  if (repack_fabric_and_commit()) {
    free(edits);
    return true;
  }

  printf("  ROLLBACK: unexpected failure after clear\n");
  for (int i = 0; i < edit_count; i++) {
    desired_owner[edits[i].port] = edits[i].prev_owner;
  }
  free(edits);

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

    int *targets = malloc(sizeof(int) * ((size_t)MAX_PORTS + 1));
    int count = 0;
    if (!targets) {
      free(sub);
      request = strtok(NULL, ",");
      continue;
    }

    char *tok = strtok(sub, ".");
    if (!tok) {
      free(targets);
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

    free(targets);
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
  // Unbuffered stdout for real-time streaming to frontend
  setbuf(stdout, NULL);

  const char *routes_path = NULL;
  const char *json_path = NULL;
  const char *prev_state_path = NULL;
  const char *locks_path = NULL;
  int requested_size = 10;

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
    if (strcmp(argv[i], "--locks") == 0 && i + 1 < argc) {
      locks_path = argv[++i];
      continue;
    }
    if (strcmp(argv[i], "--size") == 0 && i + 1 < argc) {
      requested_size = atoi(argv[++i]);
      continue;
    }
    if (argv[i][0] != '-') {
      routes_path = argv[i];
    }
  }

  if (!routes_path) {
    printf("Usage: %s <routes.txt> [--size N] [--json state.json] [--previous-state prev.json] [--locks locks.json] [--strict-stability]\n", argv[0]);
    return 1;
  }

  if (!init_fabric(requested_size)) {
    return 1;
  }

  if (locks_path) {
    if (!load_locks(locks_path)) {
      fprintf(stderr, "Warning: Failed to load locks from %s\n", locks_path);
    } else {
      printf("Loaded locks from %s\n", locks_path);
    }
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

  free_fabric();
  return 0;
}
