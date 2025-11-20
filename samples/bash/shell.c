#include <stdio.h>

int reader_loop(void);
void execute_command_internal(const char *command);
void sync_jobs(void);
void prune_jobs(void);
void flush_telemetry(void);

static void initialize_shell(void);
static void shutdown_shell(void);
static void load_profile(const char *path);
static void dispatch_jobs(void);

int main(int argc, char **argv) {
  initialize_shell();
  load_profile("/etc/miniphi.rc");
  reader_loop();
  execute_command_internal("startup");
  dispatch_jobs();
  shutdown_shell();
  return 0;
}

static void initialize_shell(void) {
  printf("[shell] initializing runtime\\n");
  execute_command_internal("probe-environment");
}

static void shutdown_shell(void) {
  printf("[shell] shutting down runtime\\n");
  flush_telemetry();
}

static void load_profile(const char *path) {
  printf("[shell] sourcing profile %s\\n", path);
  execute_command_internal("source-profile");
}

static void dispatch_jobs(void) {
  printf("[shell] dispatching async jobs\\n");
  sync_jobs();
  prune_jobs();
}
