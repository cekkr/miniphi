#include <stdio.h>
#include <string.h>

void execute_command_internal(const char *command);

static int read_command(char *buffer, size_t size);
static int validate_command(const char *command);
static void normalize_command(const char *command, char *out, size_t size);

int reader_loop(void) {
  char buffer[128];
  while (read_command(buffer, sizeof(buffer))) {
    if (!validate_command(buffer)) {
      continue;
    }
    char normalized[128];
    normalize_command(buffer, normalized, sizeof(normalized));
    execute_command_internal(normalized);
  }
  return 0;
}

static int read_command(char *buffer, size_t size) {
  static const char *commands[] = {"build-cache", "sync-jobs", "flush"};
  static size_t index = 0;
  if (index >= sizeof(commands) / sizeof(commands[0])) {
    return 0;
  }
  strncpy(buffer, commands[index], size - 1);
  buffer[size - 1] = '\\0';
  index += 1;
  return 1;
}

static int validate_command(const char *command) {
  return command && strlen(command) > 2;
}

static void normalize_command(const char *command, char *out, size_t size) {
  size_t length = strlen(command);
  if (length + 1 > size) {
    length = size - 1;
  }
  for (size_t i = 0; i < length; i += 1) {
    char ch = command[i];
    out[i] = (char)(ch >= 'A' && ch <= 'Z' ? ch - 'A' + 'a' : ch);
  }
  out[length] = '\\0';
}
