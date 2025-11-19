/*
 * bsh - The Extensible Shell
 * Version: 0.9 (Dynamic Expression Parsing & Script-Defined Operators)
 * Copyright: Riccardo Cecchini <rcecchini.ds@gmail.com>
 *
 * === Overview ===
 * bsh is an extensible, lightweight command-line shell where a significant portion
 * of its syntax, operator behavior, and data handling logic is defined and
 * managed by BSH (bsh script) files at runtime, rather than being hardcoded
 * in this C core. The C core provides a foundational parsing engine,
 * execution environment, and a set of built-in commands that empower BSH
 * scripts to dynamically shape the shell's language.
 *
 * === Core Architectural Principles & Extensibility Mechanisms ===
 *
 * 1.  **Minimal C Core, Maximal BSH Script Control:**
 * The C core is intentionally kept minimal. Its primary responsibilities include:
 * - Tokenizing input based on a small set of fundamental token types and
 * a dynamically populated list of operator symbols.
 * - Parsing and evaluating expressions using an operator-precedence
 * (e.g., precedence climbing) algorithm. This parser is guided by operator
 * properties (type, precedence, associativity) defined by BSH scripts.
 * - Managing execution flow for control structures (if, while, functions).
 * - Variable scoping and management.
 * - Providing built-in commands for core operations, including those that
 * allow BSH scripts to modify the shell's behavior (e.g., `defoperator`).
 * - Interfacing with the operating system for command execution and
 * dynamic library loading.
 *
 * 2.  **Script-Defined Operators (`defoperator` built-in):**
 * - BSH scripts use the `defoperator` command to define most operator
 * symbols (e.g., "+", "*", "==", "++", "?", ":").
 * - For each operator, the script specifies:
 * - `TYPE`: Its grammatical role (e.g., `BINARY_INFIX`, `UNARY_PREFIX`,
 * `TERNARY_PRIMARY`). This informs the C expression parser.
 * - `PRECEDENCE`: An integer determining its binding strength.
 * - `ASSOC`: Associativity (Left, Right, or Non-associative).
 * - `HANDLER`: The name of a BSH function that implements the
 * operator's logic.
 * - The C core's tokenizer learns these operator symbols, and its expression
 * parser uses these properties to correctly interpret expressions.
 *
 * 3.  **BSH-Handled Operator Semantics:**
 * - When the C expression parser determines an operator should be applied,
 * it calls the specific BSH function designated as the `HANDLER` for that
 * operator.
 * - The C core passes the operator symbol and the (already evaluated)
 * operands as string arguments to this BSH handler function.
 * - The BSH handler function is then responsible for:
 * - Performing type checking on the operands (e.g., using a `type.bsh`
 * framework).
 * - Executing the appropriate logic (e.g., calling C functions from a
 * dynamically loaded math library, performing string manipulation).
 * - Setting a result variable that the C core reads back.
 * - This mechanism replaces a single, monolithic `__dynamic_op_handler` with
 * a system of specific, targeted BSH functions for each operator.
 *
 * 4.  **Generalized Expression Evaluation (C Core):**
 * - The C function `evaluate_expression_from_tokens` (and its recursive
 * helpers like `parse_expression_recursive`) implements a robust
 * operator-precedence parsing algorithm.
 * - It consumes a stream of tokens (produced by `advanced_tokenize_line`)
 * and, using the BSH-defined operator properties, constructs an implicit
 * evaluation tree, calling out to BSH handlers as needed.
 * - This allows for complex, nested expressions with user-defined operators
 * and precedences.
 *
 * 5.  **Structured Data Handling (`object:` prefix & `echo` stringification):**
 * - Command output prefixed with `object:` (e.g., `object:["key":"val"]`)
 * is automatically parsed by the C core when assigned to a variable.
 * - The C core "flattens" this structure into a set of BSH variables
 * (e.g., `$myobj_key = "val"`), marked with a metadata variable
 * (e.g., `$myobj_BSH_STRUCT_TYPE = "BSH_OBJECT_ROOT"`).
 * - The `echo` command, when given a variable representing such a BSH object,
 * will automatically "stringify" it back into the `object:[...]` format.
 * - This allows BSH scripts and external commands to exchange structured data.
 *
 * 6.  **Variable Property Access (Dot Notation - C Core):**
 * - The C core's variable expansion logic (`expand_variables_in_string_advanced`)
 * directly supports dot notation for accessing properties of these flattened
 * BSH objects (e.g., `$myobj.user.name` resolves to `myobj_user_name`).
 *
 * 7.  **Dynamic C Library Integration (`def_c_lib`, `loadlib`, `calllib`):**
 * - BSH scripts (e.g., `c_compiler.bsh`) can provide functions like
 * `def_c_lib` to compile C source code (defined in BSH strings) into
 * shared libraries at runtime using a system C compiler.
 * - The `loadlib` built-in loads these (or pre-compiled) shared libraries.
 * - The `calllib` built-in allows BSH scripts to invoke functions within
 * these loaded C libraries, passing arguments and receiving results. This
 * is crucial for performance-sensitive tasks or system calls.
 *
 * 8.  **User-Defined Functions & Lexical Scoping (BSH & C):**
 * - The `function` (or `defunc`) keyword allows BSH scripts to define
 * multi-line shell functions with parameters and local (lexical) scoping,
 * managed by the C core's scope stack.
 *
 * 9.  **Modular Framework (`import`, `BSH_MODULE_PATH`):**
 * - The `import` command allows loading of BSH script modules from paths
 * defined in the `BSH_MODULE_PATH` environment variable, facilitating
 * code organization and reuse.
 *
 * === Tokenization (`advanced_tokenize_line`) ===
 * - Produces a stream of `Token` structs, including line/column info.
 * - `TokenType` is minimal: `TOKEN_WORD`, `TOKEN_STRING`, `TOKEN_NUMBER`,
 * `TOKEN_VARIABLE`, `TOKEN_OPERATOR` (generic), structural punctuation
 * (`TOKEN_LPAREN`, etc.), `TOKEN_COMMENT`, `TOKEN_EOF`, `TOKEN_ERROR`.
 * - Recognizes operators based on the dynamic list populated by `defoperator`.
 *
 * === Goal ===
 * To provide a highly dynamic and introspective shell environment where the
 * language itself can be evolved and customized extensively through scripting,
 * moving beyond the limitations of traditional shells with fixed syntax.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>
#include <stdbool.h>
#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <libgen.h>

// --- Constants and Definitions ---
#define MAX_LINE_LENGTH 2048
#define MAX_ARGS 128
#define MAX_VAR_NAME_LEN 256
#define INPUT_BUFFER_SIZE 4096
#define MAX_FULL_PATH_LEN 1024
#ifndef PATH_MAX
    #ifdef _XOPEN_PATH_MAX
        #define PATH_MAX _XOPEN_PATH_MAX
    #else
        #define PATH_MAX 4096
    #endif
#endif
#define TOKEN_STORAGE_SIZE (MAX_LINE_LENGTH * 2) // Should be ample for token text
#define MAX_NESTING_DEPTH 32
#define MAX_FUNC_LINES 100
#define MAX_FUNC_PARAMS 10
#define MAX_OPERATOR_LEN 16 // Increased for potentially longer operators like "?:"
#define DEFAULT_STARTUP_SCRIPT ".bshrc"
#define MAX_KEYWORD_LEN 32
#define MAX_SCOPE_DEPTH 64
#define DEFAULT_MODULE_PATH "./framework:~/.bsh_framework:/usr/local/share/bsh/framework"
#define MAX_EXPRESSION_TOKENS MAX_ARGS // Max tokens in a single expression to be parsed

#define JSON_STDOUT_PREFIX "json:" // json are not managed (?)
#define OBJECT_STDOUT_PREFIX "object:"

// --- Tokenizer Types (Simplified) ---
typedef enum {
    TOKEN_EMPTY,        // Should not appear in active processing
    TOKEN_WORD,         // Identifiers, command names, unquoted literals
    TOKEN_STRING,       // "quoted string"
    TOKEN_NUMBER,       // 123, 3.14 (parsed by C)
    TOKEN_VARIABLE,     // $var, ${var}
    TOKEN_OPERATOR,     // Generic for script-defined operators (+, ==, ++, ?:)
    TOKEN_LPAREN,       // (
    TOKEN_RPAREN,       // )
    TOKEN_LBRACE,       // {
    TOKEN_RBRACE,       // }
    TOKEN_LBRACKET,     // [
    TOKEN_RBRACKET,     // ]
    TOKEN_SEMICOLON,    // ;
    TOKEN_ASSIGN,       // = (could also be TOKEN_OPERATOR if fully dynamic)
    TOKEN_COMMENT,      // #...
    TOKEN_EOF,          // End of input
    TOKEN_ERROR         // Tokenization error
    // TOKEN_QMARK, TOKEN_COLON removed, will be TOKEN_OPERATOR
} TokenType;

typedef struct {
    TokenType type;
    const char *text; // Points into the token_storage buffer or original line
    int len;
    int line;         // Line number of the token
    int col;          // Column number of the token
    // Precedence and associativity are properties of OPERATORS, not tokens themselves.
    // They will be looked up from OperatorDefinition when a TOKEN_OPERATOR is encountered.
} Token;

// --- Operator Definition (Dynamic List) ---
typedef enum {
    OP_TYPE_NONE,
    OP_TYPE_UNARY_PREFIX,
    OP_TYPE_UNARY_POSTFIX,
    OP_TYPE_BINARY_INFIX,
    // For ternary "A ? B : C", '?' could be TERNARY_COND_OP and ':' could be TERNARY_BRANCH_OP
    // Or a single operator token like "?:" defined with a special type.
    // For simplicity, let's imagine "?" and ":" are defined separately with specific roles if used in ternary.
    // A more robust way for ternary is for "?" to expect a ":" later at the same precedence level.
    OP_TYPE_TERNARY_PRIMARY, // e.g., "?"
    OP_TYPE_TERNARY_SECONDARY, // e.g., ":"
    // Add other N-ary types if needed
} OperatorType;

typedef enum {
    ASSOC_NONE,
    ASSOC_LEFT,
    ASSOC_RIGHT
} OperatorAssociativity;

typedef struct OperatorDefinition {
    char op_str[MAX_OPERATOR_LEN + 1];
    TokenType token_type; // Will usually be TOKEN_OPERATOR, but can map to others if needed
    OperatorType op_type_prop; // The new type property (unary, binary, etc.)
    int precedence;
    OperatorAssociativity associativity;
    char bsh_handler_name[MAX_VAR_NAME_LEN]; // BSH function to call
    struct OperatorDefinition *next;
} OperatorDefinition;
OperatorDefinition *operator_list_head = NULL;

// --- Keyword Aliasing (Dynamic List) ---
typedef struct KeywordAlias {
    char original[MAX_KEYWORD_LEN + 1];
    char alias[MAX_KEYWORD_LEN + 1];
    struct KeywordAlias *next;
} KeywordAlias;
KeywordAlias *keyword_alias_head = NULL;

// --- PATH Directories (Dynamic List) ---
typedef struct PathDirNode {
    char *path;
    struct PathDirNode *next;
} PathDirNode;
PathDirNode *path_list_head = NULL;
PathDirNode *module_path_list_head = NULL;

// --- Variable Scoping and Management ---
typedef struct Variable {
    char name[MAX_VAR_NAME_LEN];
    char *value;
    bool is_array_element;
    int scope_id;
    struct Variable *next;
} Variable;
Variable *variable_list_head = NULL;

typedef struct ScopeFrame {
    int scope_id;
} ScopeFrame;
ScopeFrame scope_stack[MAX_SCOPE_DEPTH];
int scope_stack_top = -1;
int next_scope_id = 1;
#define GLOBAL_SCOPE_ID 0

// --- User-Defined Functions ---
typedef struct UserFunction {
    char name[MAX_VAR_NAME_LEN];
    char params[MAX_FUNC_PARAMS][MAX_VAR_NAME_LEN];
    int param_count;
    char* body[MAX_FUNC_LINES];
    int line_count;
    struct UserFunction *next;
} UserFunction;
UserFunction *function_list = NULL;
bool is_defining_function = false;
UserFunction *current_function_definition = NULL;


// --- Execution State and Block Management ---
typedef enum {
    STATE_NORMAL, STATE_BLOCK_EXECUTE, STATE_BLOCK_SKIP,
    STATE_DEFINE_FUNC_BODY, STATE_IMPORT_PARSING,
    STATE_RETURN_REQUESTED // For 'return' and 'exit' functionality
} ExecutionState;
ExecutionState current_exec_state = STATE_NORMAL;
// For 'return' or 'exit' with value
char bsh_last_return_value[INPUT_BUFFER_SIZE]; 
bool bsh_return_value_is_set = false;


typedef enum {
    BLOCK_TYPE_IF, BLOCK_TYPE_ELSE, BLOCK_TYPE_WHILE, BLOCK_TYPE_FUNCTION_DEF
} BlockType;

typedef struct BlockFrame {
    BlockType type;
    long loop_start_fpos;
    int loop_start_line_no;
    bool condition_true;
    ExecutionState prev_exec_state;
} BlockFrame;
BlockFrame block_stack[MAX_NESTING_DEPTH];
int block_stack_top_bf = -1;

// --- Dynamic Library Handles ---
typedef struct DynamicLib {
    char alias[MAX_VAR_NAME_LEN];
    void *handle;
    struct DynamicLib *next;
} DynamicLib;
DynamicLib *loaded_libs = NULL;

// --- Expression Parsing Context ---
// Used by the recursive descent parser
typedef struct ExprParseContext {
    Token* tokens;      // Array of tokens for the current expression
    int current_token_idx; // Index of the next token to process
    int num_tokens;     // Total number of tokens in the expression
    char* result_buffer; // Buffer to store the final result of the expression
    size_t result_buffer_size;
    int recursion_depth; // To prevent stack overflow in parser
} ExprParseContext;
#define MAX_EXPR_RECURSION_DEPTH 64


// --- Function Prototypes (Updated/New) ---
// Core
void initialize_shell();
void process_line(char *line, FILE *input_source, int current_line_no, ExecutionState exec_mode);
void execute_script(const char *filename, bool is_import, bool is_startup_script);
void cleanup_shell();

// Tokenizer & Operator/Keyword Management
void initialize_operators_core_structural(); // Renamed
void add_operator_definition(const char* op_str, TokenType token_type, OperatorType op_type_prop, int precedence, OperatorAssociativity assoc, const char* bsh_handler); // Changed signature
OperatorDefinition* get_operator_definition(const char* op_str); // New helper
int match_operator_text(const char *input, const char **op_text); // Simplified from match_operator_dynamic
void add_keyword_alias(const char* original, const char* alias_name);
const char* resolve_keyword_alias(const char* alias_name);
void free_keyword_alias_list();
int advanced_tokenize_line(const char *line_text, int line_num, Token *tokens, int max_tokens, char *token_storage, size_t storage_size); // Added line_num, col

// Path Management
void add_path_to_list(PathDirNode **list_head, const char* dir_path);
void free_path_dir_list(PathDirNode **list_head);
void initialize_module_path();

// Variable & Scope Management
int enter_scope();
void leave_scope(int scope_id_to_leave);
void cleanup_variables_for_scope(int scope_id);
char* get_variable_scoped(const char *name_raw);
void set_variable_scoped(const char *name_raw, const char *value_to_set, bool is_array_elem);
void expand_variables_in_string_advanced(const char *input_str, char *expanded_str, size_t expanded_str_size); // Keep as is for now
char* get_array_element_scoped(const char* array_base_name, const char* index_str_raw);
void set_array_element_scoped(const char* array_base_name, const char* index_str_raw, const char* value);

// Command Execution
bool find_command_in_path_dynamic(const char *command, char *full_path);
bool find_module_in_path(const char* module_name, char* full_path);
int execute_external_command(char *command_path, char **args, int arg_count, char *output_buffer, size_t output_buffer_size);
void execute_user_function(UserFunction* func, Token* call_arg_tokens, int call_arg_token_count, FILE* input_source_for_context);

// Expression Evaluation (New/Rewritten)
bool evaluate_expression_from_tokens(Token* tokens, int num_tokens, char* result_buffer, size_t buffer_size);
bool parse_expression_recursive(ExprParseContext* ctx, int min_precedence); // Core of precedence climbing
bool parse_operand(ExprParseContext* ctx, char* operand_result_buffer, size_t operand_buffer_size); // Parses primary, unary prefix

// BSH Handler Invocation
bool invoke_bsh_operator_handler(const char* bsh_handler_name,
                                 const char* op_symbol, // The operator itself
                                 int arg_count, // Number of string arguments for BSH
                                 const char* args[], // Array of string arguments
                                 const char* result_holder_bsh_var,
                                 char* c_result_buffer, size_t c_result_buffer_size);
// Built-in Commands & Operation Handlers
void handle_defoperator_statement(Token *tokens, int num_tokens); // Updated
void handle_defkeyword_statement(Token *tokens, int num_tokens);
void handle_assignment_advanced(Token *tokens, int num_tokens); // Will use evaluate_expression_from_tokens
void handle_echo_advanced(Token *tokens, int num_tokens);
bool evaluate_condition_advanced(Token* operand1_token, Token* operator_token, Token* operand2_token); // May be replaced by generic expr eval
void handle_if_statement_advanced(Token *tokens, int num_tokens, FILE* input_source, int current_line_no); // Will use evaluate_expression_from_tokens for condition
void handle_else_statement_advanced(Token *tokens, int num_tokens, FILE* input_source, int current_line_no);
void handle_while_statement_advanced(Token *tokens, int num_tokens, FILE* input_source, int current_line_no); // Will use evaluate_expression_from_tokens for condition
void handle_defunc_statement_advanced(Token *tokens, int num_tokens);
// void handle_inc_dec_statement_advanced(Token *tokens, int num_tokens, bool increment); // ++/-- are now generic TOKEN_OPERATOR
void handle_loadlib_statement(Token *tokens, int num_tokens);
void handle_calllib_statement(Token *tokens, int num_tokens);
void handle_import_statement(Token *tokens, int num_tokens);
void handle_update_cwd_statement(Token *tokens, int num_tokens);
// void handle_unary_op_statement(Token* var_token, Token* op_token, bool is_prefix); // Replaced by generic expression eval
void handle_exit_statement(Token *tokens, int num_tokens);
void handle_eval_statement(Token *tokens, int num_tokens);


// Block Management
void push_block_bf(BlockType type, bool condition_true, long loop_start_fpos, int loop_start_line_no);
BlockFrame* pop_block_bf();
BlockFrame* peek_block_bf();
void handle_opening_brace_token(Token token); // Needs to respect current_exec_state
void handle_closing_brace_token(Token token, FILE* input_source); // Needs to respect current_exec_state

// Utility & BSH Callers
char* trim_whitespace(char *str);
void free_all_variables();
void free_function_list();
void free_operator_list(); // Updated for new OperatorDefinition
void free_loaded_libs();
long get_file_pos(FILE* f);
char* unescape_string(const char* input, char* output_buffer, size_t buffer_size);
bool input_source_is_file(FILE* f);

// object: management
void parse_and_flatten_bsh_object_string(const char* data_string, const char* base_var_name, int current_scope_id);
bool stringify_bsh_object_to_string(const char* base_var_name, char* output_buffer, size_t buffer_size);


// --- Tokenizer & Operator/Keyword Management Implementations ---

// RENAMED from initialize_operators_dynamic
void initialize_operators_core_structural() {
    operator_list_head = NULL; // Ensure it's clear

    // Define only ABSOLUTELY structural tokens if they aren't handled by generic TOKEN_OPERATOR logic
    // and defoperator. For a truly dynamic system, even these could potentially be defined by
    // a very early, C-loaded "bootstrap.bsh" if defoperator was powerful enough from the start.
    // For now, let's assume these are fixed structure tokens and not "operators" in the sense
    // of performing calculations or logical operations that BSH scripts would define.
    // Their token types (TOKEN_LPAREN, etc.) are directly used by the C parser for syntax.

    // Example: If '(' is always TOKEN_LPAREN and not a user-definable operator symbol:
    // add_operator_definition("(", TOKEN_LPAREN, OP_TYPE_NONE, 0, ASSOC_NONE, ""); // No BSH handler for pure syntax
    // add_operator_definition(")", TOKEN_RPAREN, OP_TYPE_NONE, 0, ASSOC_NONE, "");
    // add_operator_definition("{", TOKEN_LBRACE, OP_TYPE_NONE, 0, ASSOC_NONE, "");
    // add_operator_definition("}", TOKEN_RBRACE, OP_TYPE_NONE, 0, ASSOC_NONE, "");
    // add_operator_definition("[", TOKEN_LBRACKET, OP_TYPE_NONE, 0, ASSOC_NONE, "");
    // add_operator_definition("]", TOKEN_RBRACKET, OP_TYPE_NONE, 0, ASSOC_NONE, "");
    // add_operator_definition(";", TOKEN_SEMICOLON, OP_TYPE_NONE, 0, ASSOC_NONE, "");

    // '=' could be special if C handles assignment uniquely, or a regular operator.
    // If it's special for $var = value:
    // add_operator_definition("=", TOKEN_ASSIGN, OP_TYPE_BINARY_INFIX, 2, ASSOC_RIGHT, "_bsh_assign"); // Or no handler if C manages it
    // Or it could be fully script defined. Let's assume for now TOKEN_ASSIGN is still a distinct type for process_line logic.
}


// New signature for adding richer operator definitions
void add_operator_definition(const char* op_str, TokenType token_type, OperatorType op_type_prop,
                             int precedence, OperatorAssociativity assoc, const char* bsh_handler_name_str) {
    if (strlen(op_str) > MAX_OPERATOR_LEN) {
        fprintf(stderr, "Warning: Operator '%s' too long (max %d chars).\n", op_str, MAX_OPERATOR_LEN);
        return;
    }

    // Check if operator already exists, update if so (optional, or disallow)
    OperatorDefinition *current = operator_list_head;
    while(current) {
        if (strcmp(current->op_str, op_str) == 0) {
            fprintf(stderr, "Warning: Operator '%s' already defined. Re-defining.\n", op_str);
            current->token_type = token_type;
            current->op_type_prop = op_type_prop;
            current->precedence = precedence;
            current->associativity = assoc;
            strncpy(current->bsh_handler_name, bsh_handler_name_str, MAX_VAR_NAME_LEN -1);
            current->bsh_handler_name[MAX_VAR_NAME_LEN -1] = '\0';
            return;
        }
        current = current->next;
    }

    OperatorDefinition *new_op = (OperatorDefinition*)malloc(sizeof(OperatorDefinition));
    if (!new_op) {
        perror("malloc for new operator definition failed");
        return;
    }
    strncpy(new_op->op_str, op_str, MAX_OPERATOR_LEN);
    new_op->op_str[MAX_OPERATOR_LEN] = '\0';
    new_op->token_type = token_type;
    new_op->op_type_prop = op_type_prop;
    new_op->precedence = precedence;
    new_op->associativity = assoc;
    strncpy(new_op->bsh_handler_name, bsh_handler_name_str, MAX_VAR_NAME_LEN -1);
    new_op->bsh_handler_name[MAX_VAR_NAME_LEN-1] = '\0';

    new_op->next = operator_list_head;
    operator_list_head = new_op;
}

// Helper to get an operator's full definition
OperatorDefinition* get_operator_definition(const char* op_str) {
    OperatorDefinition *current = operator_list_head;
    while (current) {
        if (strcmp(current->op_str, op_str) == 0) {
            return current;
        }
        current = current->next;
    }
    return NULL;
}

// Simplified from match_operator_dynamic. Now only matches text, returns length.
// The caller (tokenizer) will then use get_operator_definition() if needed.
int match_operator_text(const char *input, const char **op_text) {
    OperatorDefinition *current = operator_list_head;
    const char* best_match_str = NULL;
    int longest_match_len = 0;

    // Check built-in single character structural tokens first if they are not in OperatorDefinition list
    // (e.g. '(', ')', '{', '}', '[', ']', ';', '=')
    // This depends on whether they are added to operator_list_head or handled separately by tokenizer.
    // For now, assume all symbols that can be TOKEN_OPERATOR are in operator_list_head.
    // Let's assume fixed punctuation like '(', ')', etc. are handled before this,
    // and this function is for TOKEN_OPERATOR candidates.

    while (current) {
        size_t op_len = strlen(current->op_str);
        if (strncmp(input, current->op_str, op_len) == 0) {
            if (op_len > longest_match_len) {
                longest_match_len = op_len;
                best_match_str = current->op_str; // Point to the string in the definition
            }
        }
        current = current->next;
    }

    if (longest_match_len > 0) {
        if (op_text) *op_text = best_match_str;
        return longest_match_len;
    }
    return 0;
}

void free_operator_list() {
    OperatorDefinition *current = operator_list_head;
    OperatorDefinition *next_op;
    while (current) {
        next_op = current->next;
        free(current);
        current = next_op;
    }
    operator_list_head = NULL;
}

static void add_token_refactored(
    TokenType type,
    const char* text_start,
    int len,
    int line_num_for_token,     // Corrisponde a 'line_num' dall'outer scope
    int col_for_token_start,    // Corrisponde a 'current_col - len' calcolato nell'outer scope
    Token *output_tokens,       // Corrisponde a 'tokens'
    int max_tokens_limit,       // Corrisponde a 'max_tokens'
    char **current_storage_ptr, // Puntatore a 'storage_ptr' per modificarlo
    size_t *current_remaining_storage, // Puntatore a 'remaining_storage' per modificarlo
    int *current_token_count    // Puntatore a 'token_count' per modificarlo
) {
    if (*current_token_count >= max_tokens_limit - 1 || *current_remaining_storage <= (size_t)len + 1) {
        /* Ran out of space */
        return;
    }

    output_tokens[*current_token_count].type = type;
    output_tokens[*current_token_count].line = line_num_for_token;
    output_tokens[*current_token_count].col = col_for_token_start;

    strncpy(*current_storage_ptr, text_start, len);
    (*current_storage_ptr)[len] = '\0';
    output_tokens[*current_token_count].text = *current_storage_ptr;
    output_tokens[*current_token_count].len = len;

    *current_storage_ptr += (len + 1);
    *current_remaining_storage -= (len + 1);
    (*current_token_count)++;
}

const char* resolve_keyword_alias(const char* alias_name) {
    KeywordAlias *current = keyword_alias_head;
    while (current) {
        if (strcmp(current->alias, alias_name) == 0) {
            return current->original; 
        }
        current = current->next;
    }
    return alias_name; 
}

