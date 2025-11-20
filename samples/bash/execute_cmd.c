#include <stdio.h>
#include <string.h>

struct execution_plan {
  char command[64];
  int steps;
};

static void prepare_environment(struct execution_plan *plan);
static void run_steps(struct execution_plan *plan);
static void persist_telemetry(const struct execution_plan *plan);
static void record_metric(const char *key, const char *value);

void execute_command_internal(const char *command) {
  struct execution_plan plan;
  memset(&plan, 0, sizeof(plan));
  strncpy(plan.command, command, sizeof(plan.command) - 1);
  prepare_environment(&plan);
  run_steps(&plan);
  persist_telemetry(&plan);
}

static void prepare_environment(struct execution_plan *plan) {
  printf("[executor] preparing environment for %s\\n", plan->command);
  record_metric("prepare", plan->command);
  plan->steps += 1;
}

static void run_steps(struct execution_plan *plan) {
  printf("[executor] running primary step for %s\\n", plan->command);
  plan->steps += 1;
  if (strcmp(plan->command, "sync-jobs") == 0) {
    record_metric("jobs", "synchronized");
  }
}

static void persist_telemetry(const struct execution_plan *plan) {
  printf("[executor] telemetry for %s (%d steps)\\n", plan->command, plan->steps);
  record_metric("command", plan->command);
}

static void record_metric(const char *key, const char *value) {
  printf("[telemetry] %s=%s\\n", key, value);
}