void add_keyword_alias(const char* original, const char* alias_name) {
    if (strlen(original) > MAX_KEYWORD_LEN || strlen(alias_name) > MAX_KEYWORD_LEN) {
        fprintf(stderr, "Keyword or alias too long (max %d chars).\n", MAX_KEYWORD_LEN); return;
    }
    KeywordAlias* current = keyword_alias_head;
    while(current){ 
        if(strcmp(current->alias, alias_name) == 0){
            fprintf(stderr, "Warning: Alias '%s' already defined for '%s'. Overwriting with new original '%s'.\n", alias_name, current->original, original);
            strncpy(current->original, original, MAX_KEYWORD_LEN); 
            current->original[MAX_KEYWORD_LEN] = '\0';
            return;
        }
        current = current->next;
    }
    KeywordAlias *new_alias = (KeywordAlias*)malloc(sizeof(KeywordAlias));
    if (!new_alias) { perror("malloc for keyword alias failed"); return; }
    strncpy(new_alias->original, original, MAX_KEYWORD_LEN); new_alias->original[MAX_KEYWORD_LEN] = '\0';
    strncpy(new_alias->alias, alias_name, MAX_KEYWORD_LEN); new_alias->alias[MAX_KEYWORD_LEN] = '\0';
    new_alias->next = keyword_alias_head; keyword_alias_head = new_alias; 
}

void free_keyword_alias_list() {
    KeywordAlias *current = keyword_alias_head; KeywordAlias *next_ka;
    while (current) { next_ka = current->next; free(current); current = next_ka; }
    keyword_alias_head = NULL;
}

void cleanup_shell() {
    free_all_variables();
    free_function_list();
    free_operator_list();
    free_keyword_alias_list();
    free_path_dir_list(&path_list_head);
    free_path_dir_list(&module_path_list_head);
    free_loaded_libs();

    while(scope_stack_top >= 0) { 
        leave_scope(scope_stack[scope_stack_top].scope_id);
    }
}

void initialize_module_path() {
    char *module_path_env = getenv("BSH_MODULE_PATH");
    char *effective_module_path = module_path_env;

    if (!module_path_env || strlen(module_path_env) == 0) {
        effective_module_path = DEFAULT_MODULE_PATH;
    }

    if (effective_module_path && strlen(effective_module_path) > 0) {
        char *path_copy = strdup(effective_module_path);
        if (path_copy) {
            char *token_path = strtok(path_copy, ":");
            while (token_path) {
                if(strlen(token_path) > 0) add_path_to_list(&module_path_list_head, token_path);
                token_path = strtok(NULL, ":");
            }
            free(path_copy);
        } else { perror("strdup for BSH_MODULE_PATH processing failed"); }
    }
}

// Updated tokenizer to be simpler and use new types/operator matching
int advanced_tokenize_line(const char *line_text, int line_num, Token *tokens, int max_tokens, char *token_storage, size_t storage_size) {
    int token_count = 0;
    const char *p = line_text;
    char *storage_ptr = token_storage;
    size_t remaining_storage = storage_size;
    int current_col = 1;

    // Rimuovi la definizione di 'auto void add_token' da qui

    while (*p && token_count < max_tokens -1) { // -1 to leave space for EOF
        while (isspace((unsigned char)*p)) {
            if (*p == '\n') { /* line_num++; DON'T increment line_num here, it's the input param for the current line */ current_col = 1;} else { current_col++; }
            p++;
        }
        if (!*p) break;

        const char *p_token_start = p;
        int initial_col_for_token = current_col; // Colonna di inizio del token corrente

        // 1. Comments
        if (*p == '#') {
            // ... (logica per i commenti) ...
            // add_token_refactored(TOKEN_COMMENT, comment_start, p - comment_start, line_num, initial_col_for_token, tokens, max_tokens, &storage_ptr, &remaining_storage, &token_count); // Se vuoi tokenizzare i commenti
            goto end_of_line_tokens;
        }

        // 2. Variables
        if (*p == '$') {
            const char *var_start = p;
            p++; current_col++;
            if (*p == '{') {
                p++; current_col++;
                while (*p && *p != '}') { p++; current_col++; }
                if (*p == '}') { p++; current_col++; }
            } else {
                while (isalnum((unsigned char)*p) || *p == '_') { p++; current_col++; }
            }
            add_token_refactored(TOKEN_VARIABLE, var_start, p - var_start, line_num, initial_col_for_token, tokens, max_tokens, &storage_ptr, &remaining_storage, &token_count);
            continue;
        }

        // 3. Strings
        if (*p == '"') {
            const char *str_start = p;
            p++; current_col++; // Skip opening quote
            while (*p) {
                if (*p == '\\' && *(p+1)) {
                    p += 2; current_col += 2;
                } else if (*p == '"') {
                    p++; current_col++; // Skip closing quote
                    break;
                } else {
                    p++; current_col++;
                }
            }
            add_token_refactored(TOKEN_STRING, str_start, p - str_start, line_num, initial_col_for_token, tokens, max_tokens, &storage_ptr, &remaining_storage, &token_count);
            continue;
        }

        // 4. Numbers
        if (isdigit((unsigned char)*p) || (*p == '.' && isdigit((unsigned char)*(p+1)))) {
            const char* num_start = p;
            bool has_decimal = (*p == '.');
            if (has_decimal) { p++; current_col++;}
            
            while (isdigit((unsigned char)*p)) { p++; current_col++; }
            if (!has_decimal && *p == '.') {
                p++; current_col++;
                has_decimal = true;
                while (isdigit((unsigned char)*p)) { p++; current_col++; }
            }
            add_token_refactored(TOKEN_NUMBER, num_start, p - num_start, line_num, initial_col_for_token, tokens, max_tokens, &storage_ptr, &remaining_storage, &token_count);
            continue;
        }
        
        // 5. Punctuation/Structural tokens
        TokenType fixed_punct_type = TOKEN_EMPTY;
        // 5. Punctuation/Structural tokens
        TokenType fixed_punct_type = TOKEN_EMPTY;
        switch (*p) {
            case '(':
                fixed_punct_type = TOKEN_LPAREN;
                break;
            case ')':
                fixed_punct_type = TOKEN_RPAREN;
                break;
            case '{':
                fixed_punct_type = TOKEN_LBRACE;
                break;
            case '}':
                fixed_punct_type = TOKEN_RBRACE;
                break;
            case '[':
                fixed_punct_type = TOKEN_LBRACKET;
                break;
            case ']':
                fixed_punct_type = TOKEN_RBRACKET;
                break;
            case ';':
                fixed_punct_type = TOKEN_SEMICOLON;
                break;
            case '=':
                // This is a special case. We must check if '=' is the beginning of a
                // longer, script-defined operator (like '=='). If it is, we should let
                // the next section for TOKEN_OPERATOR handle it to get the longest match.
                if (match_operator_text(p, NULL) > 1) {
                    // It's a longer operator (e.g., '=='). Let the next block handle it.
                    fixed_punct_type = TOKEN_EMPTY;
                } else {
                    // It's a standalone '=', so treat it as an assignment.
                    fixed_punct_type = TOKEN_ASSIGN;
                }
                break;
        }

        if (fixed_punct_type != TOKEN_EMPTY) {
            add_token_refactored(fixed_punct_type, p_token_start, 1, line_num, initial_col_for_token, tokens, max_tokens, &storage_ptr, &remaining_storage, &token_count);
            p++; current_col++;
            continue;
        }

        // 6. Script-Defined Operators
        const char *matched_op_text_ptr = NULL;
        int op_len = match_operator_text(p, &matched_op_text_ptr);
        if (op_len > 0) {
            add_token_refactored(TOKEN_OPERATOR, p, op_len, line_num, initial_col_for_token, tokens, max_tokens, &storage_ptr, &remaining_storage, &token_count);
            p += op_len;
            current_col += op_len;
            continue;
        }

        // 7. Words
        if (isalnum((unsigned char)*p) || *p == '_' || *p == '-') {
            const char* word_start = p;
            while (isalnum((unsigned char)*p) || *p == '_') { // NB: '-' non è incluso qui, forse un bug se le parole possono contenere '-' internamente
                p++; current_col++;
            }
            add_token_refactored(TOKEN_WORD, word_start, p - word_start, line_num, initial_col_for_token, tokens, max_tokens, &storage_ptr, &remaining_storage, &token_count);
            continue;
        }

        // 8. Unrecognized character
        fprintf(stderr, "bsh: tokenize error: Unrecognized character '%c' at line %d, col %d.\n", *p, line_num, initial_col_for_token);
        add_token_refactored(TOKEN_ERROR, p_token_start, 1, line_num, initial_col_for_token, tokens, max_tokens, &storage_ptr, &remaining_storage, &token_count);
        p++; current_col++;
    }

end_of_line_tokens:
    if (token_count < max_tokens) {
        tokens[token_count].type = TOKEN_EOF;
        tokens[token_count].text = "EOF";
        tokens[token_count].len = 3;
        tokens[token_count].line = line_num; // line_num alla fine della riga
        tokens[token_count].col = current_col; // current_col alla fine della riga
        token_count++;
    }
    return token_count;
}

// --- Built-in Command Implementations (handle_defoperator_statement updated) ---

void handle_defoperator_statement(Token *tokens, int num_tokens) {
    if (current_exec_state == STATE_BLOCK_SKIP && current_exec_state != STATE_IMPORT_PARSING) return;

    // Syntax: defoperator <op_symbol_str> TYPE <type_enum_str> [PRECEDENCE <N>] [ASSOC <L|R|N>] HANDLER <bsh_func_name>
    // Example: defoperator "+" TYPE BINARY_INFIX PRECEDENCE 10 ASSOC L HANDLER "math_add"
    if (num_tokens < 6) { // Minimum: defoperator "sym" TYPE SOME_TYPE HANDLER "hdlr"
        fprintf(stderr, "Syntax: defoperator <op_symbol> TYPE <type> [PRECEDENCE <N>] [ASSOC <L|R|N>] HANDLER <handler_func>\n");
        fprintf(stderr, "  TYPE: UNARY_PREFIX, UNARY_POSTFIX, BINARY_INFIX, TERNARY_PRIMARY, TERNARY_SECONDARY\n");
        fprintf(stderr, "  ASSOC: L (left), R (right), N (none/non-assoc)\n");
        return;
    }

    char op_symbol[MAX_OPERATOR_LEN + 1];
    char bsh_handler_name[MAX_VAR_NAME_LEN];
    OperatorType op_type_prop = OP_TYPE_NONE;
    int precedence = 0; // Default precedence
    OperatorAssociativity assoc = ASSOC_LEFT; // Default associativity for binary

    // Token 1: Operator Symbol (string)
    if (tokens[1].type != TOKEN_STRING && tokens[1].type != TOKEN_WORD) { // Allow unquoted simple ops
        fprintf(stderr, "defoperator: Operator symbol must be a string or word.\n"); return;
    }
    // Unescape if it's a BSH string literal, or use text if it's a WORD
    char temp_op_sym_buf[MAX_OPERATOR_LEN*2]; // Buffer for potential unescaping
    const char* op_sym_src_ptr = tokens[1].text;
    if (tokens[1].type == TOKEN_STRING) {
        if (tokens[1].len - 2 > MAX_OPERATOR_LEN || tokens[1].len < 2) { /* Check quotes "" */
            fprintf(stderr, "defoperator: Invalid operator symbol string length.\n"); return;
        }
        strncpy(temp_op_sym_buf, tokens[1].text + 1, tokens[1].len - 2);
        temp_op_sym_buf[tokens[1].len - 2] = '\0';
        op_sym_src_ptr = temp_op_sym_buf;
    } else { // TOKEN_WORD
         if (tokens[1].len > MAX_OPERATOR_LEN) {
            fprintf(stderr, "defoperator: Operator symbol word too long.\n"); return;
        }
        // op_sym_src_ptr is already tokens[1].text which is fine
    }
    strncpy(op_symbol, op_sym_src_ptr, MAX_OPERATOR_LEN);
    op_symbol[MAX_OPERATOR_LEN] = '\0';
    if (strlen(op_symbol) == 0) {
        fprintf(stderr, "defoperator: Operator symbol cannot be empty.\n"); return;
    }


    int current_arg_idx = 2; // Start parsing from TYPE keyword

    // TYPE <type_enum_str>
    if (current_arg_idx + 1 >= num_tokens || strcmp(tokens[current_arg_idx].text, "TYPE") != 0) {
        fprintf(stderr, "defoperator: Missing 'TYPE' keyword or value.\n"); return;
    }
    current_arg_idx++; // Move to type_enum_str
    const char* type_str = tokens[current_arg_idx].text;
    if (strcmp(type_str, "UNARY_PREFIX") == 0) op_type_prop = OP_TYPE_UNARY_PREFIX;
    else if (strcmp(type_str, "UNARY_POSTFIX") == 0) op_type_prop = OP_TYPE_UNARY_POSTFIX;
    else if (strcmp(type_str, "BINARY_INFIX") == 0) op_type_prop = OP_TYPE_BINARY_INFIX;
    else if (strcmp(type_str, "TERNARY_PRIMARY") == 0) op_type_prop = OP_TYPE_TERNARY_PRIMARY;
    else if (strcmp(type_str, "TERNARY_SECONDARY") == 0) op_type_prop = OP_TYPE_TERNARY_SECONDARY;
    else { fprintf(stderr, "defoperator: Unknown operator TYPE '%s'.\n", type_str); return; }
    current_arg_idx++;

    // Optional: PRECEDENCE <N>
    if (current_arg_idx < num_tokens && strcmp(tokens[current_arg_idx].text, "PRECEDENCE") == 0) {
        current_arg_idx++;
        if (current_arg_idx >= num_tokens || tokens[current_arg_idx].type != TOKEN_NUMBER) {
            fprintf(stderr, "defoperator: PRECEDENCE requires a number.\n"); return;
        }
        precedence = atoi(tokens[current_arg_idx].text);
        current_arg_idx++;
    }

    // Optional: ASSOC <L|R|N>
    if (current_arg_idx < num_tokens && strcmp(tokens[current_arg_idx].text, "ASSOC") == 0) {
        current_arg_idx++;
        if (current_arg_idx >= num_tokens || tokens[current_arg_idx].type != TOKEN_WORD) {
            fprintf(stderr, "defoperator: ASSOC requires L, R, or N.\n"); return;
        }
        const char* assoc_str = tokens[current_arg_idx].text;
        if (strcmp(assoc_str, "L") == 0) assoc = ASSOC_LEFT;
        else if (strcmp(assoc_str, "R") == 0) assoc = ASSOC_RIGHT;
        else if (strcmp(assoc_str, "N") == 0) assoc = ASSOC_NONE;
        else { fprintf(stderr, "defoperator: Unknown ASSOC type '%s'.\n", assoc_str); return; }
        current_arg_idx++;
    }

    // HANDLER <bsh_func_name>
    if (current_arg_idx + 1 >= num_tokens || strcmp(tokens[current_arg_idx].text, "HANDLER") != 0) {
        fprintf(stderr, "defoperator: Missing 'HANDLER' keyword or value for operator '%s'.\n", op_symbol); return;
    }
    current_arg_idx++; // Move to bsh_func_name
    if (tokens[current_arg_idx].type != TOKEN_WORD && tokens[current_arg_idx].type != TOKEN_STRING) {
        fprintf(stderr, "defoperator: Handler name must be a word or string for operator '%s'.\n", op_symbol); return;
    }
    // Similar unescaping/copying for handler name if it can be a string
    const char* handler_name_src = tokens[current_arg_idx].text;
    if(tokens[current_arg_idx].type == TOKEN_STRING) {
        // unescape logic similar to op_symbol
        // For simplicity, assume handler name is TOKEN_WORD or simple TOKEN_STRING for now
        if (tokens[current_arg_idx].len - 2 < MAX_VAR_NAME_LEN && tokens[current_arg_idx].len >=2){
            strncpy(bsh_handler_name, tokens[current_arg_idx].text + 1, tokens[current_arg_idx].len - 2);
            bsh_handler_name[tokens[current_arg_idx].len - 2] = '\0';
        } else {
             fprintf(stderr, "defoperator: Invalid handler name string for operator '%s'.\n", op_symbol); return;
        }
    } else {
        strncpy(bsh_handler_name, handler_name_src, MAX_VAR_NAME_LEN - 1);
        bsh_handler_name[MAX_VAR_NAME_LEN - 1] = '\0';
    }
    
    if (strlen(bsh_handler_name) == 0) {
         fprintf(stderr, "defoperator: BSH handler name cannot be empty for operator '%s'.\n", op_symbol); return;
    }

    // Add the operator definition
    add_operator_definition(op_symbol, TOKEN_OPERATOR, op_type_prop, precedence, assoc, bsh_handler_name);
    // printf("DEBUG: Defined operator '%s' TYPE %d PREC %d ASSOC %d HANDLER '%s'\n",
    //        op_symbol, op_type_prop, precedence, assoc, bsh_handler_name);
}


// --- BSH Handler Invocation ---
bool invoke_bsh_operator_handler(const char* bsh_handler_name_param,
                                 const char* op_symbol_param, // The operator itself, for context if handler handles multiple
                                 int arg_count_for_bsh,      // Number of string arguments for BSH
                                 const char* bsh_args_str_array[], // Array of string arguments
                                 const char* result_holder_bsh_var_name,
                                 char* c_result_buffer, size_t c_result_buffer_size) {

    char bsh_handler_name[MAX_VAR_NAME_LEN];
    strncpy(bsh_handler_name, bsh_handler_name_param, MAX_VAR_NAME_LEN -1);
    bsh_handler_name[MAX_VAR_NAME_LEN -1] = '\0';
    
    char op_symbol[MAX_OPERATOR_LEN +1];
    strncpy(op_symbol, op_symbol_param ? op_symbol_param : "", MAX_OPERATOR_LEN);
    op_symbol[MAX_OPERATOR_LEN] = '\0';


    UserFunction* func = function_list;
    while (func) {
        if (strcmp(func->name, bsh_handler_name) == 0) break;
        func = func->next;
    }
    if (!func) {
        fprintf(stderr, "Error: BSH operator handler function '%s' not found.\n", bsh_handler_name);
        snprintf(c_result_buffer, c_result_buffer_size, "BSH_HANDLER_NOT_FOUND<%s>", bsh_handler_name);
        return false;
    }

    // The BSH handler function's parameters should match what C passes.
    // Typically: (op_symbol_str, operand1_str, operand2_str, ..., result_holder_name_str)
    // Total args passed to BSH = actual operands + op_symbol + result_holder_name
    int expected_bsh_params = arg_count_for_bsh + 2; // +2 for op_symbol and result_holder_var_name
    if (func->param_count != expected_bsh_params) {
        fprintf(stderr, "Error: BSH handler '%s' param count mismatch. Expected %d (op_sym, %d args, res_holder), got %d.\n",
                bsh_handler_name, expected_bsh_params, arg_count_for_bsh, func->param_count);
        snprintf(c_result_buffer, c_result_buffer_size, "BSH_HANDLER_PARAM_MISMATCH<%s>", bsh_handler_name);
        return false;
    }

    Token call_tokens_to_bsh[MAX_ARGS]; // Max args for a user function
    if (expected_bsh_params > MAX_ARGS) {
         fprintf(stderr, "Error: Too many arguments for BSH handler call internal limit.\n");
         snprintf(c_result_buffer, c_result_buffer_size, "BSH_HANDLER_ARG_LIMIT_EXCEEDED");
         return false;
    }

    // We need storage for the token text for these dynamic arguments.
    // Let's create a temporary buffer. This is a simplification.
    // A more robust solution would manage this memory more carefully or use a list of allocated strings.
    char arg_storage_for_bsh_call[MAX_ARGS][INPUT_BUFFER_SIZE]; // Max length for each arg string

    int current_bsh_token_idx = 0;

    // 1. Operator Symbol
    strncpy(arg_storage_for_bsh_call[current_bsh_token_idx], op_symbol, INPUT_BUFFER_SIZE -1);
    call_tokens_to_bsh[current_bsh_token_idx].type = TOKEN_STRING;
    call_tokens_to_bsh[current_bsh_token_idx].text = arg_storage_for_bsh_call[current_bsh_token_idx];
    call_tokens_to_bsh[current_bsh_token_idx].len = strlen(op_symbol);
    current_bsh_token_idx++;

    // 2. Actual arguments from C expression evaluation
    for (int i = 0; i < arg_count_for_bsh; ++i) {
        strncpy(arg_storage_for_bsh_call[current_bsh_token_idx], bsh_args_str_array[i], INPUT_BUFFER_SIZE -1);
        call_tokens_to_bsh[current_bsh_token_idx].type = TOKEN_STRING; // Pass evaluated C strings as BSH strings
        call_tokens_to_bsh[current_bsh_token_idx].text = arg_storage_for_bsh_call[current_bsh_token_idx];
        call_tokens_to_bsh[current_bsh_token_idx].len = strlen(bsh_args_str_array[i]);
        current_bsh_token_idx++;
    }
    
    // 3. Result Holder Variable Name
    strncpy(arg_storage_for_bsh_call[current_bsh_token_idx], result_holder_bsh_var_name, INPUT_BUFFER_SIZE -1);
    call_tokens_to_bsh[current_bsh_token_idx].type = TOKEN_WORD; // Pass as variable name
    call_tokens_to_bsh[current_bsh_token_idx].text = arg_storage_for_bsh_call[current_bsh_token_idx];
    call_tokens_to_bsh[current_bsh_token_idx].len = strlen(result_holder_bsh_var_name);
    current_bsh_token_idx++;


    execute_user_function(func, call_tokens_to_bsh, current_bsh_token_idx, NULL); // NULL for file context

    char* result_from_bsh = get_variable_scoped(result_holder_bsh_var_name);
    if (result_from_bsh) {
        strncpy(c_result_buffer, result_from_bsh, c_result_buffer_size - 1);
        c_result_buffer[c_result_buffer_size - 1] = '\0';
    } else {
        snprintf(c_result_buffer, c_result_buffer_size, "BSH_HANDLER_NO_RESULT<%s>", result_holder_bsh_var_name);
        // This might be an error or might be acceptable if the operation has side effects only
        // and doesn't produce a distinct "expression value".
    }
    return true;
}


// --- Expression Evaluation (New/Rewritten using Precedence Climbing) ---

// Helper function for parse_operand
static bool extract_clean_variable_name_for_expr(const char* token_text, char* out_name, size_t out_name_size) {
    if (token_text == NULL || out_name == NULL || out_name_size == 0) return false;

    const char* p = token_text;
    if (*p != '$') return false; // Deve iniziare con $
    p++;

    char temp_name[MAX_VAR_NAME_LEN];
    char* t = temp_name;

    if (*p == '{') {
        p++;
        while (*p && *p != '}' && (size_t)(t - temp_name) < MAX_VAR_NAME_LEN - 1) {
            *t++ = *p++;
        }
        if (*p != '}') return false; // Parentesi graffa non chiusa
        // p++; // Non serve consumare '}' qui, solo per estrazione nome
    } else {
        while (*p && (isalnum((unsigned char)*p) || *p == '_') && (size_t)(t - temp_name) < MAX_VAR_NAME_LEN - 1) {
            *t++ = *p++;
        }
    }
    *t = '\0';

    if (strlen(temp_name) == 0) return false; // Nome vuoto

    // Verifica se c'è un accesso array, che non supportiamo per la modifica diretta con ++/-- qui
    // (gli handler BSH dovrebbero gestire $arr[$idx] se necessario tramite altre forme)
    if (strchr(temp_name, '[') || strchr(temp_name, '.')) { // Non supporta $arr[idx]++ o $obj.prop++ direttamente qui
        // fprintf(stderr, "Expression parser: '++/--' on array elements or properties not directly supported in this C-parser stage.\n");
        return false; // Indica che non è un nome di variabile semplice "pulibile" per ++/--
    }

    strncpy(out_name, temp_name, out_name_size -1);
    out_name[out_name_size-1] = '\0';
    return true;
}

// Parses a primary: number, variable, string, or parenthesized expression
// Also handles UNARY_PREFIX operators here as they have high precedence.
bool parse_operand(ExprParseContext* ctx, char* operand_result_buffer, size_t operand_buffer_size) {
    if (ctx->current_token_idx >= ctx->num_tokens) {
        fprintf(stderr, "Expression parser: Unexpected EOF while parsing operand.\n");
        strncpy(operand_result_buffer, "EXPR_PARSE_ERROR_EOF_OPERAND", operand_buffer_size-1);
        return false;
    }
    if (ctx->recursion_depth >= MAX_EXPR_RECURSION_DEPTH) {
        fprintf(stderr, "Expression parser: Max recursion depth reached.\n");
        strncpy(operand_result_buffer, "EXPR_PARSE_ERROR_RECURSION", operand_buffer_size-1);
        return false;
    }
    ctx->recursion_depth++;

    Token current_token = ctx->tokens[ctx->current_token_idx];
    operand_result_buffer[0] = '\0';

    if (current_token.type == TOKEN_NUMBER || current_token.type == TOKEN_VARIABLE || current_token.type == TOKEN_WORD) {
        expand_variables_in_string_advanced(current_token.text, operand_result_buffer, operand_buffer_size);
        ctx->current_token_idx++;
    } else if (current_token.type == TOKEN_STRING) {
        char unescaped[INPUT_BUFFER_SIZE];
        unescape_string(current_token.text, unescaped, sizeof(unescaped));
        expand_variables_in_string_advanced(unescaped, operand_result_buffer, operand_buffer_size);
        ctx->current_token_idx++;
    } else if (current_token.type == TOKEN_LPAREN) {
        ctx->current_token_idx++; // Consume '('
        if (!parse_expression_recursive(ctx, 0)) { // Parse sub-expression with lowest precedence
             // Error already printed by recursive call
             strncpy(operand_result_buffer, "EXPR_PARSE_ERROR_SUB_EXPR", operand_buffer_size-1);
             ctx->recursion_depth--; return false;
        }
        // Result of sub-expression is now in ctx->result_buffer (the main one)
        strncpy(operand_result_buffer, ctx->result_buffer, operand_buffer_size -1);
        
        if (ctx->current_token_idx >= ctx->num_tokens || ctx->tokens[ctx->current_token_idx].type != TOKEN_RPAREN) {
            fprintf(stderr, "Expression parser: Missing ')' at line %d col %d.\n", current_token.line, current_token.col);
            strncpy(operand_result_buffer, "EXPR_PARSE_ERROR_MISSING_RPAREN", operand_buffer_size-1);
            ctx->recursion_depth--; return false;
        }
        ctx->current_token_idx++; // Consume ')'
    } else if (current_token.type == TOKEN_OPERATOR) {
        OperatorDefinition* op_def = get_operator_definition(current_token.text);
        if (op_def && op_def->op_type_prop == OP_TYPE_UNARY_PREFIX) {
            // Check if the operator string in op_def is "++" or "--".
            //todo: dynamic operator
            if (strcmp(op_def->op_str, "++") == 0 || strcmp(op_def->op_str, "--") == 0) {
                // If it is "++" or "--":

                ctx->current_token_idx++; // Increment the current token index. Comment: "Consume the ++ or -- operator"
                Token operand_var_token = ctx->tokens[ctx->current_token_idx]; // Get the token that should be the operand.

                // Check if the operand token is of type TOKEN_VARIABLE.
                if (operand_var_token.type == TOKEN_VARIABLE) {
                    char var_name_clean[MAX_VAR_NAME_LEN]; // Declare a character array to store the cleaned variable name.

                    // Try to extract a clean variable name from the token's text.
                    if(extract_clean_variable_name_for_expr(operand_var_token.text, var_name_clean, sizeof(var_name_clean))) {
                        // If extraction is successful:

                        ctx->current_token_idx++; // Increment the current token index. Comment: "Consume the variable token"
                        const char* bsh_args[] = {var_name_clean}; // Create an array of C strings for arguments to a shell handler, containing the cleaned variable name. Comment: "Pass the NAME of the variable"
                        char temp_bsh_result_var[MAX_VAR_NAME_LEN]; // Declare a character array for a temporary shell result variable name.

                        // Create a temporary variable name string (e.g., "__bsh_expr_temp_<random_number>_pf").
                        snprintf(temp_bsh_result_var, sizeof(temp_bsh_result_var), "__bsh_expr_temp_%d_pf", rand());

                        // Invoke a shell operator handler.
                        if (!invoke_bsh_operator_handler(op_def->bsh_handler_name, op_def->op_str, 1, bsh_args, temp_bsh_result_var, operand_result_buffer, operand_buffer_size)) {
                            // If the handler returns an error (false). Comment: "Error handled by invoke_bsh_operator_handler or the result buffer contains the error"
                            // The BSH handler (e.g., bsh_op_prefix_increment) has modified var_name_clean
                            // and has put the value of the expression (e.g., incremented value) in temp_bsh_result_var,
                            // which invoke_bsh_operator_handler has copied into operand_result_buffer.
                        }
                        // The BSH (Bourne Shell, likely) handler (e.g., bsh_op_prefix_increment) has modified var_name_clean
                        // and has put the value of the expression (e.g., the incremented value) into temp_bsh_result_var,
                        // which invoke_bsh_operator_handler has then copied into operand_result_buffer.
                    } else {
                        // If extracting the clean variable name fails:

                        // Print an error message to standard error.
                        fprintf(stderr, "Expression parser: Prefix '++' or '--' requires a simple variable operand (e.g., $var), got '%s'.\n", operand_var_token.text);
                        // Copy an error string to the operand result buffer.
                        strncpy(operand_result_buffer, "EXPR_PARSE_ERROR_PREFIX_NON_VAR", operand_buffer_size-1);
                        ctx->recursion_depth--; // Decrement the recursion depth.
                        return false; // Return false, indicating an error.
                    }
                } else {
                    // If the operand token is not of type TOKEN_VARIABLE:

                    // Print an error message to standard error.
                    fprintf(stderr, "Expression parser: Prefix '++' or '--' requires a variable operand, got token type %d.\n", operand_var_token.type);
                    // Copy an error string to the operand result buffer.
                    strncpy(operand_result_buffer, "EXPR_PARSE_ERROR_PREFIX_OPERAND_TYPE", operand_buffer_size-1);
                    ctx->recursion_depth--; // Decrement the recursion depth.
                    return false; // Return false, indicating an error.
                }
            } else {
                // If the operator is not "++" or "--" (handles other unary prefix operators):
                // Comment: "Other unary prefix operators (e.g., negation '-')"
                // Comment: "--- END OF MODIFICATION for prefix ++/-- ---"

                ctx->current_token_idx++; // Increment the current token index. Comment: "Consume prefix operator (original)"
                char rhs_operand_value[INPUT_BUFFER_SIZE]; // Declare a character array to store the right-hand side operand's value.

                // Recursively parse the expression for the operand of this prefix operator.
                if(!parse_expression_recursive(ctx, op_def->precedence)) { // Comment: "Parse operand for prefix op"
                    // If parsing the operand fails:

                    // Copy an error string to the operand result buffer.
                    strncpy(operand_result_buffer, "EXPR_PARSE_ERROR_PREFIX_OPERAND", operand_buffer_size-1);
                    ctx->recursion_depth--; // Decrement the recursion depth.
                    return false; // Return false, indicating an error.
                }
                // Copy the result from the recursive parse (presumably in ctx->result_buffer) to rhs_operand_value.
                strncpy(rhs_operand_value, ctx->result_buffer, sizeof(rhs_operand_value)-1);
                const char* bsh_args[] = {rhs_operand_value}; // Create an array of C strings for arguments to a shell handler, containing the operand's value.
                char temp_bsh_result_var[MAX_VAR_NAME_LEN]; // Declare a character array for a temporary shell result variable name.

                // Create a temporary variable name string (e.g., "__bsh_expr_temp_<random_number>").
                snprintf(temp_bsh_result_var, sizeof(temp_bsh_result_var), "__bsh_expr_temp_%d", rand());

                // Invoke a shell operator handler.
                if (!invoke_bsh_operator_handler(op_def->bsh_handler_name, op_def->op_str, 1, bsh_args, temp_bsh_result_var, operand_result_buffer, operand_buffer_size)) {
                    // If the handler returns an error (false). Comment: "Error handling (original)"
                }
                // Comment: "--- START OF RE-ENTRY for other unary prefixes ---"
            } // End of the if statement for "++"/"--" vs other unary prefix operators.
        } else {
            fprintf(stderr, "Expression parser: Unexpected token '%s' (type %d) when expecting operand or prefix op at line %d col %d.\n",
                    current_token.text, current_token.type, current_token.line, current_token.col);
            strncpy(operand_result_buffer, "EXPR_PARSE_ERROR_UNEXPECTED_TOKEN_OPERAND", operand_buffer_size-1);
            ctx->recursion_depth--; return false;
        }
    } else {
        fprintf(stderr, "Expression parser: Unexpected token '%s' (type %d) when expecting operand at line %d col %d.\n",
                current_token.text, current_token.type, current_token.line, current_token.col);
        strncpy(operand_result_buffer, "EXPR_PARSE_ERROR_UNEXPECTED_TOKEN_PRIMARY", operand_buffer_size-1);
        ctx->recursion_depth--; return false;
    }
    ctx->recursion_depth--;
    return true;
}


// Precedence climbing main recursive function
// result is placed in ctx->result_buffer
bool parse_expression_recursive(ExprParseContext* ctx, int min_precedence) {
    if (ctx->recursion_depth >= MAX_EXPR_RECURSION_DEPTH) {
        fprintf(stderr, "Expression parser: Max recursion depth reached in main loop.\n");
        strncpy(ctx->result_buffer, "EXPR_PARSE_ERROR_RECURSION_MAIN", ctx->result_buffer_size-1);
        return false;
    }
    ctx->recursion_depth++;

    char lhs_value[INPUT_BUFFER_SIZE]; // Buffer for the left-hand side of an operation
    if (!parse_operand(ctx, lhs_value, sizeof(lhs_value))) {
        // Error, result_buffer likely already contains detailed error from parse_operand
        // strncpy(ctx->result_buffer, lhs_value, ctx->result_buffer_size-1); // Propagate error if needed
        ctx->recursion_depth--; return false;
    }
    // After parse_operand, lhs_value holds the result of the first operand/prefix op/sub-expression.
    // Copy it to the main result buffer as it might be the final result if no more ops.
    strncpy(ctx->result_buffer, lhs_value, ctx->result_buffer_size -1);
    ctx->result_buffer[ctx->result_buffer_size-1] = '\0';


    while (ctx->current_token_idx < ctx->num_tokens) {
        Token lookahead_op_token = ctx->tokens[ctx->current_token_idx];
        OperatorDefinition* op_def = NULL;

        if (lookahead_op_token.type == TOKEN_OPERATOR) {
            op_def = get_operator_definition(lookahead_op_token.text);
        } else if (lookahead_op_token.type == TOKEN_RPAREN || lookahead_op_token.type == TOKEN_EOF || 
                   lookahead_op_token.type == TOKEN_SEMICOLON /*or other expression terminators*/) {
            break; // End of current expression part
        } else { // Not an operator we can handle here, or unexpected token
            fprintf(stderr, "Expression parser: Unexpected token '%s' (type %d) after operand at line %d col %d.\n",
                lookahead_op_token.text, lookahead_op_token.type, lookahead_op_token.line, lookahead_op_token.col);
            strncpy(ctx->result_buffer, "EXPR_PARSE_ERROR_UNEXPECTED_TOKEN_AFTER_OPD", ctx->result_buffer_size-1);
            ctx->recursion_depth--; return false;
        }

        if (!op_def || op_def->precedence < min_precedence) {
            break; // Operator has lower precedence than current minimum, or not an infix/postfix operator we handle in this loop
        }
        
        // --- Handle Infix Binary and Postfix Unary Operators ---
        if (op_def->op_type_prop == OP_TYPE_BINARY_INFIX) {
            if (op_def->associativity == ASSOC_LEFT && op_def->precedence <= min_precedence) break; // precedence climbing part for left assoc.
            // For right associative, it's op_def->precedence < min_precedence, but let the general check handle it.

            ctx->current_token_idx++; // Consume binary operator
            
            char rhs_value[INPUT_BUFFER_SIZE];
            int next_min_precedence = (op_def->associativity == ASSOC_LEFT) ? (op_def->precedence + 1) : op_def->precedence;
            
            // Recursively parse the right-hand side
            if (!parse_expression_recursive(ctx, next_min_precedence)) {
                 // Error already printed by recursive call, result in ctx->result_buffer
                 ctx->recursion_depth--; return false;
            }
            // Result of RHS is in ctx->result_buffer
            strncpy(rhs_value, ctx->result_buffer, sizeof(rhs_value)-1);

            // Now have LHS (in lhs_value), operator (op_def), RHS (in rhs_value)
            // Invoke BSH handler
            const char* bsh_args[] = {lhs_value, rhs_value};
            char temp_bsh_result_var[MAX_VAR_NAME_LEN];
            snprintf(temp_bsh_result_var, sizeof(temp_bsh_result_var), "__bsh_expr_temp_%d", rand());

            if (!invoke_bsh_operator_handler(op_def->bsh_handler_name, op_def->op_str, 2, bsh_args,
                                             temp_bsh_result_var, lhs_value, sizeof(lhs_value))) { // Result stored back in lhs_value for next iteration
                // Error from BSH handler; lhs_value now contains the error string.
            }
            strncpy(ctx->result_buffer, lhs_value, ctx->result_buffer_size-1); // Update main result with new LHS

        } else if (op_def->op_type_prop == OP_TYPE_UNARY_POSTFIX) {
            // This block handles unary postfix operators.

            // Check if the operator string is "++" or "--".
            if (strcmp(op_def->op_str, "++") == 0 || strcmp(op_def->op_str, "--") == 0) {
                // For postfix operators, the "operand" is what was just parsed into lhs_value.
                // However, if lhs_value is the RESULT of an expression (e.g., (a+b)++), it's not a modifiable variable.
                // We need to know if the *original* token that produced lhs_value was a variable.
                // This is difficult to track here without more extensive refactoring.
                // The simplest approach is for $var++ to be handled like this:
                // 1. $var is parsed by parse_operand() and its value ends up in lhs_value.
                // 2. The parser sees '++' (postfix).
                // To modify the original variable, we would need its NAME.
                // The semantics of (expr)++ are usually an error or undefined. Only var++.
                // This is a limitation of a simple parser.
                // For $var++, we could try to see if `lhs_value` is *identical* to the text of a previous variable token.
                // But that's fragile. A more robust approach:
                // The postfix operator in C (as in many compiled languages)
                // requires the LHS (Left Hand Side) to be an l-value (a modifiable memory location). Our current parser doesn't track "l-valueness".
                // PRAGMATIC (but limited) SOLUTION:
                // If `lhs_value` was produced by a single `TOKEN_VARIABLE`
                // (i.e., it's not the result of a complex expression),
                // then we could attempt to extract the name.
                // But `lhs_value` is already the *expanded value*.
                // For now, let's make an assumption: if the BSH (Bourne Shell) handler for 'var++' (e.g., bsh_op_postfix_increment)
                // receives the NAME of 'var' as its first argument, and the C parser can provide it.
                // If `lhs_value` (the value) is passed, the BSH handler cannot modify the original variable.
                // Compromise: postfix ++/-- operators in this parser might only work
                // if the BSH handler is VERY intelligent and perhaps uses a special convention.
                // OR, we need to redesign how `lhs_value` is obtained if the next operator is `++`/`--`.

                // ATTEMPT AT A FIX (requires that the LHS of the postfix operator is a simple variable):
                // We need to go back to the token that produced `lhs_value`.
                // The current index `ctx->current_token_idx` points to the postfix operator.
                // The token *before* the postfix operator was the operand.
                if (ctx->current_token_idx > 0) { // Check if there's a token before the current one.
                    // Get the token immediately preceding the postfix operator.
                    Token potential_var_token = ctx->tokens[ctx->current_token_idx - 1]; // Comment: "The token before the postfix op"

                    // Check if this preceding token was a variable.
                    if (potential_var_token.type == TOKEN_VARIABLE) {
                        char var_name_clean[MAX_VAR_NAME_LEN]; // Buffer for the cleaned variable name.

                        // Try to extract a clean variable name from the text of the potential variable token.
                        if(extract_clean_variable_name_for_expr(potential_var_token.text, var_name_clean, sizeof(var_name_clean))) {
                            // If extraction is successful:
                            // Now we have the variable name: var_name_clean
                            // The current value of the variable (before the postfix operation) is in lhs_value.

                            ctx->current_token_idx++; // Consume the postfix ++ or -- operator.

                            // Prepare arguments for the BSH handler, passing the NAME of the variable.
                            const char* bsh_args[] = {var_name_clean}; // Comment: "Pass the NAME"
                            char temp_bsh_result_var[MAX_VAR_NAME_LEN]; // Temporary variable name for BSH result.

                            // Create a unique temporary variable name for the BSH script (e.g., __bsh_expr_temp_12345_pof).
                            snprintf(temp_bsh_result_var, sizeof(temp_bsh_result_var), "__bsh_expr_temp_%d_pof", rand());

                            // The BSH handler for postfix (e.g., bsh_op_postfix_increment)
                            // should:
                            // 1. Modify the variable 'var_name_clean'.
                            // 2. Set 'temp_bsh_result_var' to the *original* value of 'var_name_clean' (which is currently in lhs_value).
                            // To do this, invoke_bsh_operator_handler might need an extra argument for the original value,
                            // or the BSH handler would need to fetch the original value before modifying it.
                            // The current `bsh_op_postfix_increment` in `core_operators.bsh` does this:
                            // original_value = $($target_var_name_str)  // Get original value
                            // ... modify $($target_var_name_str) ...     // Modify the variable
                            // $($result_holder_var_name) = "$original_value" // Set result to original value

                            // Here we pass the variable name. The value in `lhs_value` will be used as
                            // the value of the expression (the value before the increment/decrement).
                            char result_of_op_application[INPUT_BUFFER_SIZE]; // Buffer for the result from the BSH handler
                                                                            // (which will actually be the original value for postfix).

                            // Invoke the BSH operator handler.
                            if (!invoke_bsh_operator_handler(op_def->bsh_handler_name, op_def->op_str, 1, bsh_args, temp_bsh_result_var, result_of_op_application, sizeof(result_of_op_application))) {
                                // If there was an error:
                                // Copy the error message (which should be in result_of_op_application) to the main result buffer.
                                strncpy(ctx->result_buffer, result_of_op_application, ctx->result_buffer_size-1); // Propagate error
                            } else {
                                // If successful:
                                // The result of the expression var++ is the value *before* the increment.
                                // The BSH handler `bsh_op_postfix_increment` is already set up to put this into `result_holder_var_name`.
                                // So `result_of_op_application` contains the original value.

                                // Copy the original value (result of the postfix expression) to the main context result buffer.
                                strncpy(ctx->result_buffer, result_of_op_application, ctx->result_buffer_size-1);

                                // `lhs_value` is overwritten for the next iteration of the parsing loop, if there is one.
                                // For postfix, the value of the entire sub-expression (var++) is the original value.
                                // So, update lhs_value to reflect the result of this postfix operation.
                                strncpy(lhs_value, result_of_op_application, sizeof(lhs_value)-1);
                            }
                        } else {
                            // If the token before '++' or '--' was a variable, but not a simple one (e.g., $var):
                            fprintf(stderr, "Expression parser: Postfix '++' or '--' requires a simple variable operand.\n");
                            strncpy(ctx->result_buffer, "EXPR_PARSE_ERROR_POSTFIX_LHS", ctx->result_buffer_size-1);
                            ctx->recursion_depth--; // Decrement recursion depth as we are exiting this parsing path.
                            return false; // Indicate failure.
                        }
                    } else {
                        // If the token before '++' or '--' was not a variable token:
                        fprintf(stderr, "Expression parser: Postfix '++' or '--' must follow a variable.\n");
                        strncpy(ctx->result_buffer, "EXPR_PARSE_ERROR_POSTFIX_OPERAND", ctx->result_buffer_size-1);
                        ctx->recursion_depth--;
                        return false;
                    }
                } else {
                    // If '++' or '--' is at the beginning of the expression, so there's no preceding token to be its operand:
                    fprintf(stderr, "Expression parser: Invalid use of postfix '++' or '--'.\n");
                    strncpy(ctx->result_buffer, "EXPR_PARSE_ERROR_POSTFIX_START", ctx->result_buffer_size-1);
                    ctx->recursion_depth--;
                    return false;
                }
            } else {
                // If it's a unary postfix operator but NOT "++" or "--" (if any such operators exist):
                ctx->current_token_idx++; // Consume the postfix operator.

                // Prepare arguments for BSH handler, passing the current VALUE of the left-hand side.
                const char* bsh_args[] = {lhs_value}; // Comment: "Pass the VALUE of LHS"
                char temp_bsh_result_var[MAX_VAR_NAME_LEN]; // Temporary variable name for BSH result.

                // Create a unique temporary variable name for the BSH script.
                snprintf(temp_bsh_result_var, sizeof(temp_bsh_result_var), "__bsh_expr_temp_%d_otherpof", rand());

                // Invoke the BSH operator handler. The result of the operation will be placed back into lhs_value.
                if(!invoke_bsh_operator_handler(op_def->bsh_handler_name, op_def->op_str, 1, bsh_args, temp_bsh_result_var, lhs_value, sizeof(lhs_value))) {
                    // If there was an error (the error message would likely be in lhs_value or handled by the function).
                }
                // Copy the result (which is in lhs_value) to the main context result buffer.
                strncpy(ctx->result_buffer, lhs_value, ctx->result_buffer_size-1);
            }

        } else if (op_def->op_type_prop == OP_TYPE_TERNARY_PRIMARY && strcmp(op_def->op_str, "?") == 0) {
            // Special handling for ternary "A ? B : C"
            // LHS is the condition (A), already in lhs_value.
            ctx->current_token_idx++; // Consume '?'

            char true_branch_value[INPUT_BUFFER_SIZE];
            // Parse the "true" expression (B). Ternary often has low, specific precedence.
            // The precedence for parsing B and C should ensure they are fully parsed before ':' is handled.
            // Typically, the precedence passed for B would be 0 or a very low value to gather the whole expression.
            if (!parse_expression_recursive(ctx, 0 /* op_def->precedence - 1 or specific ternary prec */)) { // Parse B
                ctx->recursion_depth--; return false;
            }
            strncpy(true_branch_value, ctx->result_buffer, sizeof(true_branch_value)-1);

            if (ctx->current_token_idx >= ctx->num_tokens || 
                ctx->tokens[ctx->current_token_idx].type != TOKEN_OPERATOR ||
                strcmp(ctx->tokens[ctx->current_token_idx].text, ":") != 0) {
                fprintf(stderr, "Expression parser: Missing ':' in ternary operator at line %d col %d.\n",
                        lookahead_op_token.line, lookahead_op_token.col); // '?' token's location
                strncpy(ctx->result_buffer, "EXPR_PARSE_ERROR_MISSING_COLON", ctx->result_buffer_size-1);
                ctx->recursion_depth--; return false;
            }
            ctx->current_token_idx++; // Consume ':'

            char false_branch_value[INPUT_BUFFER_SIZE];
            if (!parse_expression_recursive(ctx, 0 /* op_def->precedence -1 or specific ternary prec */)) { // Parse C
                ctx->recursion_depth--; return false;
            }
            strncpy(false_branch_value, ctx->result_buffer, sizeof(false_branch_value)-1);

            // Now have Cond (lhs_value), TrueExpr (true_branch_value), FalseExpr (false_branch_value)
            // Invoke BSH handler for ternary. It expects 3 operands.
            const char* bsh_args[] = {lhs_value, true_branch_value, false_branch_value};
            char temp_bsh_result_var[MAX_VAR_NAME_LEN];
            snprintf(temp_bsh_result_var, sizeof(temp_bsh_result_var), "__bsh_expr_temp_%d", rand());

            // The BSH handler name for '?' (op_def->bsh_handler_name) should be designed for this.
            if (!invoke_bsh_operator_handler(op_def->bsh_handler_name, op_def->op_str, 3, bsh_args,
                                             temp_bsh_result_var, lhs_value, sizeof(lhs_value))) {
                // Error
            }
            strncpy(ctx->result_buffer, lhs_value, ctx->result_buffer_size-1);
        } else {
            // Not an infix binary or postfix unary we are expecting in this loop.
            // Could be an error or an operator type not handled by this simplified precedence climber.
            // Or it could just be an operator with precedence lower than min_precedence.
            // The loop condition (op_def->precedence < min_precedence) should handle breaking.
            // If we are here, it means it's an operator, but not one of the types this loop processes.
            fprintf(stderr, "Expression parser: Operator '%s' type %d not handled in main expression loop at line %d col %d.\n",
                op_def->op_str, op_def->op_type_prop, lookahead_op_token.line, lookahead_op_token.col);
             strncpy(ctx->result_buffer, "EXPR_PARSE_ERROR_UNHANDLED_OP_TYPE_IN_LOOP", ctx->result_buffer_size-1);
            ctx->recursion_depth--; return false;
        }
    } // end while
    ctx->recursion_depth--;
    return true;
}

// Top-level function to evaluate an expression from a token array
bool evaluate_expression_from_tokens(Token* expression_tokens, int num_expr_tokens,
                                     char* result_buffer, size_t buffer_size) {
    if (num_expr_tokens == 0) {
        result_buffer[0] = '\0';
        return true; // Empty expression is empty result
    }

    ExprParseContext ctx;
    ctx.tokens = expression_tokens;
    ctx.current_token_idx = 0;
    ctx.num_tokens = num_expr_tokens;
    ctx.result_buffer = result_buffer; // The final result will be placed here
    ctx.result_buffer_size = buffer_size;
    ctx.recursion_depth = 0;
    result_buffer[0] = '\0';

    if (!parse_expression_recursive(&ctx, 0)) { // Start with precedence 0
        // Error message already in result_buffer or printed to stderr
        // Ensure result_buffer contains an error marker if not already set by parser
        if (strlen(result_buffer) == 0 || 
            strncmp(result_buffer, "EXPR_PARSE_ERROR", strlen("EXPR_PARSE_ERROR")) != 0 ) {
            // strncpy(result_buffer, "EXPR_EVAL_FAILED_UNKNOWN", buffer_size-1);
        }
        return false;
    }

    // After successful parsing, ctx.result_buffer (which is the passed result_buffer) contains the final value.
    // Check if all tokens were consumed (optional, but good for validating full parse)
    if (ctx.current_token_idx < ctx.num_tokens && ctx.tokens[ctx.current_token_idx].type != TOKEN_EOF) {
         Token extra_token = ctx.tokens[ctx.current_token_idx];
         fprintf(stderr, "Expression parser: Unexpected tokens left after expression evaluation, starting with '%s' at line %d col %d.\n",
            extra_token.text, extra_token.line, extra_token.col);
         // This might indicate a flaw in the grammar or expression structure.
         // For now, we'll return true as we got *a* result, but with a warning.
         // Or, make it return false:
         // strncpy(result_buffer, "EXPR_PARSE_ERROR_TRAILING_TOKENS", buffer_size-1);
         // return false;
    }
    return true;
}

// Can now be used for binary (op1, op2, op_str), 
// prefix (var_name, op_str, "prefix"), 
// or postfix (var_name, op_str, "postfix") calls to BSH __dynamic_op_handler.
bool invoke_bsh_dynamic_op_handler(
    const char* bsh_func_name_to_call, // Should be "__dynamic_op_handler"
    const char* arg1_val_or_var_name,  // For binary: operand1 value. For unary: variable name.
    const char* arg2_val_or_op_str,    // For binary: operand2 value. For unary prefix/postfix: operator string.
    const char* arg3_op_str_or_context,// For binary: operator string. For unary: "prefix" or "postfix" or type.
    const char* bsh_result_var_name,   // BSH variable where the BSH handler should store its result.
    char* c_result_buffer, size_t c_result_buffer_size) {

    UserFunction* func = function_list;
    while (func) {
        if (strcmp(func->name, bsh_func_name_to_call) == 0) break;
        func = func->next;
    }
    if (!func) {
        fprintf(stderr, "Error: BSH internal handler function '%s' not found.\n", bsh_func_name_to_call);
        snprintf(c_result_buffer, c_result_buffer_size, "NO_HANDLER_ERROR");
        return false;
    }

    // __dynamic_op_handler is expected to handle various argument counts or use placeholders.
    // Let's assume it expects 4 arguments: (arg1, arg2, arg3/op, result_var_name)
    // For unary: arg1=var_name, arg2=op_str, arg3="prefix"/"postfix", result_var_name
    // For binary: arg1=val1, arg2=val2, arg3=op_str, result_var_name
    if (func->param_count != 4) {
         fprintf(stderr, "Error: BSH function '%s' has incorrect param count (expected 4, got %d) for dynamic op handling.\n", bsh_func_name_to_call, func->param_count);
         snprintf(c_result_buffer, c_result_buffer_size, "HANDLER_PARAM_ERROR");
        return false;
    }

    Token call_tokens[4];
    char token_storage_arg1[INPUT_BUFFER_SIZE];
    char token_storage_arg2[INPUT_BUFFER_SIZE];
    char token_storage_arg3[INPUT_BUFFER_SIZE]; // op_str or context
    char token_storage_arg4_res_var[MAX_VAR_NAME_LEN];

    // Argument 1
    strncpy(token_storage_arg1, arg1_val_or_var_name, INPUT_BUFFER_SIZE -1); token_storage_arg1[INPUT_BUFFER_SIZE-1] = '\0';
    call_tokens[0].type = TOKEN_STRING; // Pass as string, BSH handler will know if it's a var name or value
    call_tokens[0].text = token_storage_arg1;
    call_tokens[0].len = strlen(token_storage_arg1);

    // Argument 2
    strncpy(token_storage_arg2, arg2_val_or_op_str, INPUT_BUFFER_SIZE -1); token_storage_arg2[INPUT_BUFFER_SIZE-1] = '\0';
    call_tokens[1].type = TOKEN_STRING;
    call_tokens[1].text = token_storage_arg2;
    call_tokens[1].len = strlen(token_storage_arg2);
    
    // Argument 3
    strncpy(token_storage_arg3, arg3_op_str_or_context, INPUT_BUFFER_SIZE -1); token_storage_arg3[INPUT_BUFFER_SIZE-1] = '\0';
    call_tokens[2].type = TOKEN_STRING;
    call_tokens[2].text = token_storage_arg3;
    call_tokens[2].len = strlen(token_storage_arg3);

    // Argument 4 (result holder variable name)
    strncpy(token_storage_arg4_res_var, bsh_result_var_name, MAX_VAR_NAME_LEN -1); token_storage_arg4_res_var[MAX_VAR_NAME_LEN-1] = '\0';
    call_tokens[3].type = TOKEN_WORD; // Name of variable to set
    call_tokens[3].text = token_storage_arg4_res_var;
    call_tokens[3].len = strlen(token_storage_arg4_res_var);

    execute_user_function(func, call_tokens, 4, NULL);

    char* result_from_bsh = get_variable_scoped(bsh_result_var_name);
    if (result_from_bsh) {
        strncpy(c_result_buffer, result_from_bsh, c_result_buffer_size - 1);
        c_result_buffer[c_result_buffer_size - 1] = '\0';
    } else {
        snprintf(c_result_buffer, c_result_buffer_size, "OP_HANDLER_NO_RESULT_VAR<%s>", bsh_result_var_name);
        // This might be an error or might be acceptable if the operation has side effects only
        // and doesn't produce a distinct "expression value" (e.g. some BSH handler designs).
        // For typical math ops or assignments, a result is expected.
    }
    return true;
}

bool evaluate_expression_tokens(Token* tokens_arr, int start_idx, int end_idx, char* result_buffer, size_t buffer_size) {
    result_buffer[0] = '\0';
    if (start_idx > end_idx) {
        // fprintf(stderr, "Debug: evaluate_expression_tokens called with empty token range.\n");
        return true; // Successfully evaluated to "empty"
    }

    // Find the main ternary operator symbols ('?' and ':') at the current nesting level.
    // This simplified version doesn't handle nested parentheses balancing for finding ? and :
    int qmark_idx = -1, colon_idx = -1;
    // int paren_level = 0; // Would be needed for robust ? : finding with parentheses

    for (int i = start_idx; i <= end_idx; ++i) {
        // if (tokens_arr[i].type == TOKEN_LPAREN) paren_level++;
        // else if (tokens_arr[i].type == TOKEN_RPAREN) paren_level--;
        // if (paren_level == 0) { // Only consider operators at the top level of parentheses
            if (tokens_arr[i].type == TOKEN_OPERATOR /*was TOKEN_QMARK*/ && qmark_idx == -1) { // First '?'
                qmark_idx = i;
            } else if (tokens_arr[i].type == TOKEN_OPERATOR /* was TOKEN_COLON*/ && qmark_idx != -1 && colon_idx == -1) { // First ':' after '?'
                colon_idx = i;
                // break; // Found a complete ? : structure at this level
            }
        // }
    }

    if (qmark_idx != -1 && colon_idx != -1 && qmark_idx < colon_idx) {
        // Ternary operator found: A ? B : C
        // A: tokens_arr[start_idx ... qmark_idx-1]
        // B: tokens_arr[qmark_idx+1 ... colon_idx-1]
        // C: tokens_arr[colon_idx+1 ... end_idx]

        char condition_result_str[INPUT_BUFFER_SIZE];
        if (!evaluate_expression_tokens(tokens_arr, start_idx, qmark_idx - 1, condition_result_str, sizeof(condition_result_str))) {
            strncpy(result_buffer, "TERNARY_COND_EVAL_ERROR", buffer_size - 1);
            return false; // Error evaluating condition
        }

        // Evaluate condition_result_str ("1", "true", "0", "false", or non-empty/empty for truthiness)
        bool condition_is_true = (strcmp(condition_result_str, "1") == 0 ||
                                  strcasecmp(condition_result_str, "true") == 0 ||
                                  (strlen(condition_result_str) > 0 && strcmp(condition_result_str,"0") != 0 && strcasecmp(condition_result_str,"false") !=0 ) );

        if (condition_is_true) {
            return evaluate_expression_tokens(tokens_arr, qmark_idx + 1, colon_idx - 1, result_buffer, buffer_size);
        } else {
            return evaluate_expression_tokens(tokens_arr, colon_idx + 1, end_idx, result_buffer, buffer_size);
        }
    } else {
        // No ternary operator at this level, or malformed. Evaluate as simple expression.
        // This part will handle: literal, variable, or single op1 OPR op2, or UNARY_OP op1 etc.
        int num_expr_tokens = (end_idx - start_idx) + 1;

        if (num_expr_tokens == 1) { // Single token: literal or variable
            Token* current_token = &tokens_arr[start_idx];
            if (current_token->type == TOKEN_STRING) {
                char unescaped[INPUT_BUFFER_SIZE];
                unescape_string(current_token->text, unescaped, sizeof(unescaped));
                expand_variables_in_string_advanced(unescaped, result_buffer, buffer_size);
            } else if (current_token->type == TOKEN_NUMBER || current_token->type == TOKEN_VARIABLE || current_token->type == TOKEN_WORD) {
                expand_variables_in_string_advanced(current_token->text, result_buffer, buffer_size);
            } else {
                fprintf(stderr, "Error: Cannot evaluate single token of type %d as expression.\n", current_token->type);
                strncpy(result_buffer, "EXPR_EVAL_ERROR", buffer_size -1); return false;
            }
            return true;
        } else if (num_expr_tokens == 2) { // Potential unary operation: OP $var or $var OP
            Token* op_token = NULL; Token* var_token = NULL; char context[10];
            if (tokens_arr[start_idx].type == TOKEN_OPERATOR && tokens_arr[start_idx+1].type == TOKEN_VARIABLE) { // ++$var
                op_token = &tokens_arr[start_idx]; var_token = &tokens_arr[start_idx+1]; strcpy(context, "prefix");
            } else if (tokens_arr[start_idx].type == TOKEN_VARIABLE && tokens_arr[start_idx+1].type == TOKEN_OPERATOR) { // $var++
                var_token = &tokens_arr[start_idx]; op_token = &tokens_arr[start_idx+1]; strcpy(context, "postfix");
            }

            if (op_token && var_token) {
                char var_name_clean[MAX_VAR_NAME_LEN]; // Extract from var_token->text (remove '$')
                // ... (logic to extract clean var name, same as in old handle_unary_op_statement / process_line for unary)
                 if (var_token->text[0] == '$') {
                    if (var_token->text[1] == '{') { /* ... */ } else { strncpy(var_name_clean, var_token->text + 1, MAX_VAR_NAME_LEN - 1); var_name_clean[MAX_VAR_NAME_LEN - 1] = '\0';}
                } else { /* error */ return false; }

                const char* temp_bsh_result_var = "__TEMP_EVAL_EXPR_RES";
                return invoke_bsh_dynamic_op_handler("__dynamic_op_handler",
                                               var_name_clean, op_token->text, context,
                                               temp_bsh_result_var, result_buffer, buffer_size);
            } else {
                 fprintf(stderr, "Error: Malformed 2-token expression for evaluation.\n");
                 strncpy(result_buffer, "EXPR_EVAL_ERROR", buffer_size-1); return false;
            }
        } else if (num_expr_tokens == 3 && tokens_arr[start_idx+1].type == TOKEN_OPERATOR) { // op1 OPR op2
            char op1_expanded[INPUT_BUFFER_SIZE];
            char op2_expanded[INPUT_BUFFER_SIZE];

            // Expand operand1
            if (tokens_arr[start_idx].type == TOKEN_STRING) { /* unescape and expand */ unescape_string(tokens_arr[start_idx].text, op1_expanded, sizeof(op1_expanded)); expand_variables_in_string_advanced(op1_expanded, op1_expanded, sizeof(op1_expanded)); }
            else { expand_variables_in_string_advanced(tokens_arr[start_idx].text, op1_expanded, sizeof(op1_expanded)); }

            // Expand operand2
            if (tokens_arr[start_idx+2].type == TOKEN_STRING) { /* unescape and expand */ unescape_string(tokens_arr[start_idx+2].text, op2_expanded, sizeof(op2_expanded)); expand_variables_in_string_advanced(op2_expanded, op2_expanded, sizeof(op2_expanded));}
            else { expand_variables_in_string_advanced(tokens_arr[start_idx+2].text, op2_expanded, sizeof(op2_expanded)); }

            const char* operator_str = tokens_arr[start_idx+1].text;
            const char* temp_bsh_result_var = "__TEMP_EVAL_EXPR_RES";
            return invoke_bsh_dynamic_op_handler("__dynamic_op_handler",
                                           op1_expanded, op2_expanded, operator_str,
                                           temp_bsh_result_var, result_buffer, buffer_size);
        } else {
            // More complex expression or unsupported: concatenate as string for now (basic fallback)
            // This path means the expression wasn't a single var/literal, recognized unary/binary, or ternary.
            // It will just combine the raw token texts or their variable expansions.
            result_buffer[0] = '\0'; size_t current_len = 0;
            for (int i = start_idx; i <= end_idx; ++i) {
                char expanded_part[INPUT_BUFFER_SIZE];
                if (tokens_arr[i].type == TOKEN_STRING) { /* unescape and expand */ unescape_string(tokens_arr[i].text, expanded_part, sizeof(expanded_part)); expand_variables_in_string_advanced(expanded_part, expanded_part, sizeof(expanded_part)); }
                else { expand_variables_in_string_advanced(tokens_arr[i].text, expanded_part, sizeof(expanded_part)); }
                
                if (current_len + strlen(expanded_part) + (i > start_idx ? 1 : 0) < buffer_size) {
                    if (i > start_idx) { strcat(result_buffer, " "); current_len++; }
                    strcat(result_buffer, expanded_part); current_len += strlen(expanded_part);
                } else { /* buffer full */ break; }
            }
            // This fallback concatenation might not be "evaluation" in a strict sense for complex expressions
            // but it's what bsh does for simple multi-token assignments if not an op or command.
            return true;
        }
    }
    return false; // Should not be reached if logic is complete
}

bool evaluate_condition_advanced(Token* operand1_token, Token* operator_token, Token* operand2_token) {
    if (!operand1_token || !operator_token || !operand2_token) return false;

    char val1_expanded[INPUT_BUFFER_SIZE], val2_expanded[INPUT_BUFFER_SIZE];
    if (operand1_token->type == TOKEN_STRING) { char unescaped[INPUT_BUFFER_SIZE]; unescape_string(operand1_token->text, unescaped, sizeof(unescaped)); expand_variables_in_string_advanced(unescaped, val1_expanded, sizeof(val1_expanded));
    } else { expand_variables_in_string_advanced(operand1_token->text, val1_expanded, sizeof(val1_expanded)); }
    if (operand2_token->type == TOKEN_STRING) { char unescaped[INPUT_BUFFER_SIZE]; unescape_string(operand2_token->text, unescaped, sizeof(unescaped)); expand_variables_in_string_advanced(unescaped, val2_expanded, sizeof(val2_expanded));
    } else { expand_variables_in_string_advanced(operand2_token->text, val2_expanded, sizeof(val2_expanded)); }

    const char* op_str = operator_token->text;
    if (strcmp(op_str, "==") == 0) return strcmp(val1_expanded, val2_expanded) == 0;
    if (strcmp(op_str, "!=") == 0) return strcmp(val1_expanded, val2_expanded) != 0;

    long num1, num2; char *endptr1, *endptr2;
    errno = 0; num1 = strtol(val1_expanded, &endptr1, 10); bool num1_valid = (errno == 0 && val1_expanded[0] != '\0' && *endptr1 == '\0');
    errno = 0; num2 = strtol(val2_expanded, &endptr2, 10); bool num2_valid = (errno == 0 && val2_expanded[0] != '\0' && *endptr2 == '\0');
    bool numeric_possible = num1_valid && num2_valid;

    if (numeric_possible) {
        if (strcmp(op_str, ">") == 0) return num1 > num2; if (strcmp(op_str, "<") == 0) return num1 < num2;
        if (strcmp(op_str, ">=") == 0) return num1 >= num2; if (strcmp(op_str, "<=") == 0) return num1 <= num2;
    } else { 
        if (strcmp(op_str, ">") == 0) return strcmp(val1_expanded, val2_expanded) > 0;
        if (strcmp(op_str, "<") == 0) return strcmp(val1_expanded, val2_expanded) < 0;
        if (strcmp(op_str, ">=") == 0) return strcmp(val1_expanded, val2_expanded) >= 0;
        if (strcmp(op_str, "<=") == 0) return strcmp(val1_expanded, val2_expanded) <= 0;
    }
    fprintf(stderr, "Unsupported operator or type mismatch in condition: '%s' %s '%s'\n", val1_expanded, op_str, val2_expanded);
    return false;
}

bool is_comparison_or_assignment_operator(const char* op_str) {
    if (strcmp(op_str, "==") == 0 || strcmp(op_str, "!=") == 0 ||
        strcmp(op_str, ">") == 0  || strcmp(op_str, "<") == 0 ||
        strcmp(op_str, ">=") == 0 || strcmp(op_str, "<=") == 0 ||
        strcmp(op_str, "=") == 0) { 
        return true;
    }
    return false;
}

// --- process_line updated to use new expression evaluation ---
void process_line(char *line_raw, FILE *input_source, int current_line_no, ExecutionState exec_mode_param) {
    char line[MAX_LINE_LENGTH];
    strncpy(line, line_raw, MAX_LINE_LENGTH -1);
    line[MAX_LINE_LENGTH-1] = '\0';
    trim_whitespace(line);

    if (line[0] == '\0') return;

    // ... (function definition body capture remains similar) ...
    if (is_defining_function && current_function_definition &&
        (current_exec_state == STATE_DEFINE_FUNC_BODY || current_exec_state == STATE_IMPORT_PARSING || exec_mode_param == STATE_IMPORT_PARSING) &&
        block_stack_top_bf >=0 && peek_block_bf() && peek_block_bf()->type == BLOCK_TYPE_FUNCTION_DEF && 
        strncmp(line, "}", 1) != 0 && strncmp(line, "}", strlen(line)) != 0 ) { 

        if (current_function_definition->line_count < MAX_FUNC_LINES) {
            current_function_definition->body[current_function_definition->line_count] = strdup(line);
            if (!current_function_definition->body[current_function_definition->line_count]) {
                perror("strdup for function body line failed");
            } else {
                current_function_definition->line_count++;
            }
        } else { /* ... error handling for too many lines ... */ }
        return; 
    }


    Token tokens[MAX_EXPRESSION_TOKENS]; // Max tokens for one line/expression
    char token_storage[TOKEN_STORAGE_SIZE];
    int num_tokens = advanced_tokenize_line(line, current_line_no, tokens, MAX_EXPRESSION_TOKENS, token_storage, TOKEN_STORAGE_SIZE);

    if (num_tokens == 0 || tokens[0].type == TOKEN_EMPTY || tokens[0].type == TOKEN_EOF) return;
    if (tokens[0].type == TOKEN_COMMENT) return; // Already handled if tokenizer skips comments entirely

    // ... ( '{' and '}' handling for blocks remains similar, but ensure exec_state is checked ) ...
    if (tokens[0].type == TOKEN_LBRACE && num_tokens == 1) { handle_opening_brace_token(tokens[0]); return; }
    if (tokens[0].type == TOKEN_RBRACE && num_tokens == 1) { handle_closing_brace_token(tokens[0], input_source); return; }


    // ... (current_exec_state == STATE_BLOCK_SKIP logic remains similar) ...
    if (current_exec_state == STATE_BLOCK_SKIP && exec_mode_param != STATE_IMPORT_PARSING) {
        const char* first_token_text_resolved = NULL;
        if (tokens[0].type == TOKEN_WORD) {
             first_token_text_resolved = resolve_keyword_alias(tokens[0].text);
        }

        if (tokens[0].type == TOKEN_RBRACE) { 
            handle_closing_brace_token(tokens[0], input_source);
        } else if (first_token_text_resolved &&
                   (strcmp(first_token_text_resolved, "else") == 0 )) {
            handle_else_statement_advanced(tokens, num_tokens, input_source, current_line_no);
        } else if (first_token_text_resolved && strcmp(first_token_text_resolved, "if") == 0){
            push_block_bf(BLOCK_TYPE_IF, false, 0, current_line_no);
        } else if (first_token_text_resolved && strcmp(first_token_text_resolved, "while") == 0){
            push_block_bf(BLOCK_TYPE_WHILE, false, 0, current_line_no);
        } else if (first_token_text_resolved && strcmp(first_token_text_resolved, "defunc") == 0){
             push_block_bf(BLOCK_TYPE_FUNCTION_DEF, false, 0, current_line_no); 
        } else if (tokens[0].type == TOKEN_LBRACE) { 
            BlockFrame* current_block = peek_block_bf();
            if (!current_block) { // Should not happen if LBRACE follows a skipped if/while/defunc
                 fprintf(stderr, "Syntax error: Unmatched '{' on line %d while skipping.\n", current_line_no);
            }
        }        
        return;
    }
    if (bsh_return_value_is_set && current_exec_state == STATE_RETURN_REQUESTED){
        // If a return/exit happened, subsequent lines in the current context (script/function) are skipped.
        return;
    }


    // --- Actual command/statement processing ---
    // 1. Assignment: $variable = <expression>
    // Need to identify if it's an assignment. A simple check:
    // $VAR = ...  -> tokens[0] is TOKEN_VARIABLE, tokens[1] is TOKEN_OPERATOR with text "=" (if '=' is TOKEN_OPERATOR)
    // OR tokens[1] is TOKEN_ASSIGN (if '=' is special).
    // Let's assume '=' is a TOKEN_OPERATOR defined with specific properties for assignment.
    bool is_assignment = false;
    if (num_tokens >= 3 && tokens[0].type == TOKEN_VARIABLE) {
        if (tokens[1].type == TOKEN_ASSIGN) { // If '=' is still special TOKEN_ASSIGN
            is_assignment = true;
        } else if (tokens[1].type == TOKEN_OPERATOR) {
            OperatorDefinition* op_eq = get_operator_definition(tokens[1].text);
            // We need a way to distinguish assignment '=' from comparison '==' if both are TOKEN_OPERATOR.
            // This could be done by a specific op_type_prop for assignment, or by convention in BSH handler.
            // For now, let's assume a BSH script defines "=" with a handler that performs assignment.
            // The expression evaluator will call this handler.
            // So, assignment is just a special case of expression evaluation where the top-level op is "=".
            // This means handle_assignment_advanced might become simpler or be folded into expression eval.
            // For this iteration, let's keep handle_assignment_advanced distinct for clarity of intent.
            if (strcmp(tokens[1].text, "=") == 0) { // Simple check for now
                 is_assignment = true;
            }
        }
    }

    if (is_assignment) {
        handle_assignment_advanced(tokens, num_tokens); // This will use evaluate_expression_from_tokens for RHS
    }
    // 2. Built-in keywords (if, while, defunc, echo, etc.)
    else if (tokens[0].type == TOKEN_WORD) {
        const char* command_name = resolve_keyword_alias(tokens[0].text);
        // ... (dispatch to handle_if, handle_while, handle_echo, handle_defunc, handle_defoperator, etc.) ...
        // These handlers for if/while will use evaluate_expression_from_tokens for their conditions.
        if (strcmp(command_name, "echo") == 0) { handle_echo_advanced(tokens, num_tokens); }
        else if (strcmp(command_name, "defkeyword") == 0) { handle_defkeyword_statement(tokens, num_tokens); }
        else if (strcmp(command_name, "defoperator") == 0) { handle_defoperator_statement(tokens, num_tokens); }
        else if (strcmp(command_name, "if") == 0) { handle_if_statement_advanced(tokens, num_tokens, input_source, current_line_no); }
        else if (strcmp(command_name, "else") == 0) { handle_else_statement_advanced(tokens, num_tokens, input_source, current_line_no); }
        else if (strcmp(command_name, "while") == 0) { handle_while_statement_advanced(tokens, num_tokens, input_source, current_line_no); }
        else if (strcmp(command_name, "defunc") == 0) { handle_defunc_statement_advanced(tokens, num_tokens); }
        else if (strcmp(command_name, "loadlib") == 0) { handle_loadlib_statement(tokens, num_tokens); }
        else if (strcmp(command_name, "calllib") == 0) { handle_calllib_statement(tokens, num_tokens); }
        else if (strcmp(command_name, "import") == 0) { handle_import_statement(tokens, num_tokens); }
        else if (strcmp(command_name, "update_cwd") == 0) { handle_update_cwd_statement(tokens, num_tokens); }
        else if (strcmp(command_name, "eval") == 0) { handle_eval_statement(tokens, num_tokens); }
        else if (strcmp(command_name, "exit") == 0) { handle_exit_statement(tokens, num_tokens); }
        // Add other built-ins here
        else {
            UserFunction* func_to_run = function_list; /* ... find func ... */ // Search for the user function (existing code)
            // while(func_to_run) {
            // if (strcmp(func_to_run->name, command_name) == 0) break;
            // func_to_run = func_to_run->next;
            // }

            if (func_to_run) {
                // If it's a user function           
                Token* call_arg_tokens = (num_tokens > 1) ? &tokens[1] : NULL;
                int call_arg_token_count = (num_tokens > 1) ? num_tokens - 1 : 0;
                execute_user_function(func_to_run, call_arg_tokens, call_arg_token_count, input_source);
            } else {
                // It's not a user function, try as an external command or expression
                char command_path_ext[MAX_FULL_PATH_LEN];
                if (find_command_in_path_dynamic(tokens[0].text, command_path_ext)) {
                    // Prepare arguments for external command ---
                    char* args[MAX_ARGS + 1];
                    char arg_buffer[MAX_ARGS][MAX_LINE_LENGTH]; // Buffer to store combined or copied arguments
                    int arg_current = 0;
                    args[arg_current++] = command_path_ext; // The command itself

                    int i = 1; // Index to iterate through argument tokens
                    while (i < num_tokens && arg_current < MAX_ARGS) {
                        if (tokens[i].type == TOKEN_COMMENT) break; // Ignore comments

                        if (tokens[i].type == TOKEN_OPERATOR && strcmp(tokens[i].text, "-") == 0 &&
                            (i + 1 < num_tokens && tokens[i + 1].type == TOKEN_WORD && tokens[i+1].text[0] != '\0' && // Ensures WORD is not empty
                            !isdigit(tokens[i+1].text[0])) // Ensures it's not like "- 5" but "-option"
                        ) {
                            // Combine "-" and the next word (e.g., "-option")
                            snprintf(arg_buffer[arg_current -1], MAX_LINE_LENGTH, "-%s", tokens[i + 1].text);
                            args[arg_current++] = arg_buffer[arg_current-1];
                            i += 2; // Skip the "-" operator and the combined word
                        } else {
                            // Normal argument, expand variables and unescape strings
                            char expanded_arg_temp[INPUT_BUFFER_SIZE];
                            if(tokens[i].type == TOKEN_STRING) {
                                char unescaped_val[INPUT_BUFFER_SIZE];
                                unescape_string(tokens[i].text, unescaped_val, sizeof(unescaped_val));
                                expand_variables_in_string_advanced(unescaped_val, expanded_arg_temp, sizeof(expanded_arg_temp));
                            } else {
                                expand_variables_in_string_advanced(tokens[i].text, expanded_arg_temp, sizeof(expanded_arg_temp));
                            }
                            // Copy the expanded argument into the dedicated buffer
                            strncpy(arg_buffer[arg_current-1], expanded_arg_temp, MAX_LINE_LENGTH -1);
                            arg_buffer[arg_current-1][MAX_LINE_LENGTH-1] = '\0';
                            args[arg_current++] = arg_buffer[arg_current-1];
                            i++;
                        }
                    }
                    args[arg_current] = NULL; // Terminator for arguments array

                    // Note: output_buffer and output_buffer_size are NULL and 0 if not capturing output for bsh
                    execute_external_command(command_path_ext, args, arg_current, NULL, 0);
                } else {
                    // Normal expression evaluation
                    // Check for standalone unary prefix operations: e.g., ++$var or --$var
                    if (num_tokens == 2 &&
                        tokens[0].type == TOKEN_OPERATOR &&
                        (strcmp(tokens[0].text, "++") == 0 || strcmp(tokens[0].text, "--") == 0) &&
                        tokens[1].type == TOKEN_VARIABLE) {
                        
                        char var_name_clean[MAX_VAR_NAME_LEN];
                        // Extract clean variable name from tokens[1].text (e.g., "$myvar" -> "myvar")
                        // This logic needs to be robust for $var, ${var}
                        if (tokens[1].text[0] == '$') {
                            if (tokens[1].text[1] == '{') {
                                const char* end_brace = strchr(tokens[1].text + 2, '}');
                                if (end_brace && (end_brace - (tokens[1].text + 2) < MAX_VAR_NAME_LEN)) {
                                    strncpy(var_name_clean, tokens[1].text + 2, end_brace - (tokens[1].text + 2));
                                    var_name_clean[end_brace - (tokens[1].text + 2)] = '\0';
                                } else { /* error or malformed */ strcpy(var_name_clean, ""); }
                            } else {
                                strncpy(var_name_clean, tokens[1].text + 1, MAX_VAR_NAME_LEN - 1);
                                var_name_clean[MAX_VAR_NAME_LEN - 1] = '\0';
                            }
                            // Note: Array element unary ops like ++$arr[idx] are complex to parse here simply.
                            // The BSH __dynamic_op_handler would need to handle var_name_clean if it's "arr[idx]".
                        } else { strcpy(var_name_clean, ""); /* Should not happen if TOKEN_VARIABLE */ }


                        if (strlen(var_name_clean) > 0) {
                            char result_c_buffer[INPUT_BUFFER_SIZE];
                            const char* temp_bsh_result_var = "__TEMP_STANDALONE_OP_RES";
                            
                            // Call BSH __dynamic_op_handler: (var_name, op_str, "prefix", result_holder)
                            if (invoke_bsh_dynamic_op_handler("__dynamic_op_handler",
                                                        var_name_clean,         // Variable Name
                                                        tokens[0].text,         // Operator "++" or "--"
                                                        "prefix",               // Context
                                                        temp_bsh_result_var,
                                                        result_c_buffer, sizeof(result_c_buffer))) {
                                if (strlen(result_c_buffer) > 0 && strncmp(result_c_buffer, "OP_HANDLER_NO_RESULT_VAR", 26) != 0) {
                                    printf("%s\n", result_c_buffer); // Print result of standalone prefix op
                                }
                                set_variable_scoped("LAST_OP_RESULT", result_c_buffer, false);
                            } else {
                                fprintf(stderr, "Error executing standalone prefix operation for: %s %s\n", tokens[0].text, var_name_clean);
                                set_variable_scoped("LAST_OP_RESULT", "STANDALONE_OP_ERROR", false);
                            }
                        } else {
                            fprintf(stderr, "Error: Malformed variable for prefix operation: %s\n", tokens[1].text);
                        }

                    } // Check for standalone unary postfix operations: e.g., $var++ or $var--
                    else if (num_tokens == 2 &&
                            tokens[0].type == TOKEN_VARIABLE &&
                            tokens[1].type == TOKEN_OPERATOR &&
                            (strcmp(tokens[1].text, "++") == 0 || strcmp(tokens[1].text, "--") == 0)) {

                        char var_name_clean[MAX_VAR_NAME_LEN];
                        // Extract clean variable name from tokens[0].text
                        if (tokens[0].text[0] == '$') {
                            if (tokens[0].text[1] == '{') {
                                // Similar to prefix block
                                const char* end_brace = strchr(tokens[0].text + 2, '}');
                                if (end_brace && (end_brace - (tokens[0].text + 2) < MAX_VAR_NAME_LEN)) {
                                    strncpy(var_name_clean, tokens[0].text + 2, end_brace - (tokens[0].text + 2));
                                    var_name_clean[end_brace - (tokens[0].text + 2)] = '\0';
                                } else { strcpy(var_name_clean, ""); }
                            } else {
                                strncpy(var_name_clean, tokens[0].text + 1, MAX_VAR_NAME_LEN - 1);
                                var_name_clean[MAX_VAR_NAME_LEN - 1] = '\0';
                            }
                        } else { strcpy(var_name_clean, "");}

                        if (strlen(var_name_clean) > 0) {
                            char result_c_buffer[INPUT_BUFFER_SIZE];
                            const char* temp_bsh_result_var = "__TEMP_STANDALONE_OP_RES";

                            // Call BSH __dynamic_op_handler: (var_name, op_str, "postfix", result_holder)
                            if (invoke_bsh_dynamic_op_handler("__dynamic_op_handler",
                                                        var_name_clean,         // Variable Name
                                                        tokens[1].text,         // Operator "++" or "--"
                                                        "postfix",              // Context
                                                        temp_bsh_result_var,
                                                        result_c_buffer, sizeof(result_c_buffer))) {
                                if (strlen(result_c_buffer) > 0 && strncmp(result_c_buffer, "OP_HANDLER_NO_RESULT_VAR", 26) != 0) {
                                    printf("%s\n", result_c_buffer); // Print result of standalone postfix op
                                }
                                set_variable_scoped("LAST_OP_RESULT", result_c_buffer, false);
                            } else {
                                fprintf(stderr, "Error executing standalone postfix operation for: %s %s\n", var_name_clean, tokens[1].text);
                                set_variable_scoped("LAST_OP_RESULT", "STANDALONE_OP_ERROR", false);
                            }
                        } else {
                            fprintf(stderr, "Error: Malformed variable for postfix operation: %s\n", tokens[0].text);
                        }
                    }
                    // Standalone dynamic binary operator pattern: val1 op val2 (e.g. 10 + 5 at prompt)
                    // This was the existing logic.
                    else if ( (num_tokens == 3 || (num_tokens == 4 && tokens[3].type == TOKEN_COMMENT)) &&
                        (tokens[0].type == TOKEN_VARIABLE || tokens[0].type == TOKEN_NUMBER || tokens[0].type == TOKEN_STRING || tokens[0].type == TOKEN_WORD) && 
                        tokens[1].type == TOKEN_OPERATOR && !is_comparison_or_assignment_operator(tokens[1].text) && // keep this check
                        (tokens[2].type == TOKEN_VARIABLE || tokens[2].type == TOKEN_NUMBER || tokens[2].type == TOKEN_STRING || tokens[2].type == TOKEN_WORD) 
                    ) {
                            char op1_expanded[INPUT_BUFFER_SIZE];
                            char op2_expanded[INPUT_BUFFER_SIZE];
                            char result_c_buffer[INPUT_BUFFER_SIZE];
                            const char* operator_str = tokens[1].text;
                            const char* temp_bsh_result_var = "__TEMP_STANDALONE_OP_RES"; 

                            // ... (expansion of op1_expanded, op2_expanded as before)
                            if (tokens[0].type == TOKEN_STRING) { /* ... */ } else { /* ... */ }
                            expand_variables_in_string_advanced(tokens[0].text, op1_expanded, sizeof(op1_expanded)); // Simplified for snippet
                            if (tokens[2].type == TOKEN_STRING) { /* ... */ } else { /* ... */ }
                            expand_variables_in_string_advanced(tokens[2].text, op2_expanded, sizeof(op2_expanded)); // Simplified for snippet
                            
                            // Call BSH __dynamic_op_handler: (val1, val2, op_str, result_holder)
                            if (invoke_bsh_dynamic_op_handler("__dynamic_op_handler",
                                                        op1_expanded, op2_expanded, operator_str, 
                                                        temp_bsh_result_var,
                                                        result_c_buffer, sizeof(result_c_buffer))) {
                                if (strlen(result_c_buffer) > 0 &&
                                    strncmp(result_c_buffer, "OP_HANDLER_NO_RESULT_VAR", 26) != 0
                                    /* && other error checks ... */ ) {
                                    printf("%s\n", result_c_buffer); 
                                }
                                set_variable_scoped("LAST_OP_RESULT", result_c_buffer, false);
                            } else {
                                fprintf(stderr, "Error executing standalone dynamic binary operation for: %s %s %s\n", op1_expanded, operator_str, op2_expanded);
                                set_variable_scoped("LAST_OP_RESULT", "STANDALONE_OP_ERROR", false);
                            }
                    } else {

                        // Try to evaluate the whole line as an expression if it's not assignment/command.
                        char expression_result_buffer[INPUT_BUFFER_SIZE];
                        if (evaluate_expression_tokens(tokens, 0, num_tokens - 1, expression_result_buffer, sizeof(expression_result_buffer))) {
                            if (strlen(expression_result_buffer) > 0 &&
                                strncmp(expression_result_buffer, "TERNARY_COND_EVAL_ERROR", strlen("TERNARY_COND_EVAL_ERROR")) != 0 &&
                                strncmp(expression_result_buffer, "EXPR_EVAL_ERROR", strlen("EXPR_EVAL_ERROR")) != 0 &&
                                // Also check against results from invoke_bsh_dynamic_op_handler if they indicate errors
                                strncmp(expression_result_buffer, "OP_HANDLER_NO_RESULT_VAR", strlen("OP_HANDLER_NO_RESULT_VAR")) !=0 &&
                                strncmp(expression_result_buffer, "NO_HANDLER_ERROR", strlen("NO_HANDLER_ERROR")) !=0 &&
                                strncmp(expression_result_buffer, "UNKNOWN_HANDLER_ERROR", strlen("UNKNOWN_HANDLER_ERROR")) !=0 &&
                                strncmp(expression_result_buffer, "UNKNOWN_PREFIX_OP_ERROR", strlen("UNKNOWN_PREFIX_OP_ERROR")) !=0 &&
                                strncmp(expression_result_buffer, "UNARY_PREFIX_OP_ERROR", strlen("UNARY_PREFIX_OP_ERROR")) !=0 &&
                                // ... etc. for other error strings from invoke_bsh_dynamic_op_handler or its BSH callees
                                true /* add more positive checks if needed, or fewer error checks */
                                ) {
                                printf("%s\n", expression_result_buffer);
                            }
                            set_variable_scoped("LAST_OP_RESULT", expression_result_buffer, false); // Or a new var like LAST_EXPR_RESULT
                        } else {
                            // If evaluate_expression_tokens returned false, it's a more fundamental parsing error
                            // OR it could be an external command if no expression pattern matched.
                            // This 'else' branch would now contain the logic to try it as an external command.
                            char command_path_ext[MAX_FULL_PATH_LEN];
                            if (find_command_in_path_dynamic(tokens[0].text, command_path_ext)) {
                                // External command
                                char command_path[MAX_FULL_PATH_LEN];
                                if (find_command_in_path_dynamic(command_name, command_path)) {
                                    char *args[MAX_ARGS + 1];
                                    char expanded_args_storage[MAX_ARGS][INPUT_BUFFER_SIZE];
                                    args[0] = command_path; 
                                    int arg_count = 1;

                                    for (int i = 1; i < num_tokens; ++i) {
                                        if (tokens[i].type == TOKEN_COMMENT) break; 
                                        if (arg_count < MAX_ARGS) {
                                            if (tokens[i].type == TOKEN_STRING) {
                                                char unescaped_val[INPUT_BUFFER_SIZE];
                                                unescape_string(tokens[i].text, unescaped_val, sizeof(unescaped_val));
                                                expand_variables_in_string_advanced(unescaped_val, expanded_args_storage[arg_count-1], INPUT_BUFFER_SIZE);
                                            } else {
                                                expand_variables_in_string_advanced(tokens[i].text, expanded_args_storage[arg_count-1], INPUT_BUFFER_SIZE);
                                            }
                                            args[arg_count++] = expanded_args_storage[arg_count-1];
                                        } else {
                                            fprintf(stderr, "Warning: Too many arguments for command '%s'. Max %d allowed.\n", command_name, MAX_ARGS);
                                            break;
                                        }
                                    }
                                    args[arg_count] = NULL; 

                                    execute_external_command(command_path, args, arg_count, NULL, 0); 
                                } else {
                                    fprintf(stderr, "Command not found: %s (line %d)\n", command_name, current_line_no);
                                }
                            } else {
                                fprintf(stderr, "Command not found or syntax error: %s\n", tokens[0].text);
                            }
                        }                        
                    }
                }
            }
        }
    }
    // 3. Line is not assignment and not starting with a known command word.
    //    Assume it's a standalone expression to be evaluated.
    else {
        char expression_result_buffer[INPUT_BUFFER_SIZE];
        if (evaluate_expression_from_tokens(tokens, num_tokens, expression_result_buffer, sizeof(expression_result_buffer))) {
            if (strlen(expression_result_buffer) > 0 && /* ... more positive checks or fewer error checks ... */
                 strncmp(expression_result_buffer, "EXPR_PARSE_ERROR", strlen("EXPR_PARSE_ERROR")) != 0 &&
                 strncmp(expression_result_buffer, "BSH_HANDLER_NOT_FOUND", strlen("BSH_HANDLER_NOT_FOUND")) !=0 ) {
                printf("%s\n", expression_result_buffer);
            }
            set_variable_scoped("LAST_OP_RESULT", expression_result_buffer, false);
        } else {
            // Error already printed by evaluator, or in buffer
            fprintf(stderr, "bsh: Failed to evaluate expression starting with '%s' (line %d)\n", tokens[0].text, current_line_no);
            set_variable_scoped("LAST_OP_RESULT", expression_result_buffer, false); // Store error
        }
    }
}

// --- handle_assignment_advanced needs to use the new expression evaluator for RHS ---
void handle_assignment_advanced(Token *tokens, int num_tokens) {
    if (num_tokens < 3 || tokens[0].type != TOKEN_VARIABLE ) { /* Basic syntax check */ return; }
    // Operator at tokens[1] should be "=" (or its equivalent if defined differently)
    if (current_exec_state == STATE_BLOCK_SKIP) return;

    // LHS (variable name or array element)
    char var_token_text_copy[MAX_VAR_NAME_LEN * 2]; 
    strncpy(var_token_text_copy, tokens[0].text + 1, sizeof(var_token_text_copy) -1); 
    var_token_text_copy[sizeof(var_token_text_copy)-1] = '\0';

    char base_var_name[MAX_VAR_NAME_LEN]; char index_str_raw[MAX_VAR_NAME_LEN] = ""; bool is_array_assignment = false;
    // ... (logic to parse base_var_name and index_str_raw from var_token_text_copy for arrays - similar to original)
    char* bracket_ptr = strchr(var_token_text_copy, '[');
    if (bracket_ptr) {
        char* end_bracket_ptr = strrchr(bracket_ptr, ']');
        if (end_bracket_ptr && end_bracket_ptr > bracket_ptr) {
            is_array_assignment = true;
            size_t base_len = bracket_ptr - var_token_text_copy;
            strncpy(base_var_name, var_token_text_copy, base_len); base_var_name[base_len] = '\0';
            size_t index_len = end_bracket_ptr - (bracket_ptr + 1);
            strncpy(index_str_raw, bracket_ptr + 1, index_len); index_str_raw[index_len] = '\0';
        } else { fprintf(stderr, "Malformed array assignment: %s\n", tokens[0].text); return; }
    } else { strncpy(base_var_name, var_token_text_copy, MAX_VAR_NAME_LEN - 1); base_var_name[MAX_VAR_NAME_LEN - 1] = '\0'; }


    // RHS: Evaluate tokens from index 2 onwards
    char rhs_value_buffer[INPUT_BUFFER_SIZE];
    if (num_tokens > 2) { // If there is an RHS
        if (!evaluate_expression_from_tokens(&tokens[2], num_tokens - 2, rhs_value_buffer, sizeof(rhs_value_buffer))) {
            // Evaluation failed, error already printed or in rhs_value_buffer.
            // Optionally, set target variable to error string or do nothing.
            // For now, let's proceed to set whatever is in rhs_value_buffer (could be an error marker string).
            fprintf(stderr, "Error evaluating RHS for assignment to '%s'. Result: %s\n", base_var_name, rhs_value_buffer);
            // Decide if assignment should still happen with the error string, or if it should be skipped.
            // Let's assign the error string for now, so it's visible.
        }
    } else { // No RHS (e.g., $var =), set to empty string
        rhs_value_buffer[0] = '\0';
    }
    
    // Check for "object:" or "json:" prefix on the evaluated RHS result
    bool structured_data_parsed = false;
    const char* data_to_parse = NULL;
    const char* detected_prefix_str = NULL;

    if (strncmp(rhs_value_buffer, OBJECT_STDOUT_PREFIX, strlen(OBJECT_STDOUT_PREFIX)) == 0) {
        data_to_parse = rhs_value_buffer + strlen(OBJECT_STDOUT_PREFIX);
        detected_prefix_str = OBJECT_STDOUT_PREFIX; //
        structured_data_parsed = true;
    } else if (strncmp(rhs_value_buffer, JSON_STDOUT_PREFIX, strlen(JSON_STDOUT_PREFIX)) == 0) {
        data_to_parse = rhs_value_buffer + strlen(JSON_STDOUT_PREFIX);
        detected_prefix_str = JSON_STDOUT_PREFIX; //
        structured_data_parsed = true;
    }

    if (structured_data_parsed) {
        int current_scope_id_for_obj = (scope_stack_top >= 0) ? scope_stack[scope_stack_top].scope_id : GLOBAL_SCOPE_ID;
        parse_and_flatten_bsh_object_string(data_to_parse, base_var_name, current_scope_id_for_obj); //
        
        // The main variable ($base_var_name) can be set to the raw data (minus prefix) or a special marker.
        // Let's use the raw data (minus prefix).
        memmove(rhs_value_buffer, (char*)data_to_parse, strlen(data_to_parse) + 1);
    }

    // Perform the assignment
    if (is_array_assignment) {
        set_array_element_scoped(base_var_name, index_str_raw, rhs_value_buffer);
    } else {
        set_variable_scoped(base_var_name, rhs_value_buffer, false);
    }
}

// Conditions for if/while will use evaluate_expression_from_tokens
void handle_if_statement_advanced(Token *tokens, int num_tokens, FILE* input_source, int current_line_no) {
    if (num_tokens < 2) { /* ... syntax error ... */ push_block_bf(BLOCK_TYPE_IF, false, 0, current_line_no); current_exec_state = STATE_BLOCK_SKIP; return; }

    bool condition_is_true = false;
    if (current_exec_state != STATE_BLOCK_SKIP) {
        char condition_result_str[INPUT_BUFFER_SIZE];
        // The condition is from tokens[1] to before '{' or end of line.
        int condition_end_idx = num_tokens -1;
        if (tokens[num_tokens-1].type == TOKEN_LBRACE) condition_end_idx--;
        if (tokens[condition_end_idx].type == TOKEN_COMMENT) condition_end_idx--;


        if (condition_end_idx >= 1) {
            if (evaluate_expression_from_tokens(&tokens[1], (condition_end_idx - 1) + 1,
                                                condition_result_str, sizeof(condition_result_str))) {
                // Evaluate truthiness of condition_result_str
                condition_is_true = (strcmp(condition_result_str, "1") == 0 ||
                                     strcasecmp(condition_result_str, "true") == 0 ||
                                     (strlen(condition_result_str) > 0 && strcmp(condition_result_str,"0") != 0 && strcasecmp(condition_result_str,"false") !=0 ) );
            } else {
                fprintf(stderr, "Error evaluating 'if' condition: %s (line %d)\n", condition_result_str, current_line_no);
                condition_is_true = false; // Treat evaluation error as false condition
            }
        } else { // No condition tokens after "if"
             fprintf(stderr, "Syntax error for 'if': Missing condition (line %d)\n", current_line_no);
             condition_is_true = false;
        }
    }

    push_block_bf(BLOCK_TYPE_IF, condition_is_true, 0, current_line_no);
    if (condition_is_true && current_exec_state != STATE_BLOCK_SKIP) { current_exec_state = STATE_BLOCK_EXECUTE; }
    else { current_exec_state = STATE_BLOCK_SKIP; }    

    int condition_token_idx = 1;
    int brace_expected_after_idx = condition_token_idx;
    if (num_tokens >= condition_token_idx + 3 && tokens[condition_token_idx + 1].type == TOKEN_OPERATOR) {
        brace_expected_after_idx = condition_token_idx + 2; 
    }
    int last_substantive_token_idx_before_brace_or_comment = brace_expected_after_idx;

    if (num_tokens > last_substantive_token_idx_before_brace_or_comment + 1 && tokens[last_substantive_token_idx_before_brace_or_comment+1].type == TOKEN_LBRACE) {
    } else if (num_tokens == last_substantive_token_idx_before_brace_or_comment + 1) {
    } else if (num_tokens > last_substantive_token_idx_before_brace_or_comment + 1 && tokens[num_tokens-1].type == TOKEN_LBRACE) {
    } else if (tokens[num_tokens-1].type == TOKEN_COMMENT && num_tokens-1 == last_substantive_token_idx_before_brace_or_comment +1){
    }
    else if (num_tokens > last_substantive_token_idx_before_brace_or_comment + 1) { 
         fprintf(stderr, "Syntax error for 'if': Unexpected tokens after condition/expression. '{' expected or end of line.\n");
    }
}

// --- Path Management Implementations ---
void add_path_to_list(PathDirNode **list_head, const char* dir_path) {
    PathDirNode *new_node = (PathDirNode*)malloc(sizeof(PathDirNode));
    if (!new_node) {
        perror("bsh: malloc for path node failed");
        return;
    }
    new_node->path = strdup(dir_path);
    if (!new_node->path) {
        perror("bsh: strdup for path string failed");
        free(new_node);
        return;
    }
    new_node->next = *list_head;
    *list_head = new_node;
}

void free_path_dir_list(PathDirNode **list_head) {
    PathDirNode *current = *list_head;
    PathDirNode *next_node;
    while (current) {
        next_node = current->next;
        if(current->path) free(current->path);
        free(current);
        current = next_node;
    }
    *list_head = NULL;
}

void initialize_shell() {
    scope_stack_top = -1; 
    enter_scope();        

    // Initialize core structural operators if they are not dynamically defined
    initialize_operators_core_structural(); // Call the new initializer

    // Populate PATH list from environment variable
    char *path_env = getenv("PATH"); //
    if (path_env) { //
        char *path_copy = strdup(path_env); //
        if (path_copy) { //
            char *token_path = strtok(path_copy, ":"); //
            while (token_path) { //
                add_path_to_list(&path_list_head, token_path); //
                token_path = strtok(NULL, ":"); //
            }
            free(path_copy); //
        } else {
            perror("bsh: strdup for PATH failed in initialize_shell"); //
        }
    }

    initialize_module_path();  //

    set_variable_scoped("SHELL_VERSION", "bsh-dynamic-expr-0.9", false); // Updated version
    set_variable_scoped("PS1", "bsh", false);  //

    char* initial_module_path_env = getenv("BSH_MODULE_PATH"); //
    if (!initial_module_path_env || strlen(initial_module_path_env) == 0) { //
        initial_module_path_env = DEFAULT_MODULE_PATH; //
    }
    set_variable_scoped("BSH_MODULE_PATH", initial_module_path_env, false); //
    
    char cwd_buffer[PATH_MAX]; //
    if (getcwd(cwd_buffer, sizeof(cwd_buffer)) != NULL) { //
        set_variable_scoped("CWD", cwd_buffer, false); //
    } else { //
        perror("bsh: getcwd() error on init"); //
        set_variable_scoped("CWD", "", false);  //
    }
}

int main(int argc, char *argv[]) {
    initialize_shell(); //

    // Execute default startup script
    char startup_script_path[MAX_FULL_PATH_LEN]; //
    char* home_dir = getenv("HOME"); //
    bool startup_executed = false; //
    if (home_dir) { //
        snprintf(startup_script_path, sizeof(startup_script_path), "%s/%s", home_dir, DEFAULT_STARTUP_SCRIPT); //
        if (access(startup_script_path, F_OK) == 0) { //
            execute_script(startup_script_path, false, true);  //
            startup_executed = true; //
        }
    }
    if (!startup_executed) {  //
         if (access(DEFAULT_STARTUP_SCRIPT, F_OK) == 0) { //
            execute_script(DEFAULT_STARTUP_SCRIPT, false, true); //
        }
    }

    if (argc > 1) {  //
        execute_script(argv[1], false, false);  //
    } else { // Interactive mode
        char line_buffer[INPUT_BUFFER_SIZE]; //
        char prompt_buffer[MAX_VAR_NAME_LEN + 30];  //
        int line_counter_interactive = 0; //

        while (1) { //
            // Reset return state for each interactive command
            bsh_return_value_is_set = false;
            current_exec_state = STATE_NORMAL; // Ensure normal state for new prompt

            char* current_prompt_val = get_variable_scoped("PS1"); //
            if (!current_prompt_val || strlen(current_prompt_val) == 0) { //
                current_prompt_val = "bsh";  //
            }

            char state_indicator[35] = "";  //
            if (block_stack_top_bf >= 0) {
                BlockFrame* top_block = peek_block_bf();
                const char* block_type_str = "unknown";
                if (top_block) {
                    if (top_block->type == BLOCK_TYPE_IF) block_type_str = "if";
                    else if (top_block->type == BLOCK_TYPE_ELSE) block_type_str = "else";
                    else if (top_block->type == BLOCK_TYPE_WHILE) block_type_str = "while";
                    else if (top_block->type == BLOCK_TYPE_FUNCTION_DEF) block_type_str = "defunc_body";
                }

                if (current_exec_state == STATE_BLOCK_SKIP) {
                    snprintf(state_indicator, sizeof(state_indicator), "(skip %s %d)", block_type_str, block_stack_top_bf + 1);
                } else if (current_exec_state == STATE_DEFINE_FUNC_BODY && current_function_definition) {
                     snprintf(state_indicator, sizeof(state_indicator), "(defunc %s)", current_function_definition->name);
                } else if (top_block) { 
                    snprintf(state_indicator, sizeof(state_indicator), "(%s %d)", block_type_str, block_stack_top_bf + 1);
                }
            } else if (current_exec_state == STATE_DEFINE_FUNC_BODY && current_function_definition) {
                snprintf(state_indicator, sizeof(state_indicator), "(defunc %s...)", current_function_definition->name);
            }

            snprintf(prompt_buffer, sizeof(prompt_buffer), "%s%s> ", current_prompt_val, state_indicator); //
            printf("%s", prompt_buffer); //

            if (!fgets(line_buffer, sizeof(line_buffer), stdin)) { //
                printf("\n");  //
                break; //
            }
            line_counter_interactive++; //
            process_line(line_buffer, stdin, line_counter_interactive, STATE_NORMAL); //

            if (bsh_return_value_is_set && current_exec_state == STATE_RETURN_REQUESTED) {
                // Handle 'exit' from interactive prompt
                long exit_code_val = 0;
                if (strlen(bsh_last_return_value) > 0) {
                    exit_code_val = strtol(bsh_last_return_value, NULL, 10);
                }
                cleanup_shell();
                // printf("Exiting shell with status %ld (from interactive 'exit').\n", exit_code_val);
                return exit_code_val;
            }

        }
    }

    cleanup_shell(); //
    return 0; //
}

/////
///// Missing implementations
/////

void handle_while_statement_advanced(Token *tokens, int num_tokens, FILE* input_source, int current_line_no) {
    if (num_tokens < 2) {
        fprintf(stderr, "Syntax error for 'while'. Expected: while [!] <condition_value_or_variable_or_expr> [{]\n");
        if (block_stack_top_bf < MAX_NESTING_DEPTH -1 && current_exec_state != STATE_BLOCK_SKIP) {
           push_block_bf(BLOCK_TYPE_WHILE, false, get_file_pos(input_source), current_line_no); current_exec_state = STATE_BLOCK_SKIP;
        } return;
    }

    bool condition_result = false;
    bool negate_result = false;
    int condition_token_idx = 1;
    long loop_fpos_at_while_line = get_file_pos(input_source); 
    
    if (current_exec_state != STATE_BLOCK_SKIP) {
        if (tokens[1].type == TOKEN_OPERATOR && strcmp(tokens[1].text, "!") == 0) {
            if (num_tokens < 3) {
                fprintf(stderr, "Syntax error for 'while !'. Expected: while ! <condition_value_or_variable_or_expr> [{]\n");
                 if (block_stack_top_bf < MAX_NESTING_DEPTH -1) {
                    push_block_bf(BLOCK_TYPE_WHILE, false, loop_fpos_at_while_line, current_line_no); current_exec_state = STATE_BLOCK_SKIP;
                }
                return;
            }
            negate_result = true;
            condition_token_idx = 2;
        }

        if (num_tokens >= condition_token_idx + 3 && tokens[condition_token_idx + 1].type == TOKEN_OPERATOR) {
             condition_result = evaluate_condition_advanced(&tokens[condition_token_idx], &tokens[condition_token_idx+1], &tokens[condition_token_idx+2]);
        } else { 
            char condition_value_expanded[INPUT_BUFFER_SIZE];
            if (tokens[condition_token_idx].type == TOKEN_STRING) {
                char unescaped[INPUT_BUFFER_SIZE];
                unescape_string(tokens[condition_token_idx].text, unescaped, sizeof(unescaped));
                expand_variables_in_string_advanced(unescaped, condition_value_expanded, sizeof(condition_value_expanded));
            } else {
                expand_variables_in_string_advanced(tokens[condition_token_idx].text, condition_value_expanded, sizeof(condition_value_expanded));
            }
            condition_result = (strcmp(condition_value_expanded, "1") == 0 || 
                                (strcmp(condition_value_expanded, "true") == 0) ||
                                (strlen(condition_value_expanded) > 0 && strcmp(condition_value_expanded,"0") != 0 && strcmp(condition_value_expanded,"false") !=0 ) );
        }

        if (negate_result) {
            condition_result = !condition_result;
        }
    }

    push_block_bf(BLOCK_TYPE_WHILE, condition_result, loop_fpos_at_while_line, current_line_no);
    if (condition_result && current_exec_state != STATE_BLOCK_SKIP) {
        current_exec_state = STATE_BLOCK_EXECUTE;
    } else {
        current_exec_state = STATE_BLOCK_SKIP;
    }
    
    int brace_expected_after_idx = condition_token_idx;
    if (num_tokens >= condition_token_idx + 3 && tokens[condition_token_idx + 1].type == TOKEN_OPERATOR) {
        brace_expected_after_idx = condition_token_idx + 2; 
    }

    int last_substantive_token_idx_before_brace_or_comment = brace_expected_after_idx;

    if (num_tokens > last_substantive_token_idx_before_brace_or_comment + 1 && tokens[last_substantive_token_idx_before_brace_or_comment+1].type == TOKEN_LBRACE) {}
    else if (num_tokens == last_substantive_token_idx_before_brace_or_comment + 1) {}
    else if (tokens[num_tokens-1].type == TOKEN_COMMENT && num_tokens-1 == last_substantive_token_idx_before_brace_or_comment +1){}
    else if (num_tokens > last_substantive_token_idx_before_brace_or_comment + 1) {
         fprintf(stderr, "Syntax error for 'while': Unexpected tokens after condition/expression. '{' expected or end of line.\n");
    }
}

void handle_else_statement_advanced(Token *tokens, int num_tokens, FILE* input_source, int current_line_no) {
    BlockFrame* prev_block_frame = peek_block_bf();
    if (!prev_block_frame || (prev_block_frame->type != BLOCK_TYPE_IF && prev_block_frame->type != BLOCK_TYPE_ELSE)) {
        fprintf(stderr, "Error: 'else' without a preceding 'if' or 'else if' block on line %d.\n", current_line_no);
        if (current_exec_state != STATE_BLOCK_SKIP) { 
            current_exec_state = STATE_BLOCK_SKIP; 
        } return;
    }

    BlockFrame closed_if_or_else_if = *pop_block_bf(); 
    bool execute_this_else_branch = false;

    if (closed_if_or_else_if.condition_true) { 
        execute_this_else_branch = false;
    } else { 
        if (num_tokens > 1 && tokens[1].type == TOKEN_WORD && strcmp(resolve_keyword_alias(tokens[1].text), "if") == 0) { 
            int condition_token_idx = 2; 
            bool negate_result = false;

            if (num_tokens < 3) { 
                fprintf(stderr, "Syntax error for 'else if'. Expected: else if [!] <condition_value_or_variable_or_expr> [{]\n");
                execute_this_else_branch = false; 
            } else {
                if (tokens[2].type == TOKEN_OPERATOR && strcmp(tokens[2].text, "!") == 0) { 
                    if (num_tokens < 4) { 
                        fprintf(stderr, "Syntax error for 'else if !'. Expected: else if ! <condition_value_or_variable_or_expr> [{]\n");
                        execute_this_else_branch = false;
                    } else {
                        negate_result = true;
                        condition_token_idx = 3; 
                    }
                }
                if (execute_this_else_branch == false && !(negate_result && num_tokens <4) && !(num_tokens <3) ) { 
                    if (current_exec_state != STATE_BLOCK_SKIP) { 
                        if (num_tokens >= condition_token_idx + 3 && tokens[condition_token_idx + 1].type == TOKEN_OPERATOR) {
                             execute_this_else_branch = evaluate_condition_advanced(&tokens[condition_token_idx], &tokens[condition_token_idx+1], &tokens[condition_token_idx+2]);
                        } else { 
                            char condition_value_expanded[INPUT_BUFFER_SIZE];
                            if (tokens[condition_token_idx].type == TOKEN_STRING) {
                                char unescaped[INPUT_BUFFER_SIZE];
                                unescape_string(tokens[condition_token_idx].text, unescaped, sizeof(unescaped));
                                expand_variables_in_string_advanced(unescaped, condition_value_expanded, sizeof(condition_value_expanded));
                            } else {
                                expand_variables_in_string_advanced(tokens[condition_token_idx].text, condition_value_expanded, sizeof(condition_value_expanded));
                            }
                             execute_this_else_branch = (strcmp(condition_value_expanded, "1") == 0 || 
                                (strcmp(condition_value_expanded, "true") == 0) ||
                                (strlen(condition_value_expanded) > 0 && strcmp(condition_value_expanded,"0") != 0 && strcmp(condition_value_expanded,"false") !=0 ) );
                        }
                        if (negate_result) execute_this_else_branch = !execute_this_else_branch;
                    } else { 
                        execute_this_else_branch = false;
                    }
                }
            }
        } else { 
            execute_this_else_branch = true; 
        }
    }

    push_block_bf(BLOCK_TYPE_ELSE, execute_this_else_branch, 0, current_line_no);
    if (execute_this_else_branch && current_exec_state != STATE_BLOCK_SKIP) { 
        current_exec_state = STATE_BLOCK_EXECUTE;
    } else {
        current_exec_state = STATE_BLOCK_SKIP;
    }

    int base_token_count_for_brace_check = 1; 
    if (num_tokens > 1 && tokens[1].type == TOKEN_WORD && strcmp(resolve_keyword_alias(tokens[1].text), "if") == 0) { 
        base_token_count_for_brace_check = 2; 
        if (num_tokens > 2 && tokens[2].type == TOKEN_OPERATOR && strcmp(tokens[2].text, "!") == 0) { 
             base_token_count_for_brace_check = 3; 
        }
        if (num_tokens >= base_token_count_for_brace_check + 3 && tokens[base_token_count_for_brace_check + 1].type == TOKEN_OPERATOR) {
            base_token_count_for_brace_check += 2; 
        }
        base_token_count_for_brace_check++; 
    }

    if (num_tokens > base_token_count_for_brace_check && tokens[base_token_count_for_brace_check].type == TOKEN_LBRACE) {  }
    else if (num_tokens == base_token_count_for_brace_check) {  }
    else if (num_tokens > base_token_count_for_brace_check && tokens[num_tokens-1].type == TOKEN_LBRACE) {  }
    else if (tokens[num_tokens-1].type == TOKEN_COMMENT && num_tokens-1 == base_token_count_for_brace_check){}
    else if (num_tokens > base_token_count_for_brace_check && tokens[base_token_count_for_brace_check].type != TOKEN_COMMENT) { 
        fprintf(stderr, "Syntax error for 'else'/'else if' on line %d: Unexpected tokens after condition/expression. '{' expected or end of line.\n", current_line_no);
    }
}

void handle_defunc_statement_advanced(Token *tokens, int num_tokens) {
    if (num_tokens < 2 || tokens[1].type != TOKEN_WORD) {
        fprintf(stderr, "Syntax: defunc <funcname> [(param1 ...)] [{]\n"); return;
    }
    if (is_defining_function && current_exec_state != STATE_IMPORT_PARSING) {
        fprintf(stderr, "Error: Cannot nest function definitions during normal execution.\n"); return;
    }
    if (current_exec_state == STATE_BLOCK_SKIP && current_exec_state != STATE_IMPORT_PARSING) {
        push_block_bf(BLOCK_TYPE_FUNCTION_DEF, false, 0, 0); return; 
    }

    current_function_definition = (UserFunction*)malloc(sizeof(UserFunction));
    if (!current_function_definition) { perror("malloc for function definition failed"); return; }
    memset(current_function_definition, 0, sizeof(UserFunction));
    strncpy(current_function_definition->name, tokens[1].text, MAX_VAR_NAME_LEN - 1);

    int token_idx = 2;
    if (token_idx < num_tokens && tokens[token_idx].type == TOKEN_LPAREN) {
        token_idx++; 
        while(token_idx < num_tokens && tokens[token_idx].type != TOKEN_RPAREN) {
            if (tokens[token_idx].type == TOKEN_WORD) {
                if (current_function_definition->param_count < MAX_FUNC_PARAMS) {
                    strncpy(current_function_definition->params[current_function_definition->param_count++], tokens[token_idx].text, MAX_VAR_NAME_LEN -1);
                } else { fprintf(stderr, "Too many parameters for function %s.\n", current_function_definition->name); free(current_function_definition); current_function_definition = NULL; return; }
            } else if (tokens[token_idx].type == TOKEN_COMMENT) { 
                break; 
            }else { fprintf(stderr, "Syntax error in function parameters: Expected word for %s, got '%s'.\n", current_function_definition->name, tokens[token_idx].text); free(current_function_definition); current_function_definition = NULL; return; }
            token_idx++;
        }
        if (token_idx < num_tokens && tokens[token_idx].type == TOKEN_RPAREN) token_idx++; 
        else if (!(token_idx < num_tokens && tokens[token_idx].type == TOKEN_COMMENT)) { 
             fprintf(stderr, "Syntax error in function parameters: missing ')' for %s.\n", current_function_definition->name); free(current_function_definition); current_function_definition = NULL; return; 
        }
    }
    while(token_idx < num_tokens && tokens[token_idx].type == TOKEN_COMMENT) {
        token_idx++;
    }

    if (token_idx < num_tokens && tokens[token_idx].type == TOKEN_LBRACE) { 
        is_defining_function = true;
        if (current_exec_state != STATE_IMPORT_PARSING) current_exec_state = STATE_DEFINE_FUNC_BODY;
        push_block_bf(BLOCK_TYPE_FUNCTION_DEF, true, 0, 0); 
    } else if (token_idx == num_tokens) { 
        is_defining_function = true;
        if (current_exec_state != STATE_IMPORT_PARSING) current_exec_state = STATE_DEFINE_FUNC_BODY;
    } else {
        fprintf(stderr, "Syntax error in function definition: '{' expected for %s, got '%s'.\n", current_function_definition->name, tokens[token_idx].text);
        free(current_function_definition); current_function_definition = NULL;
    }
}

void handle_inc_dec_statement_advanced(Token *tokens, int num_tokens, bool increment) {
    // ... (remains the same, this is for 'inc'/'dec' keywords)
    if (num_tokens != 2 || (tokens[1].type != TOKEN_VARIABLE && tokens[1].type != TOKEN_WORD)) {
        fprintf(stderr, "Syntax: %s <$varname_or_varname | $arr[idx]>\n", increment ? "inc" : "dec"); return;
    }
    if (current_exec_state == STATE_BLOCK_SKIP) return;

    const char* var_name_token_text = tokens[1].text;
    char var_name_or_base[MAX_VAR_NAME_LEN];
    bool is_array_op = false;
    char index_raw[MAX_VAR_NAME_LEN] = "";

    if (tokens[1].type == TOKEN_VARIABLE) { 
        char temp_text[MAX_VAR_NAME_LEN * 2]; 
        strncpy(temp_text, var_name_token_text + 1, sizeof(temp_text)-1); temp_text[sizeof(temp_text)-1] = '\0';
        char* bracket = strchr(temp_text, '[');
        if (bracket) {
            char* end_bracket = strrchr(bracket, ']');
            if (end_bracket && end_bracket > bracket + 1) { 
                is_array_op = true;
                size_t base_len = bracket - temp_text;
                strncpy(var_name_or_base, temp_text, base_len); var_name_or_base[base_len] = '\0';
                size_t index_len = end_bracket - (bracket + 1);
                strncpy(index_raw, bracket + 1, index_len); index_raw[index_len] = '\0';
            } else { fprintf(stderr, "Malformed array index in %s: %s\n", increment ? "inc" : "dec", var_name_token_text); return; }
        } else { strncpy(var_name_or_base, temp_text, MAX_VAR_NAME_LEN -1); var_name_or_base[MAX_VAR_NAME_LEN-1] = '\0'; }
    } else { 
        strncpy(var_name_or_base, var_name_token_text, MAX_VAR_NAME_LEN -1); var_name_or_base[MAX_VAR_NAME_LEN-1] = '\0';
    }

    char* current_val_str;
    char expanded_index_for_array_op[INPUT_BUFFER_SIZE]; 

    if (is_array_op) {
        if (index_raw[0] == '"' && index_raw[strlen(index_raw)-1] == '"') {
            char unescaped_idx[INPUT_BUFFER_SIZE];
            unescape_string(index_raw, unescaped_idx, sizeof(unescaped_idx));
            expand_variables_in_string_advanced(unescaped_idx, expanded_index_for_array_op, sizeof(expanded_index_for_array_op));
        } else if (index_raw[0] == '$') {
            expand_variables_in_string_advanced(index_raw, expanded_index_for_array_op, sizeof(expanded_index_for_array_op));
        } else { 
            strncpy(expanded_index_for_array_op, index_raw, sizeof(expanded_index_for_array_op)-1);
            expanded_index_for_array_op[sizeof(expanded_index_for_array_op)-1] = '\0';
        }
        current_val_str = get_array_element_scoped(var_name_or_base, expanded_index_for_array_op);
    } else { 
        current_val_str = get_variable_scoped(var_name_or_base);
    }

    long current_val = 0;
    if (current_val_str) {
        char *endptr; errno = 0;
        current_val = strtol(current_val_str, &endptr, 10);
        if (errno != 0 || *current_val_str == '\0' || *endptr != '\0') {
            fprintf(stderr, "Warning: Variable/element '%s%s%s%s%s' ('%s') is not a valid integer for %s. Treating as 0.\n",
                tokens[1].type == TOKEN_VARIABLE ? "$" : "", var_name_or_base, 
                is_array_op ? "[" : "", is_array_op ? expanded_index_for_array_op : "", is_array_op ? "]" : "",
                current_val_str ? current_val_str : "NULL", increment ? "inc" : "dec");
            current_val = 0;
        }
    }
    current_val += (increment ? 1 : -1);
    char new_val_str[MAX_VAR_NAME_LEN]; 
    snprintf(new_val_str, sizeof(new_val_str), "%ld", current_val);

    if (is_array_op) set_array_element_scoped(var_name_or_base, expanded_index_for_array_op, new_val_str);
    else set_variable_scoped(var_name_or_base, new_val_str, false);
}

void handle_loadlib_statement(Token *tokens, int num_tokens) {
    if (num_tokens != 3) { fprintf(stderr, "Syntax: loadlib <path_or_$var> <alias_or_$var>\n"); return; }
    if (current_exec_state == STATE_BLOCK_SKIP) return;
    char lib_path[MAX_FULL_PATH_LEN], alias[MAX_VAR_NAME_LEN];
    
    if (tokens[1].type == TOKEN_STRING) {
        char unescaped[INPUT_BUFFER_SIZE];
        unescape_string(tokens[1].text, unescaped, sizeof(unescaped));
        expand_variables_in_string_advanced(unescaped, lib_path, sizeof(lib_path));
    } else { 
        expand_variables_in_string_advanced(tokens[1].text, lib_path, sizeof(lib_path));
    }
    
    if (tokens[2].type == TOKEN_STRING) {
        char unescaped[INPUT_BUFFER_SIZE];
        unescape_string(tokens[2].text, unescaped, sizeof(unescaped));
        expand_variables_in_string_advanced(unescaped, alias, sizeof(alias));
    } else { 
        expand_variables_in_string_advanced(tokens[2].text, alias, sizeof(alias));
    }

    if (strlen(lib_path) == 0 || strlen(alias) == 0) { fprintf(stderr, "loadlib error: Path or alias is empty.\n"); return; }
    DynamicLib* current_lib = loaded_libs; while(current_lib) { if (strcmp(current_lib->alias, alias) == 0) { fprintf(stderr, "Error: Lib alias '%s' in use.\n", alias); return; } current_lib = current_lib->next; }
    void *handle = dlopen(lib_path, RTLD_LAZY | RTLD_GLOBAL);
    if (!handle) { fprintf(stderr, "Error loading library '%s': %s\n", lib_path, dlerror()); return; }
    DynamicLib *new_lib_entry = (DynamicLib*)malloc(sizeof(DynamicLib));
    if (!new_lib_entry) { perror("malloc for new_lib_entry failed"); dlclose(handle); return; }
    strncpy(new_lib_entry->alias, alias, MAX_VAR_NAME_LEN -1); new_lib_entry->alias[MAX_VAR_NAME_LEN-1] = '\0';
    new_lib_entry->handle = handle; new_lib_entry->next = loaded_libs; loaded_libs = new_lib_entry;
}

void handle_calllib_statement(Token *tokens, int num_tokens) {
    if (num_tokens < 3) { fprintf(stderr, "Syntax: calllib <alias> <func_name> [args...]\n"); return; }
    if (current_exec_state == STATE_BLOCK_SKIP) return;
    char alias[MAX_VAR_NAME_LEN], func_name[MAX_VAR_NAME_LEN];

    if (tokens[1].type == TOKEN_STRING) {
        char unescaped[INPUT_BUFFER_SIZE];
        unescape_string(tokens[1].text, unescaped, sizeof(unescaped));
        expand_variables_in_string_advanced(unescaped, alias, sizeof(alias));
    } else { 
        expand_variables_in_string_advanced(tokens[1].text, alias, sizeof(alias));
    }

    if (tokens[2].type == TOKEN_STRING) {
        char unescaped[INPUT_BUFFER_SIZE];
        unescape_string(tokens[2].text, unescaped, sizeof(unescaped));
        expand_variables_in_string_advanced(unescaped, func_name, sizeof(func_name));
    } else { 
        expand_variables_in_string_advanced(tokens[2].text, func_name, sizeof(func_name));
    }

    if (strlen(alias) == 0 || strlen(func_name) == 0) { fprintf(stderr, "calllib error: Alias or func name empty.\n"); return; }
    DynamicLib* lib_entry = loaded_libs; void* lib_handle = NULL;
    while(lib_entry) { if (strcmp(lib_entry->alias, alias) == 0) { lib_handle = lib_entry->handle; break; } lib_entry = lib_entry->next; }
    if (!lib_handle) { fprintf(stderr, "Error: Library alias '%s' not found.\n", alias); return; }
    dlerror(); void* func_ptr = dlsym(lib_handle, func_name); char* dlsym_error = dlerror();
    if (dlsym_error != NULL) { fprintf(stderr, "Error finding func '%s' in lib '%s': %s\n", func_name, alias, dlsym_error); return; }
    if (!func_ptr) { fprintf(stderr, "Error finding func '%s' (ptr NULL, no dlerror).\n", func_name); return; }

    typedef int (*lib_func_sig_t)(int, char**, char*, int); 
    lib_func_sig_t target_func = (lib_func_sig_t)func_ptr;
    int lib_argc = num_tokens - 3;
    char* lib_argv_expanded_storage[MAX_ARGS][INPUT_BUFFER_SIZE]; char* lib_argv[MAX_ARGS + 1];
    for(int i=0; i < lib_argc; ++i) {
        if (tokens[i+3].type == TOKEN_STRING) { char unescaped[INPUT_BUFFER_SIZE]; unescape_string(tokens[i+3].text, unescaped, sizeof(unescaped)); expand_variables_in_string_advanced(unescaped, lib_argv_expanded_storage[i], INPUT_BUFFER_SIZE);
        } else { expand_variables_in_string_advanced(tokens[i+3].text, lib_argv_expanded_storage[i], INPUT_BUFFER_SIZE); }
        lib_argv[i] = lib_argv_expanded_storage[i];
    } lib_argv[lib_argc] = NULL;
    char lib_output_buffer[INPUT_BUFFER_SIZE]; lib_output_buffer[0] = '\0';
    int lib_status = target_func(lib_argc, lib_argv, lib_output_buffer, sizeof(lib_output_buffer));
    char status_str[12]; snprintf(status_str, sizeof(status_str), "%d", lib_status);
    set_variable_scoped("LAST_LIB_CALL_STATUS", status_str, false);
    set_variable_scoped("LAST_LIB_CALL_OUTPUT", lib_output_buffer, false);
}

void handle_import_statement(Token *tokens, int num_tokens) {
    if (current_exec_state == STATE_BLOCK_SKIP && current_exec_state != STATE_IMPORT_PARSING) { 
        return;
    }

    if (num_tokens < 2) {
        fprintf(stderr, "Syntax: import <module_name_or_path>\n");
        return;
    }

    char module_spec_expanded[MAX_FULL_PATH_LEN];
    if (tokens[1].type == TOKEN_STRING) {
        char unescaped_module_spec[MAX_FULL_PATH_LEN];
        unescape_string(tokens[1].text, unescaped_module_spec, sizeof(unescaped_module_spec));
        expand_variables_in_string_advanced(unescaped_module_spec, module_spec_expanded, sizeof(module_spec_expanded));
    } else { 
        expand_variables_in_string_advanced(tokens[1].text, module_spec_expanded, sizeof(module_spec_expanded));
    }
    
    if (strlen(module_spec_expanded) == 0) {
        fprintf(stderr, "Error: import statement received an empty module path/name after expansion.\n");
        return;
    }

    char full_module_path[MAX_FULL_PATH_LEN];
    if (find_module_in_path(module_spec_expanded, full_module_path)) {
        ExecutionState previous_exec_state = current_exec_state;
        current_exec_state = STATE_IMPORT_PARSING; 

        execute_script(full_module_path, true, false); 

        current_exec_state = previous_exec_state; 
    } else {
        fprintf(stderr, "Error: Module '%s' not found for import.\n", module_spec_expanded);
    }
}

void handle_defkeyword_statement(Token *tokens, int num_tokens) {
    if (num_tokens != 3 || tokens[1].type != TOKEN_WORD || tokens[2].type != TOKEN_WORD) {
        fprintf(stderr, "Syntax: defkeyword <original_keyword> <new_alias>\n"); return;
    }
    if (current_exec_state == STATE_BLOCK_SKIP) return;
    add_keyword_alias(tokens[1].text, tokens[2].text);
}

void handle_update_cwd_statement(Token *tokens, int num_tokens) {
    if (current_exec_state == STATE_BLOCK_SKIP) return;

    if (num_tokens != 1) {
        fprintf(stderr, "Syntax: update_cwd (takes no arguments)\n");
        return;
    }

    char cwd_buffer[PATH_MAX];
    if (getcwd(cwd_buffer, sizeof(cwd_buffer)) != NULL) {
        set_variable_scoped("CWD", cwd_buffer, false);
    } else {
        perror("bsh: update_cwd: getcwd() error");
        set_variable_scoped("CWD", "", false); 
    }
}


// For unary ops like $var++ or ++$var
bool invoke_bsh_unary_op_call(const char* func_name_to_call,
                                const char* bsh_arg1_var_name_str,      // Name of the variable to be modified (e.g., "myvar")
                                const char* bsh_arg2_result_holder_var_name, // Name of BSH var to store result (e.g., "__TEMP_UNARY_OP_RES")
                                char* c_result_buffer, size_t c_result_buffer_size) {
    UserFunction* func = function_list;
    while (func) {
        if (strcmp(func->name, func_name_to_call) == 0) break;
        func = func->next;
    }
    if (!func) {
        fprintf(stderr, "Error: BSH internal unary handler function '%s' not found.\n", func_name_to_call);
        snprintf(c_result_buffer, c_result_buffer_size, "NO_UNARY_HANDLER_ERROR");
        return false;
    }

    if (func->param_count != 2) { // BSH function expects (var_name_string, result_holder_name_string)
        fprintf(stderr, "Error: BSH unary handler '%s' has incorrect param count (expected 2, got %d).\n", func_name_to_call, func->param_count);
        snprintf(c_result_buffer, c_result_buffer_size, "UNARY_HANDLER_PARAM_ERROR");
        return false;
    }

    Token call_tokens[2];
    char token_storage_arg1_var_name[MAX_VAR_NAME_LEN]; 
    char token_storage_arg2_res_holder_name[MAX_VAR_NAME_LEN];

    // Argument 1 to BSH function: the name of the variable to modify, passed as a string literal
    strncpy(token_storage_arg1_var_name, bsh_arg1_var_name_str, MAX_VAR_NAME_LEN -1); 
    token_storage_arg1_var_name[MAX_VAR_NAME_LEN-1] = '\0';
    call_tokens[0].type = TOKEN_STRING; 
    call_tokens[0].text = token_storage_arg1_var_name;
    call_tokens[0].len = strlen(token_storage_arg1_var_name);

    // Argument 2 to BSH function: the name of the variable where BSH func will store the "result of the expression"
    strncpy(token_storage_arg2_res_holder_name, bsh_arg2_result_holder_var_name, MAX_VAR_NAME_LEN -1);
    token_storage_arg2_res_holder_name[MAX_VAR_NAME_LEN-1] = '\0';
    call_tokens[1].type = TOKEN_WORD; // Pass this as a variable name (not its value)
    call_tokens[1].text = token_storage_arg2_res_holder_name;
    call_tokens[1].len = strlen(token_storage_arg2_res_holder_name);

    execute_user_function(func, call_tokens, 2, NULL);

    // Retrieve the result from the BSH result holder variable
    char* result_from_bsh = get_variable_scoped(bsh_arg2_result_holder_var_name);
    if (result_from_bsh) {
        strncpy(c_result_buffer, result_from_bsh, c_result_buffer_size - 1);
        c_result_buffer[c_result_buffer_size - 1] = '\0';
    } else {
        // This indicates the BSH handler didn't set the result variable.
        snprintf(c_result_buffer, c_result_buffer_size, "UNARY_OP_NO_RESULT_VAR<%s>", bsh_arg2_result_holder_var_name);
        // For inc/dec, we expect a result, so this is likely an issue in the BSH script.
        return false; 
    }
    return true;
}

// New handler for unary operations like $var++ or ++$var
void handle_unary_op_statement(Token* var_token, Token* op_token, bool is_prefix) {
    if (current_exec_state == STATE_BLOCK_SKIP) return;

    char var_name_clean[MAX_VAR_NAME_LEN];
    // The var_token->text for a TOKEN_VARIABLE will be like "$myvar" or "${myvar}" or "$arr[idx]"
    // We need to extract the actual variable name part for the BSH handler.
    // For simplicity, this example will focus on simple variables like "$myvar".
    // Handling "$arr[idx]++" would require parsing the base name and index here.
    if (var_token->text[0] == '$') {
        if (var_token->text[1] == '{') { // ${varname}
            const char* end_brace = strchr(var_token->text + 2, '}');
            if (end_brace) {
                size_t len = end_brace - (var_token->text + 2);
                if (len < MAX_VAR_NAME_LEN) {
                    strncpy(var_name_clean, var_token->text + 2, len);
                    var_name_clean[len] = '\0';
                } else {
                    fprintf(stderr, "Error: Variable name in ${...} too long for unary op.\n");
                    return;
                }
            } else { // Malformed ${...
                fprintf(stderr, "Error: Malformed ${...} in unary op.\n");
                return;
            }
        } else { // $varname
             // Check for array access $var[index] - this part needs more robust parsing if to be supported directly.
            char* bracket_ptr = strchr(var_token->text + 1, '[');
            if (bracket_ptr) {
                fprintf(stderr, "Error: Unary operator on array element (e.g., $arr[idx]++) is not directly supported by this simple handler. Use 'inc $arr[idx]' or a BSH function.\n");
                // For a full implementation, you'd parse base_var_name and index_str_raw here,
                // then the BSH handler would need to be more complex or you'd have specialized BSH handlers.
                return;
            }
            strncpy(var_name_clean, var_token->text + 1, MAX_VAR_NAME_LEN - 1);
            var_name_clean[MAX_VAR_NAME_LEN - 1] = '\0';
        }
    } else {
        fprintf(stderr, "Error: Unary operator expected a variable (e.g., $var), got '%s'.\n", var_token->text);
        return;
    }
    
    if (strlen(var_name_clean) == 0) {
        fprintf(stderr, "Error: Empty variable name in unary operation.\n");
        return;
    }


    const char* op_str = op_token->text;
    char bsh_handler_name[MAX_VAR_NAME_LEN];

    if (is_prefix) {
        if (strcmp(op_str, "++") == 0) strncpy(bsh_handler_name, "__bsh_prefix_increment", sizeof(bsh_handler_name)-1);
        else if (strcmp(op_str, "--") == 0) strncpy(bsh_handler_name, "__bsh_prefix_decrement", sizeof(bsh_handler_name)-1);
        else { fprintf(stderr, "Internal error: Unknown prefix unary operator '%s'.\n", op_str); return; }
    } else { // Postfix
        if (strcmp(op_str, "++") == 0) strncpy(bsh_handler_name, "__bsh_postfix_increment", sizeof(bsh_handler_name)-1);
        else if (strcmp(op_str, "--") == 0) strncpy(bsh_handler_name, "__bsh_postfix_decrement", sizeof(bsh_handler_name)-1);
        else { fprintf(stderr, "Internal error: Unknown postfix unary operator '%s'.\n", op_str); return; }
    }
    bsh_handler_name[sizeof(bsh_handler_name)-1] = '\0';

    char c_result_buffer[INPUT_BUFFER_SIZE];
    const char* bsh_temp_result_var_name = "__TEMP_UNARY_OP_EXPR_RES"; // BSH var to hold expression's value

    // Call the BSH handler.
    // BSH handler signature: function handler_name (var_to_modify_name_str, result_holder_var_name_str)
    if (invoke_bsh_unary_op_call(bsh_handler_name, 
                                 var_name_clean,          // Pass the clean variable name (e.g., "myvar")
                                 bsh_temp_result_var_name, 
                                 c_result_buffer, sizeof(c_result_buffer))) {
        // The BSH handler performs the side effect (modifies var_name_clean)
        // AND sets bsh_temp_result_var_name to the "value" of the expression.
        set_variable_scoped("LAST_OP_RESULT", c_result_buffer, false);
        // If these operations should print their result when standalone:
        // printf("%s\n", c_result_buffer); 
    } else {
        fprintf(stderr, "Error executing BSH unary op handler '%s' for variable '%s'.\n", bsh_handler_name, var_name_clean);
        set_variable_scoped("LAST_OP_RESULT", "UNARY_OP_HANDLER_ERROR", false);
    }
}


// --- Block Management ---
// ... (push_block_bf, pop_block_bf, peek_block_bf, handle_opening_brace_token, handle_closing_brace_token remain the same)
void push_block_bf(BlockType type, bool condition_true, long loop_start_fpos, int loop_start_line_no) {
    if (block_stack_top_bf >= MAX_NESTING_DEPTH - 1) { fprintf(stderr, "Max block nesting depth exceeded.\n"); return; }
    block_stack_top_bf++;
    block_stack[block_stack_top_bf].type = type;
    block_stack[block_stack_top_bf].condition_true = condition_true;
    block_stack[block_stack_top_bf].loop_start_fpos = loop_start_fpos;
    block_stack[block_stack_top_bf].loop_start_line_no = loop_start_line_no;
    block_stack[block_stack_top_bf].prev_exec_state = current_exec_state;
}

BlockFrame* pop_block_bf() {
    if (block_stack_top_bf < 0) { return NULL; }
    return &block_stack[block_stack_top_bf--];
}

BlockFrame* peek_block_bf() {
    if (block_stack_top_bf < 0) return NULL;
    return &block_stack[block_stack_top_bf];
}

void handle_opening_brace_token(Token token) {
    BlockFrame* current_block_frame = peek_block_bf();
    if (!current_block_frame) { 
        if (is_defining_function && current_function_definition && current_exec_state != STATE_BLOCK_SKIP) {
            push_block_bf(BLOCK_TYPE_FUNCTION_DEF, true, 0, 0); 
            return;
        }
        fprintf(stderr, "Error: '{' found without a preceding statement expecting it.\n"); return;
    }
    if (current_block_frame->type == BLOCK_TYPE_FUNCTION_DEF) { 
    }
    else if (current_block_frame->condition_true && current_exec_state != STATE_BLOCK_SKIP) current_exec_state = STATE_BLOCK_EXECUTE;
    else current_exec_state = STATE_BLOCK_SKIP;
}

void handle_closing_brace_token(Token token, FILE* input_source) {
    BlockFrame* closed_block_frame = pop_block_bf();
    if (!closed_block_frame) { fprintf(stderr, "Error: '}' found without a matching open block.\n"); current_exec_state = STATE_NORMAL; return; }

    ExecutionState state_before_closed_block = closed_block_frame->prev_exec_state;
    BlockFrame* parent_block = peek_block_bf(); 

    if (closed_block_frame->type == BLOCK_TYPE_WHILE && closed_block_frame->condition_true && 
        (current_exec_state == STATE_BLOCK_EXECUTE || current_exec_state == STATE_NORMAL || current_exec_state == STATE_IMPORT_PARSING) ) { 
        
        bool can_loop_via_fseek = false;
        if (input_source_is_file(input_source) && closed_block_frame->loop_start_fpos != -1) {
             // Before seeking, re-evaluate the condition. This requires re-tokenizing the while header.
             // This is a complex part. A simpler (but less flexible) model is to just seek.
             // For now, we'll stick to the seek model, assuming the condition might change due to side effects in the loop.
            if (fseek(input_source, closed_block_frame->loop_start_fpos, SEEK_SET) == 0) {
                can_loop_via_fseek = true;
                current_exec_state = STATE_NORMAL; // Allow re-processing of the while line by execute_script
                return; 
            } else { 
                perror("fseek failed for while loop"); 
            }
        } else if (!input_source_is_file(input_source) && closed_block_frame->loop_start_line_no > 0) { 
             // This case is for loops inside function bodies (not read from file)
             // True looping here would require re-executing the function lines from the loop header.
             // This is not implemented by simple fseek.
             fprintf(stderr, "Warning: 'while' loop repetition for non-file input (e.g. function body, line %d) is not supported by fseek. Loop will terminate.\n", closed_block_frame->loop_start_line_no);
        }
    }

    if (!parent_block) { 
        current_exec_state = STATE_NORMAL;
    } else { 
        if (parent_block->type == BLOCK_TYPE_FUNCTION_DEF && is_defining_function) {
            current_exec_state = STATE_DEFINE_FUNC_BODY; 
        } else if (parent_block->condition_true) {
            current_exec_state = STATE_BLOCK_EXECUTE; 
        } else {
            current_exec_state = STATE_BLOCK_SKIP; 
        }
    }

    if (closed_block_frame->type == BLOCK_TYPE_FUNCTION_DEF) {
        if (current_function_definition) { 
            current_function_definition->next = function_list; 
            function_list = current_function_definition;
            current_function_definition = NULL; 
        }
        is_defining_function = false; 
        current_exec_state = state_before_closed_block; 
        
        if (!parent_block && current_exec_state == STATE_DEFINE_FUNC_BODY) {
            current_exec_state = STATE_NORMAL;
        }
    }
    
    if (block_stack_top_bf == -1 && current_exec_state != STATE_DEFINE_FUNC_BODY) {
        current_exec_state = STATE_NORMAL;
    }
}

void handle_exit_statement(Token *tokens, int num_tokens) {
    if (current_exec_state == STATE_BLOCK_SKIP && current_exec_state != STATE_IMPORT_PARSING) {
         // If skipping, an exit within that block context might also be skipped,
         // or it might immediately terminate the script. Forcing termination is common.
    }

    // For now, 'exit' without args means exit current script/function with status 0.
    // If it's the main interactive shell, it exits the shell.
    // A more advanced 'exit' could take a status code.
    // And distinguish between exiting a function vs. exiting the whole script.

    // This simple version sets the return request state,
    // which will stop current script/function processing.
    // If called from the top-level interactive loop, main() would handle it.
    bsh_last_return_value[0] = '\0'; // 'exit' itself doesn't set a printable return value here
    bsh_return_value_is_set = false; // 'exit' is about termination status, not typical 'return value' for echo

    if (num_tokens > 1) { // exit <status_code>
        char expanded_status[INPUT_BUFFER_SIZE];
        expand_variables_in_string_advanced(tokens[1].text, expanded_status, sizeof(expanded_status));
        long exit_code = strtol(expanded_status, NULL, 10);
        // Store this exit_code somewhere if the shell needs to propagate it as actual process exit status.
        // For now, we'll just use it to signal return.
        snprintf(bsh_last_return_value, sizeof(bsh_last_return_value), "%ld", exit_code);
        bsh_return_value_is_set = true; // For script result capture
    }

    current_exec_state = STATE_RETURN_REQUESTED; // Use the same state to stop execution
                                                 // The main loop or script executor needs to check this
                                                 // and decide if it's a full shell exit or script/func exit.

    // If this is the top-level interactive shell, the main loop in main()
    // would see STATE_RETURN_REQUESTED and then decide to actually exit the bsh process.
    // If in a script, execute_script() would stop.
    // If in a function, execute_user_function() would stop.
}

void handle_eval_statement(Token *tokens, int num_tokens) {
    if (current_exec_state == STATE_BLOCK_SKIP && current_exec_state != STATE_IMPORT_PARSING) {
        return; // Don't eval if in a skipped block (unless it's an import context that allows it)
    }

    if (num_tokens < 2) {
        // 'eval' with no arguments is typically a no-op or might return success.
        // Some shells might error; for now, let's make it a no-op.
        set_variable_scoped("LAST_COMMAND_STATUS", "0", false);
        return;
    }

    char code_to_eval[MAX_LINE_LENGTH * 2]; // Buffer for the string to be evaluated
                                           // Potentially needs to be larger if eval arguments are very long
    code_to_eval[0] = '\0';
    size_t current_eval_code_len = 0;

    // Concatenate all arguments to 'eval' into a single string, expanding them.
    for (int i = 1; i < num_tokens; i++) {
        if (tokens[i].type == TOKEN_COMMENT) break;

        char expanded_arg_part[INPUT_BUFFER_SIZE];
        if (tokens[i].type == TOKEN_STRING) {
            char unescaped_val[INPUT_BUFFER_SIZE];
            unescape_string(tokens[i].text, unescaped_val, sizeof(unescaped_val)); // From your bsh.c
            expand_variables_in_string_advanced(unescaped_val, expanded_arg_part, sizeof(expanded_arg_part)); // From your bsh.c
        } else {
            expand_variables_in_string_advanced(tokens[i].text, expanded_arg_part, sizeof(expanded_arg_part)); // From your bsh.c
        }

        size_t part_len = strlen(expanded_arg_part);
        if (current_eval_code_len + part_len + (i > 1 ? 1 : 0) < sizeof(code_to_eval)) {
            if (i > 1) { // Add space between arguments
                strcat(code_to_eval, " ");
                current_eval_code_len++;
            }
            strcat(code_to_eval, expanded_arg_part);
            current_eval_code_len += part_len;
        } else {
            fprintf(stderr, "eval: Constructed code string too long.\n");
            set_variable_scoped("LAST_COMMAND_STATUS", "1", false); // Indicate error
            return;
        }
    }

    if (strlen(code_to_eval) > 0) {
        // printf("[DEBUG eval: Executing: \"%s\"]\n", code_to_eval); // Optional debug

        // Store current line number and input source, as eval provides its own "line"
        // FILE* original_input_source = input_source; // from process_line params (if needed)
        // int original_line_no = current_line_no;     // from process_line params (if needed)

        // Execute the constructed string.
        // The `process_line` function is designed to handle a single line of BSH code.
        // `input_source` is NULL because this code doesn't come from a seekable file stream for `while` loops.
        // `current_line_no` can be set to 0 or 1 for the context of the eval'd string.
        // The `exec_mode_param` should be STATE_NORMAL, as eval'd code should execute normally
        // within the current block and scope context.
        process_line(code_to_eval, NULL, 0, STATE_NORMAL);

        // Restore original line_no/input_source if they were modified by process_line or its callees
        // (This depends on how `process_line` uses these for context in loops, etc.)
        // Generally, process_line for eval should not impact the outer script's file seeking.
    } else {
        set_variable_scoped("LAST_COMMAND_STATUS", "0", false); // Eval of empty string is success
    }
}

/////
/////
/////

// --- Utility Implementations ---
// ... (trim_whitespace, free_function_list, free_operator_list, free_loaded_libs, get_file_pos, unescape_string, input_source_is_file remain the same)
char* trim_whitespace(char *str) {
    if (!str) return NULL; char *end;
    while (isspace((unsigned char)*str)) str++;
    if (*str == 0) return str; 
    end = str + strlen(str) - 1;
    while (end > str && isspace((unsigned char)*end)) end--;
    *(end + 1) = 0;
    return str;
}

void free_function_list() {
    UserFunction *current = function_list; UserFunction *next_func;
    while (current != NULL) {
        next_func = current->next;
        for (int i = 0; i < current->line_count; ++i) if(current->body[i]) free(current->body[i]);
        free(current); current = next_func;
    }
    function_list = NULL;
}

void free_loaded_libs() {
    DynamicLib *current = loaded_libs; DynamicLib *next_lib;
    while(current) {
        next_lib = current->next;
        if (current->handle) dlclose(current->handle);
        free(current); current = next_lib;
    }
    loaded_libs = NULL;
}

long get_file_pos(FILE* f) {
    if (!f || f == stdin || f == stdout || f == stderr) return -1L;
    long pos = ftell(f);
    if (pos == -1L) { return -1L; }
    return pos;
}

char* unescape_string(const char* input_raw, char* output_buffer, size_t buffer_size) {
    char* out = output_buffer; const char* p = input_raw; size_t out_len = 0;
    bool in_quotes = false;

    if (*p == '"') { 
        p++; 
        in_quotes = true;
    }

    while (*p && out_len < buffer_size - 1) {
        if (in_quotes && *p == '"' && !(p > input_raw && *(p-1) == '\\' && (p-2 < input_raw || *(p-2) != '\\'))) {
             break; 
        }
        if (*p == '\\') {
            p++; if (!*p) break; 
            switch (*p) {
                case 'n': *out++ = '\n'; break; case 't': *out++ = '\t'; break;
                case '"': *out++ = '"'; break;  case '\\': *out++ = '\\'; break;
                case '$': *out++ = '$'; break;  default: *out++ = '\\'; *out++ = *p; break; 
            }
        } else { *out++ = *p; }
        if (*p) p++; 
        out_len++;
    }
    *out = '\0';
    return output_buffer;
}

bool input_source_is_file(FILE* f) {
    if (!f || f == stdin || f == stdout || f == stderr) return false;
    int fd = fileno(f);
    if (fd == -1) return false; 
    return (fd != STDIN_FILENO && fd != STDOUT_FILENO && fd != STDERR_FILENO);
}

void execute_script(const char *filename, bool is_import_call, bool is_startup_script) {
    // ... (remains largely the same, ensure loop_start_fpos is correctly passed if used by while)
    FILE *script_file = fopen(filename, "r");
    if (!script_file) {
        if (!is_startup_script || errno != ENOENT) { 
            fprintf(stderr, "Error opening script '%s': %s\n", filename, strerror(errno));
        }
        return;
    }
    
    char line_buffer[INPUT_BUFFER_SIZE]; int line_no = 0;
    ExecutionState script_exec_mode = is_import_call ? STATE_IMPORT_PARSING : STATE_NORMAL;

    ExecutionState outer_exec_state_backup = current_exec_state;
    int outer_block_stack_top_bf_backup = block_stack_top_bf;
    bool restore_context = (!is_import_call && !is_startup_script);

    while (true) {
        if (!fgets(line_buffer, sizeof(line_buffer), script_file)) {
            if (feof(script_file)) break; 
            if (ferror(script_file)) { perror("Error reading script file"); break; }
        }
        line_no++;
        process_line(line_buffer, script_file, line_no, script_exec_mode);
    }
    fclose(script_file);

    if (is_import_call) { 
        if (is_defining_function && current_function_definition) {
            fprintf(stderr, "Warning: Unterminated function definition '%s' at end of imported file '%s'.\n", current_function_definition->name, filename);
            for(int i=0; i < current_function_definition->line_count; ++i) if(current_function_definition->body[i]) free(current_function_definition->body[i]);
            free(current_function_definition); current_function_definition = NULL; is_defining_function = false;
            if (block_stack_top_bf >=0 && peek_block_bf() && peek_block_bf()->type == BLOCK_TYPE_FUNCTION_DEF) {
                pop_block_bf();
            }
        }
    } else if (restore_context) { 
        current_exec_state = outer_exec_state_backup;
        while(block_stack_top_bf > outer_block_stack_top_bf_backup) {
            BlockFrame* bf = pop_block_bf();
            fprintf(stderr, "Warning: Script '%s' ended with unclosed block (type %d).\n", filename, bf ? bf->type : -1);
        }
    }

    if (is_startup_script) {
        current_exec_state = STATE_NORMAL;
        while(block_stack_top_bf > -1) { 
             BlockFrame* bf = pop_block_bf();
             if (bf && bf->type == BLOCK_TYPE_FUNCTION_DEF && is_defining_function) {
                fprintf(stderr, "Warning: Startup script ended with unterminated function definition.\n");
                if(current_function_definition) {
                    for(int i=0; i < current_function_definition->line_count; ++i) if(current_function_definition->body[i]) free(current_function_definition->body[i]);
                    free(current_function_definition); current_function_definition = NULL;
                }
                is_defining_function = false;
             }
        }
    }
}

///
/// Objects (JSON-like)
///

// Helper to skip whitespace in the object string
const char* skip_whitespace_in_obj_str(const char* s) {
    while (*s && isspace((unsigned char)*s)) s++;
    return s;
}

// Helper to parse a BSH-style quoted string from the object string
// Returns a pointer to the character after the parsed string (and closing quote).
// Stores the unescaped string content in 'dest_buffer'.
// This is a simplified string parser for this specific context.
const char* parse_quoted_string_from_obj_str(const char* s, char* dest_buffer, size_t buffer_size) {
    dest_buffer[0] = '\0';
    s = skip_whitespace_in_obj_str(s);
    if (*s != '"') return s; // Expected opening quote

    s++; // Skip opening quote
    char* out = dest_buffer;
    size_t count = 0;
    while (*s && count < buffer_size - 1) {
        if (*s == '"') { // End of string
            s++; // Skip closing quote
            *out = '\0';
            return s;
        }
        // Basic escape handling (add more if needed: \n, \t, etc.)
        if (*s == '\\' && *(s + 1) != '\0') {
            s++;
            if (*s == '"' || *s == '\\') {
                *out++ = *s++;
            } else { // Keep backslash if not a recognized escape for this simple parser
                *out++ = '\\';
                *out++ = *s++;
            }
        } else {
            *out++ = *s++;
        }
        count++;
    }
    *out = '\0'; // Ensure null termination
    // If loop ended due to buffer full or end of string without closing quote, it's an error
    // or implies the string was truncated. For simplicity, we return current 's'.
    return s;
}

// Main recursive parsing function
// data_ptr is a pointer-to-pointer to traverse the input string
void parse_bsh_object_recursive(const char** data_ptr, const char* current_base_bsh_var_name, int scope_id) {
    const char* p = skip_whitespace_in_obj_str(*data_ptr);

    if (*p != '[') {
        fprintf(stderr, "BSH Object Parse Error: Expected '[' for object/array start. At: %s\n", p);
        // To prevent infinite loops on malformed input, consume something or error out.
        // For simplicity, we'll try to find the end or a known delimiter if things go wrong.
        *data_ptr = p + strlen(p); // Consume rest of string on error
        return;
    }
    p++; // Consume '['

    bool first_element = true;
    while (*p) {
        p = skip_whitespace_in_obj_str(p);
        if (*p == ']') {
            p++; // Consume ']'
            break; // End of current object/array
        }

        if (!first_element) {
            if (*p == ',') {
                p++; // Consume ','
                p = skip_whitespace_in_obj_str(p);
            } else {
                fprintf(stderr, "BSH Object Parse Error: Expected ',' or ']' between elements. At: %s\n", p);
                *data_ptr = p + strlen(p); return; // Error
            }
        }
        first_element = false;

        // Parse Key
        char key_buffer[MAX_VAR_NAME_LEN]; // For "0", "ciao"
        p = parse_quoted_string_from_obj_str(p, key_buffer, sizeof(key_buffer));
        if (strlen(key_buffer) == 0) {
            fprintf(stderr, "BSH Object Parse Error: Expected valid key string. At: %s\n", p);
            *data_ptr = p + strlen(p); return; // Error
        }

        p = skip_whitespace_in_obj_str(p);
        if (*p != ':') {
            fprintf(stderr, "BSH Object Parse Error: Expected ':' after key '%s'. At: %s\n", key_buffer, p);
            *data_ptr = p + strlen(p); return; // Error
        }
        p++; // Consume ':'
        p = skip_whitespace_in_obj_str(p);

        // Construct new base name for BSH variable
        char next_base_bsh_var_name[MAX_VAR_NAME_LEN * 2]; // Increased size for nested names
        // Sanitize key_buffer for use in variable names (e.g., replace disallowed chars with '_')
        // For now, assume keys are simple enough or BSH var names allow them.
        snprintf(next_base_bsh_var_name, sizeof(next_base_bsh_var_name), "%s_%s", current_base_bsh_var_name, key_buffer);

        // Parse Value
        if (*p == '[') { // Nested object/array
            // Set a type for the current key indicating it's a nested structure
            char type_var_for_key[MAX_VAR_NAME_LEN * 2 + 20];
            snprintf(type_var_for_key, sizeof(type_var_for_key), "%s_BSH_STRUCT_TYPE", next_base_bsh_var_name);
            set_variable_scoped(type_var_for_key, "BSH_OBJECT", false); // Using current scope

            parse_bsh_object_recursive(&p, next_base_bsh_var_name, scope_id);
        } else if (*p == '"') { // String value
            char value_buffer[INPUT_BUFFER_SIZE]; // Assuming values fit here
            p = parse_quoted_string_from_obj_str(p, value_buffer, sizeof(value_buffer));
            set_variable_scoped(next_base_bsh_var_name, value_buffer, false); // Using current scope
        } else {
            fprintf(stderr, "BSH Object Parse Error: Expected value (string or nested object) after key '%s'. At: %s\n", key_buffer, p);
            *data_ptr = p + strlen(p); return; // Error
        }
    } // End while
    *data_ptr = p; // Update the main pointer
}

// The public function called by handle_assignment_advanced
void parse_and_flatten_bsh_object_string(const char* object_data_string, const char* base_var_name, int current_scope_id) {
    const char* p = object_data_string; // p will be advanced by the recursive parser

    // Set a root type for the base variable name
    char root_type_var_key[MAX_VAR_NAME_LEN + 30]; // Enough for _BSH_STRUCT_TYPE and safety
    snprintf(root_type_var_key, sizeof(root_type_var_key), "%s_BSH_STRUCT_TYPE", base_var_name);
    set_variable_scoped(root_type_var_key, "BSH_OBJECT_ROOT", false); // Or "BSH_ARRAY_ROOT"

    // Temporarily push the target scope if different from current, or ensure set_variable_scoped uses it.
    // For simplicity, we assume set_variable_scoped in our recursive calls will use the active scope
    // which should be the one where the assignment is happening.
    // If 'current_scope_id' is different from scope_stack[scope_stack_top].scope_id,
    // you might need a temporary scope push/pop or pass scope_id to set_variable_scoped.
    // The current set_variable_scoped uses scope_stack[scope_stack_top].scope_id implicitly.

    parse_bsh_object_recursive(&p, base_var_name, current_scope_id);

    // p should now point to the end of the parsed structure or where parsing stopped.
    // You can check if *p is whitespace or null to see if the whole string was consumed.
    p = skip_whitespace_in_obj_str(p);
    if (*p != '\0') {
        fprintf(stderr, "BSH Object Parse Warning: Extra characters found after main object structure. At: %s\n", p);
    }
    fprintf(stdout, "[BSH_DEBUG] Flattening complete for base var '%s'.\n", base_var_name);
}

/// Stringify object

// Helper for stringification: find all variables prefixed by base_var_name_
// This is a conceptual helper, actual iteration would be over variable_list_head.
typedef struct VarPair { char key[MAX_VAR_NAME_LEN]; char* value; char type_info[MAX_VAR_NAME_LEN]; struct VarPair* next; } VarPair;

// Recursive helper
bool build_object_string_recursive(const char* current_base_name, char** p_out, size_t* remaining_size, int scope_id) {
    char prefix_pattern[MAX_VAR_NAME_LEN * 2];
    snprintf(prefix_pattern, sizeof(prefix_pattern), "%s_", current_base_name);
    size_t prefix_len = strlen(prefix_pattern);

    VarPair* pairs_head = NULL;
    VarPair* pairs_tail = NULL;
    int element_count = 0;

    // Step 1: Collect all direct children of current_base_name in the current scope
    Variable* var_node = variable_list_head;
    while (var_node) {
        if (var_node->scope_id == scope_id && strncmp(var_node->name, prefix_pattern, prefix_len) == 0) {
            const char* sub_key_full = var_node->name + prefix_len;
            // Ensure this is a direct child, not a grandchild (e.g., base_key1_subkey vs base_key1)
            if (strchr(sub_key_full, '_') == NULL || 
                (strstr(sub_key_full, "_BSH_STRUCT_TYPE") != NULL && strchr(sub_key_full, '_') == strstr(sub_key_full, "_BSH_STRUCT_TYPE")) ) {
                
                char actual_key[MAX_VAR_NAME_LEN];
                strncpy(actual_key, sub_key_full, sizeof(actual_key)-1);
                actual_key[sizeof(actual_key)-1] = '\0';
                
                char* type_suffix_ptr = strstr(actual_key, "_BSH_STRUCT_TYPE");
                if (type_suffix_ptr) { // It's a type variable for a sub-object, not a direct value itself (unless it's the root)
                    *type_suffix_ptr = '\0'; // Get the key name before "_BSH_STRUCT_TYPE"
                }

                // Avoid adding duplicates if we process type var and value var separately
                bool key_already_added = false;
                for(VarPair* vp = pairs_head; vp; vp = vp->next) { if(strcmp(vp->key, actual_key) == 0) {key_already_added = true; break;}}
                if(key_already_added && !type_suffix_ptr) continue; // If value var and key is added from type, skip
                if(key_already_added && type_suffix_ptr) { // Update type if key exists
                     for(VarPair* vp = pairs_head; vp; vp = vp->next) { if(strcmp(vp->key, actual_key) == 0) { strncpy(vp->type_info, var_node->value, sizeof(vp->type_info)-1); break;}}
                     continue;
                }


                VarPair* new_pair = (VarPair*)malloc(sizeof(VarPair));
                if (!new_pair) { /* error */ return false; }
                strncpy(new_pair->key, actual_key, sizeof(new_pair->key)-1);
                new_pair->key[sizeof(new_pair->key)-1] = '\0';
                new_pair->value = NULL; // Will be filled if it's a direct value
                new_pair->type_info[0] = '\0'; // Default no specific type
                new_pair->next = NULL;

                if (type_suffix_ptr) { // This was a *_BSH_STRUCT_TYPE variable
                    strncpy(new_pair->type_info, var_node->value, sizeof(new_pair->type_info)-1);
                } else { // This is a direct value variable
                    new_pair->value = var_node->value;
                }
                
                if (!pairs_head) pairs_head = pairs_tail = new_pair;
                else { pairs_tail->next = new_pair; pairs_tail = new_pair; }
                element_count++;
            }
        }
        var_node = var_node->next;
    }
    
    // Step 1b: For keys found via _BSH_STRUCT_TYPE, find their actual value if they are simple
    // (This logic might need refinement if a key is ONLY defined by its _BSH_STRUCT_TYPE but has no direct value, implying it's purely a container)
    for(VarPair* vp = pairs_head; vp; vp = vp->next) {
        if (vp->value == NULL && strlen(vp->type_info) == 0) { // No value and no type, try to get direct value
             char direct_value_var_name[MAX_VAR_NAME_LEN *2];
             snprintf(direct_value_var_name, sizeof(direct_value_var_name), "%s_%s", current_base_name, vp->key);
             vp->value = get_variable_scoped(direct_value_var_name); // Relies on correct scope
        }
    }


    // Step 2: Append '['
    if (*remaining_size < 2) return false;
    **p_out = '['; (*p_out)++; (*remaining_size)--;

    // Step 3: Iterate through collected pairs and stringify them
    // TODO: Sort pairs if necessary (e.g., numeric keys for array-like objects)
    bool first = true;
    VarPair* current_pair = pairs_head;
    while (current_pair) {
        if (!first) {
            if (*remaining_size < 2) { /* free VarPairs */ return false; }
            **p_out = ','; (*p_out)++;
            **p_out = ' '; (*p_out)++; // Optional space
            (*remaining_size) -= 2;
        }
        first = false;

        // Append key (quoted)
        if (*remaining_size < strlen(current_pair->key) + 3) { /* free VarPairs */ return false; }
        **p_out = '"'; (*p_out)++; (*remaining_size)--;
        strcpy(*p_out, current_pair->key); (*p_out) += strlen(current_pair->key); (*remaining_size) -= strlen(current_pair->key);
        **p_out = '"'; (*p_out)++; (*remaining_size)--;

        // Append ':'
        if (*remaining_size < 2) { /* free VarPairs */ return false; }
        **p_out = ':'; (*p_out)++;
        **p_out = ' '; (*p_out)++; // Optional space
        (*remaining_size) -= 2;

        // Append value
        char next_level_base_name[MAX_VAR_NAME_LEN * 2];
        snprintf(next_level_base_name, sizeof(next_level_base_name), "%s_%s", current_base_name, current_pair->key);

        if (strcmp(current_pair->type_info, "BSH_OBJECT") == 0 || strcmp(current_pair->type_info, "BSH_OBJECT_ROOT") == 0) { // It's a nested object
            if (!build_object_string_recursive(next_level_base_name, p_out, remaining_size, scope_id)) {
                 /* free VarPairs */ return false;
            }
        } else if (current_pair->value) { // Simple string value
            if (*remaining_size < strlen(current_pair->value) + 3) { /* free VarPairs */ return false; }
            **p_out = '"'; (*p_out)++; (*remaining_size)--;
            // TODO: Escape special characters in current_pair->value before strcpy
            strcpy(*p_out, current_pair->value);
            (*p_out) += strlen(current_pair->value);
            (*remaining_size) -= strlen(current_pair->value);
            **p_out = '"'; (*p_out)++; (*remaining_size)--;
        } else { // Should have a value or be a known container type
            if (*remaining_size < 3) { /* free VarPairs */ return false; }
            strcpy(*p_out, "\"\""); (*p_out) += 2; (*remaining_size) -=2; // Empty string if no value found
        }
        current_pair = current_pair->next;
    }

    // Step 4: Append ']'
    if (*remaining_size < 2) { /* free VarPairs */ return false; }
    **p_out = ']'; (*p_out)++; (*remaining_size)--;
    **p_out = '\0';

    // Free the collected VarPair list
    current_pair = pairs_head;
    while(current_pair) {
        VarPair* next = current_pair->next;
        free(current_pair);
        current_pair = next;
    }
    return true;
}


bool stringify_bsh_object_to_string(const char* base_var_name, char* output_buffer, size_t buffer_size) {
    output_buffer[0] = '\0';
    if (buffer_size < strlen("object:[]") + 1) return false; // Min possible output

    strcpy(output_buffer, "object:");
    char* p_out = output_buffer + strlen("object:");
    size_t remaining_size = buffer_size - strlen("object:") -1 /* for null terminator */;
    
    int current_scope = (scope_stack_top >= 0) ? scope_stack[scope_stack_top].scope_id : GLOBAL_SCOPE_ID;

    if (!build_object_string_recursive(base_var_name, &p_out, &remaining_size, current_scope)) {
        // Append error marker if something went wrong during build
        strcat(output_buffer, "[ERROR_DURING_STRINGIFY]");
        return false;
    }
    
    return true;
}

// echo definition moved here for helpers

void handle_echo_advanced(Token *tokens, int num_tokens) {
    if (current_exec_state == STATE_BLOCK_SKIP) return;

    char expanded_arg_buffer[INPUT_BUFFER_SIZE]; // Buffer for general argument expansion
    char object_stringified_buffer[INPUT_BUFFER_SIZE * 2]; // Potentially larger for object stringification

    for (int i = 1; i < num_tokens; i++) {
        if (tokens[i].type == TOKEN_COMMENT) break;

        const char* string_to_print = NULL;
        bool is_bsh_object_to_stringify = false;

        // First, determine if the argument is a variable that might be a BSH object
        if (tokens[i].type == TOKEN_VARIABLE) {
            char var_name_raw[MAX_VAR_NAME_LEN];
            // Extract clean variable name (without '$' or '${}')
            // This part needs to be robust as in handle_assignment_advanced or handle_unary_op_statement
            if (tokens[i].text[0] == '$') {
                if (tokens[i].text[1] == '{') {
                    const char* end_brace = strchr(tokens[i].text + 2, '}');
                    if (end_brace) {
                        size_t len = end_brace - (tokens[i].text + 2);
                        if (len < MAX_VAR_NAME_LEN) {
                            strncpy(var_name_raw, tokens[i].text + 2, len);
                            var_name_raw[len] = '\0';
                        } else { /* var name too long, handle error or truncate */ var_name_raw[0] = '\0'; }
                    } else { /* malformed */ var_name_raw[0] = '\0'; }
                } else {
                    // Simple $var or $var[index] - for echo, we care about the base var for type check
                    char* bracket_ptr = strchr(tokens[i].text + 1, '[');
                    if (bracket_ptr) {
                        size_t base_len = bracket_ptr - (tokens[i].text + 1);
                        if (base_len < MAX_VAR_NAME_LEN) {
                            strncpy(var_name_raw, tokens[i].text + 1, base_len);
                            var_name_raw[base_len] = '\0';
                        } else { var_name_raw[0] = '\0';}
                    } else {
                        strncpy(var_name_raw, tokens[i].text + 1, MAX_VAR_NAME_LEN - 1);
                        var_name_raw[MAX_VAR_NAME_LEN - 1] = '\0';
                    }
                }

                if (strlen(var_name_raw) > 0) {
                    char object_type_var_name[MAX_VAR_NAME_LEN + 30];
                    snprintf(object_type_var_name, sizeof(object_type_var_name), "%s_BSH_STRUCT_TYPE", var_name_raw);
                    char* struct_type = get_variable_scoped(object_type_var_name);

                    if (struct_type && strcmp(struct_type, "BSH_OBJECT_ROOT") == 0) {
                        // It's a BSH object, attempt to stringify it
                        if (stringify_bsh_object_to_string(var_name_raw, object_stringified_buffer, sizeof(object_stringified_buffer))) {
                            string_to_print = object_stringified_buffer;
                            is_bsh_object_to_stringify = true;
                        } else {
                            // Stringification failed, print an error marker or the raw variable token
                            snprintf(expanded_arg_buffer, sizeof(expanded_arg_buffer), "[Error stringifying object: %s]", var_name_raw);
                            string_to_print = expanded_arg_buffer;
                        }
                    }
                }
            }
        }

        if (!is_bsh_object_to_stringify) {
            // Not a BSH object or not a variable, so expand normally
            if (tokens[i].type == TOKEN_STRING) {
                char unescaped_val[INPUT_BUFFER_SIZE];
                unescape_string(tokens[i].text, unescaped_val, sizeof(unescaped_val));
                expand_variables_in_string_advanced(unescaped_val, expanded_arg_buffer, sizeof(expanded_arg_buffer));
            } else {
                expand_variables_in_string_advanced(tokens[i].text, expanded_arg_buffer, sizeof(expanded_arg_buffer));
            }
            string_to_print = expanded_arg_buffer;
        }

        printf("%s%s", string_to_print,
               (i == num_tokens - 1 || (i + 1 < num_tokens && tokens[i + 1].type == TOKEN_COMMENT)) ? "" : " ");
    }
    printf("\n");
}

/////
///// Scope functions
/////

// --- Variable & Scope Management ---
// ... (rest of variable and scope management functions remain the same)
int enter_scope() {
    if (scope_stack_top + 1 >= MAX_SCOPE_DEPTH) {
        fprintf(stderr, "Error: Maximum scope depth exceeded (%d).\n", MAX_SCOPE_DEPTH);
        return -1; 
    }
    scope_stack_top++;
    scope_stack[scope_stack_top].scope_id = (scope_stack_top == 0 && next_scope_id == 1) ? GLOBAL_SCOPE_ID : next_scope_id++;
    if (scope_stack_top == 0) scope_stack[scope_stack_top].scope_id = GLOBAL_SCOPE_ID;

    return scope_stack[scope_stack_top].scope_id;
}

void leave_scope(int scope_id_to_leave) {
    if (scope_stack_top < 0 ) { 
        return;
    }
    if (scope_stack[scope_stack_top].scope_id != scope_id_to_leave) {
        if (scope_id_to_leave != GLOBAL_SCOPE_ID || scope_stack[scope_stack_top].scope_id != GLOBAL_SCOPE_ID) {
             fprintf(stderr, "Error: Scope mismatch on leave_scope. Trying to leave %d, current top is %d.\n",
                scope_id_to_leave, scope_stack[scope_stack_top].scope_id );
        }
        scope_stack_top--;
        return;
    }
    if (scope_id_to_leave != GLOBAL_SCOPE_ID) { 
        cleanup_variables_for_scope(scope_id_to_leave);
    }
    scope_stack_top--;
}

void cleanup_variables_for_scope(int scope_id) {
    if (scope_id == GLOBAL_SCOPE_ID) return; 

    Variable *current = variable_list_head;
    Variable *prev = NULL;
    while (current != NULL) {
        if (current->scope_id == scope_id) {
            Variable *to_delete = current;
            if (prev == NULL) { 
                variable_list_head = current->next;
            } else { 
                prev->next = current->next;
            }
            current = current->next; 
            if (to_delete->value) free(to_delete->value);
            free(to_delete);
        } else {
            prev = current;
            current = current->next;
        }
    }
}

void free_all_variables() {
    Variable *current = variable_list_head;
    Variable *next_var;
    while (current != NULL) {
        next_var = current->next;
        if (current->value) free(current->value);
        free(current);
        current = next_var;
    }
    variable_list_head = NULL;
}

char* get_variable_scoped(const char *name_raw) {
    char clean_name[MAX_VAR_NAME_LEN];
    strncpy(clean_name, name_raw, MAX_VAR_NAME_LEN -1); clean_name[MAX_VAR_NAME_LEN-1] = '\0';
    trim_whitespace(clean_name);
    if (strlen(clean_name) == 0) return NULL;

    for (int i = scope_stack_top; i >= 0; i--) {
        int current_search_scope_id = scope_stack[i].scope_id;
        Variable *current_node = variable_list_head;
        while (current_node != NULL) {
            if (current_node->scope_id == current_search_scope_id && strcmp(current_node->name, clean_name) == 0) {
                return current_node->value; 
            }
            current_node = current_node->next;
        }
    }
    return NULL; 
}

void set_variable_scoped(const char *name_raw, const char *value_to_set, bool is_array_elem) {
    if (scope_stack_top < 0) {
        fprintf(stderr, "Critical Error: No active scope to set variable '%s'. Shell not initialized?\n", name_raw);
        return;
    }
    int current_scope_id = scope_stack[scope_stack_top].scope_id;

    char clean_name[MAX_VAR_NAME_LEN];
    strncpy(clean_name, name_raw, MAX_VAR_NAME_LEN -1); clean_name[MAX_VAR_NAME_LEN-1] = '\0';
    trim_whitespace(clean_name);
    if (strlen(clean_name) == 0) { fprintf(stderr, "Error: Cannot set variable with empty name.\n"); return; }

    Variable *current_node = variable_list_head;
    while (current_node != NULL) {
        if (current_node->scope_id == current_scope_id && strcmp(current_node->name, clean_name) == 0) {
            if (current_node->value) free(current_node->value); 
            current_node->value = strdup(value_to_set);
            if (!current_node->value) { perror("strdup failed for variable value update"); current_node->value = strdup("");  }
            current_node->is_array_element = is_array_elem;
            return;
        }
        current_node = current_node->next;
    }

    Variable *new_var = (Variable*)malloc(sizeof(Variable));
    if (!new_var) { perror("malloc for new variable failed"); return; }
    strncpy(new_var->name, clean_name, MAX_VAR_NAME_LEN - 1); new_var->name[MAX_VAR_NAME_LEN - 1] = '\0';
    new_var->value = strdup(value_to_set);
    if (!new_var->value) { perror("strdup failed for new variable value"); free(new_var); new_var = NULL;  return; }
    new_var->is_array_element = is_array_elem;
    new_var->scope_id = current_scope_id;
    new_var->next = variable_list_head; 
    variable_list_head = new_var;
}

void expand_variables_in_string_advanced(const char *input_str, char *expanded_str, size_t expanded_str_size) {
    const char *p_in = input_str;
    char *p_out = expanded_str;
    size_t remaining_size = expanded_str_size - 1; // For null terminator
    expanded_str[0] = '\0';

    while (*p_in && remaining_size > 0) {
        if (*p_in == '$') {
            p_in++; // Consume '$'
            
            char current_mangled_name[MAX_VAR_NAME_LEN * 4] = ""; // Buffer for var_prop1_prop2 etc. (increased size)
            char segment_buffer[MAX_VAR_NAME_LEN]; // For individual segment (base var or property name)
            char* pv = segment_buffer;
            bool first_segment = true;

            do { // Loop for base variable and subsequent dot-separated properties
                pv = segment_buffer; // Reset for current segment
                segment_buffer[0] = '\0';

                if (first_segment) { // Parsing the base variable name
                    if (*p_in == '{') {
                        p_in++; // Consume '{'
                        while (*p_in && *p_in != '}' && (pv - segment_buffer < MAX_VAR_NAME_LEN - 1)) {
                            *pv++ = *p_in++;
                        }
                        if (*p_in == '}') p_in++; // Consume '}'
                    } else {
                        while (isalnum((unsigned char)*p_in) || *p_in == '_') {
                            if (pv - segment_buffer < MAX_VAR_NAME_LEN - 1) *pv++ = *p_in++; else break;
                        }
                    }
                    *pv = '\0';
                    if (strlen(segment_buffer) == 0) { // Invalid: $ or ${}
                        // Output literal '$' and potentially braces if they were consumed
                        if (remaining_size > 0) { *p_out++ = '$'; remaining_size--; }
                        const char* temp_p = p_in -1; // Check what was before current p_in
                        if (*temp_p == '{' && remaining_size > 0) { *p_out++ = '{'; remaining_size--; }
                        if (*temp_p == '}' && remaining_size > 0) { *p_out++ = '}'; remaining_size--; }
                        goto next_char_in_input; // Break from $ processing, continue outer while
                    }
                    strncpy(current_mangled_name, segment_buffer, sizeof(current_mangled_name) - 1);
                    first_segment = false;
                } else { // Parsing a property name after a dot
                    if (*p_in == '$') { // Dynamic property: .$dynamicProp
                        p_in++; // Consume '$' for the dynamic part
                        char dynamic_prop_source_var_name[MAX_VAR_NAME_LEN];
                        char* pdv = dynamic_prop_source_var_name;
                        if (*p_in == '{') {
                            p_in++;
                            while (*p_in && *p_in != '}' && (pdv - dynamic_prop_source_var_name < MAX_VAR_NAME_LEN - 1)) {
                                *pdv++ = *p_in++;
                            }
                            if (*p_in == '}') p_in++;
                        } else {
                            while (isalnum((unsigned char)*p_in) || *p_in == '_') {
                                if (pdv - dynamic_prop_source_var_name < MAX_VAR_NAME_LEN - 1) *pdv++ = *p_in++; else break;
                            }
                        }
                        *pdv = '\0';
                        char* prop_name_from_var = get_variable_scoped(dynamic_prop_source_var_name);
                        if (prop_name_from_var) {
                            strncpy(segment_buffer, prop_name_from_var, MAX_VAR_NAME_LEN -1);
                            segment_buffer[MAX_VAR_NAME_LEN -1] = '\0';
                        } else {
                            segment_buffer[0] = '\0'; // Dynamic property name var not found
                        }
                    } else { // Literal property name: .prop
                        while (isalnum((unsigned char)*p_in) || *p_in == '_') { // Property names are like var names
                            if (pv - segment_buffer < MAX_VAR_NAME_LEN - 1) *pv++ = *p_in++; else break;
                        }
                        *pv = '\0';
                    }

                    if (strlen(segment_buffer) > 0) {
                        if (strlen(current_mangled_name) + 1 + strlen(segment_buffer) < sizeof(current_mangled_name)) {
                            strcat(current_mangled_name, "_");
                            strcat(current_mangled_name, segment_buffer);
                        } else {
                            segment_buffer[0] = '\0'; // Prevent overflow, effectively ending chain
                        }
                    } else {
                        // Invalid or empty property segment, chain broken.
                        // The value of current_mangled_name up to this point will be sought.
                        break; // Exit dot processing loop
                    }
                }
            } while (*p_in == '.'); // Check for next dot only if a valid segment was parsed
            // End of loop for base var and subsequent dot-separated properties

            char* value_to_insert = get_variable_scoped(current_mangled_name);
            if (value_to_insert) {
                size_t val_len = strlen(value_to_insert);
                if (val_len <= remaining_size) { // Check if it fits
                    strcpy(p_out, value_to_insert);
                    p_out += val_len;
                    remaining_size -= val_len;
                } else { // Not enough space
                    strncpy(p_out, value_to_insert, remaining_size);
                    p_out += remaining_size;
                    remaining_size = 0;
                }
            }
            // If value_to_insert is NULL, nothing is inserted for this $... sequence.

        } else if (*p_in == '\\' && *(p_in + 1) == '$') { // Escaped $
            p_in++; // Skip '\'
            if (remaining_size > 0) { *p_out++ = *p_in++; remaining_size--; }
        } else { // Regular character
            if (remaining_size > 0) { *p_out++ = *p_in++; remaining_size--; }
        }
        next_char_in_input:; // Label for goto
    }
    *p_out = '\0'; // Null-terminate the expanded string
}

char* get_array_element_scoped(const char* array_base_name, const char* index_str_raw_param) {
    char mangled_name[MAX_VAR_NAME_LEN * 2]; 
    snprintf(mangled_name, sizeof(mangled_name), "%s_ARRAYIDX_%s", array_base_name, index_str_raw_param);
    return get_variable_scoped(mangled_name);
}

void set_array_element_scoped(const char* array_base_name, const char* index_str_raw_param, const char* value) {
    char index_str_raw[INPUT_BUFFER_SIZE];
    strncpy(index_str_raw, index_str_raw_param, sizeof(index_str_raw) -1);
    index_str_raw[sizeof(index_str_raw)-1] = '\0';

    char expanded_index_val[INPUT_BUFFER_SIZE];
    if (index_str_raw[0] == '"' && index_str_raw[strlen(index_str_raw)-1] == '"') {
        char unescaped_idx[INPUT_BUFFER_SIZE];
        unescape_string(index_str_raw, unescaped_idx, sizeof(unescaped_idx));
        expand_variables_in_string_advanced(unescaped_idx, expanded_index_val, sizeof(expanded_index_val));
    } else if (index_str_raw[0] == '$') {
        expand_variables_in_string_advanced(index_str_raw, expanded_index_val, sizeof(expanded_index_val));
    } else { 
        strncpy(expanded_index_val, index_str_raw, sizeof(expanded_index_val)-1);
        expanded_index_val[sizeof(expanded_index_val)-1] = '\0';
    }
    char mangled_name[MAX_VAR_NAME_LEN * 2];
    snprintf(mangled_name, sizeof(mangled_name), "%s_ARRAYIDX_%s", array_base_name, expanded_index_val);
    set_variable_scoped(mangled_name, value, true); 
}



// --- Command Execution ---
// ... (find_command_in_path_dynamic, find_module_in_path, execute_external_command, execute_user_function remain the same)
bool find_command_in_path_dynamic(const char *command, char *full_path) {
    if (strchr(command, '/') != NULL) { 
        if (access(command, X_OK) == 0) {
            strncpy(full_path, command, MAX_FULL_PATH_LEN -1); full_path[MAX_FULL_PATH_LEN-1] = '\0';
            return true;
        }
        return false;
    }
    PathDirNode *current_path_node = path_list_head;
    while (current_path_node) {
        snprintf(full_path, MAX_FULL_PATH_LEN, "%s/%s", current_path_node->path, command);
        if (access(full_path, X_OK) == 0) return true;
        current_path_node = current_path_node->next;
    }
    return false;
}

bool find_module_in_path(const char* module_spec, char* result_full_path) {
    char module_path_part[MAX_FULL_PATH_LEN];
    strncpy(module_path_part, module_spec, sizeof(module_path_part) - 1);
    module_path_part[sizeof(module_path_part) - 1] = '\0';

    char *dot = strrchr(module_path_part, '.');
    if (dot && strchr(module_path_part, '/') == NULL) { 
        *dot = '/'; 
        strncat(module_path_part, ".bsh", sizeof(module_path_part) - strlen(module_path_part) - 1);
    } else if (strchr(module_path_part, '/') == NULL && (strstr(module_path_part, ".bsh") == NULL) ) {
        strncat(module_path_part, ".bsh", sizeof(module_path_part) - strlen(module_path_part) - 1);
    }

    char temp_path[PATH_MAX];
    if (realpath(module_path_part, temp_path) && access(temp_path, F_OK) == 0) {
        strncpy(result_full_path, temp_path, MAX_FULL_PATH_LEN -1);
        result_full_path[MAX_FULL_PATH_LEN-1] = '\0';
        return true;
    }
    if (access(module_path_part, F_OK) == 0) {
         strncpy(result_full_path, module_path_part, MAX_FULL_PATH_LEN -1); 
         result_full_path[MAX_FULL_PATH_LEN-1] = '\0';
         return true;
    }


    if (strchr(module_spec, '/') != NULL) { 
        return false;
    }

    PathDirNode *current_module_dir = module_path_list_head;
    while (current_module_dir) {
        snprintf(result_full_path, MAX_FULL_PATH_LEN, "%s/%s", current_module_dir->path, module_path_part);
        if (realpath(result_full_path, temp_path) && access(temp_path, F_OK) == 0) {
             strncpy(result_full_path, temp_path, MAX_FULL_PATH_LEN -1);
             result_full_path[MAX_FULL_PATH_LEN-1] = '\0';
            return true;
        } else if (access(result_full_path, F_OK) == 0) { 
            return true;
        }
        current_module_dir = current_module_dir->next;
    }
    result_full_path[0] = '\0'; 
    return false;
}

///
///
///

int execute_external_command(char *command_path, char **args, int arg_count, char *output_buffer, size_t output_buffer_size) {
    pid_t pid; int status; int pipefd[2] = {-1, -1};
    if (output_buffer) { if (pipe(pipefd) == -1) { perror("pipe failed for cmd output"); return -1; } }
    pid = fork();
    if (pid == 0) { 
        if (output_buffer) { close(pipefd[0]); dup2(pipefd[1], STDOUT_FILENO); dup2(pipefd[1], STDERR_FILENO); close(pipefd[1]); }
        execv(command_path, args);
        perror("execv failed"); exit(EXIT_FAILURE);
    } else if (pid < 0) { 
        perror("fork failed"); if (output_buffer) { close(pipefd[0]); close(pipefd[1]); } return -1;
    } else { 
        if (output_buffer) {
            close(pipefd[1]); ssize_t bytes_read; size_t total_bytes_read = 0;
            char read_buf[INPUT_BUFFER_SIZE]; output_buffer[0] = '\0';
            while((bytes_read = read(pipefd[0], read_buf, sizeof(read_buf)-1)) > 0) {
                if (total_bytes_read + bytes_read < output_buffer_size) {
                    read_buf[bytes_read] = '\0'; strcat(output_buffer, read_buf); total_bytes_read += bytes_read;
                } else { strncat(output_buffer, read_buf, output_buffer_size - total_bytes_read -1); break; }
            } close(pipefd[0]);
            char* nl = strrchr(output_buffer, '\n');
            while(nl && (nl == output_buffer + strlen(output_buffer) -1)) { *nl = '\0'; nl = strrchr(output_buffer, '\n');}
        }
        do { waitpid(pid, &status, WUNTRACED); } while (!WIFEXITED(status) && !WIFSIGNALED(status));
        char status_str[12]; snprintf(status_str, sizeof(status_str), "%d", WEXITSTATUS(status));
        set_variable_scoped("LAST_COMMAND_STATUS", status_str, false);
        return WEXITSTATUS(status);
    }
    return -1; 
}

void execute_user_function(UserFunction* func, Token* call_arg_tokens, int call_arg_token_count, FILE* input_source_for_context) {
    if (!func) return;
    int function_scope_id = enter_scope();
    if (function_scope_id == -1) { return; }

    for (int i = 0; i < func->param_count; ++i) {
        if (i < call_arg_token_count) {
            char expanded_arg_val[INPUT_BUFFER_SIZE]; 
            if (call_arg_tokens[i].type == TOKEN_STRING) {
                 char unescaped_temp[INPUT_BUFFER_SIZE];
                 unescape_string(call_arg_tokens[i].text, unescaped_temp, sizeof(unescaped_temp));
                 expand_variables_in_string_advanced(unescaped_temp, expanded_arg_val, sizeof(expanded_arg_val));
            } else {
                 expand_variables_in_string_advanced(call_arg_tokens[i].text, expanded_arg_val, sizeof(expanded_arg_val));
            }
            set_variable_scoped(func->params[i], expanded_arg_val, false);
        } else {
            set_variable_scoped(func->params[i], "", false); 
        }
    }

    int func_outer_block_stack_top_bf = block_stack_top_bf;
    ExecutionState func_outer_exec_state = current_exec_state;
    current_exec_state = STATE_NORMAL; 

    for (int i = 0; i < func->line_count; ++i) {
        char line_copy[MAX_LINE_LENGTH]; 
        strncpy(line_copy, func->body[i], MAX_LINE_LENGTH-1); line_copy[MAX_LINE_LENGTH-1] = '\0';
        process_line(line_copy, NULL, i + 1, STATE_NORMAL); 
    }

    while(block_stack_top_bf > func_outer_block_stack_top_bf) {
        pop_block_bf();
    }
    current_exec_state = func_outer_exec_state;

    leave_scope(function_scope_id); 
}