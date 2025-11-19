# Basic [extensible] Shell (B[e]SH)

![BeSH guy](https://github.com/cekkr/besh/blob/main/assets/eGuy.png?raw=true)

# Research Exploration

## Overview

Welcome to the repository for the Basic [extensible] Shell, or B[e]SH. This project represents
an ongoing research endeavor into the design and implementation of a minimalist Unix-like
shell with a strong emphasis on runtime extensibility. As a computer engineer and researcher,
my primary goal with B[e]SH is not to replace existing mature shells, but rather to create a
lightweight, understandable, and highly adaptable environment for exploring core shell
concepts, scripting paradigms, and the practicalities of dynamic syntax extension.
B[e]SH is built upon a foundation of simplicity: variables are treated uniformly as strings,
control flow mechanisms are intentionally kept straightforward, and the core set of built-in
commands is minimal. The true power and research interest lie in its extensibility features,
primarily through its defunc mechanism for user-defined functions (macros) and a conceptual
framework for integrating external C libraries.

## Core Philosophy and Design

The design of B[e]SH is guided by several key principles:

- **Minimalist Core:** The shell's internal C codebase provides essential functionalities:
command execution via PATH resolution, variable assignment (including capturing
command output), if/else conditional statements, while loops, and rudimentary array
support (via name mangling).
- **Runtime Extensibility via defunc:** The cornerstone of B[e]SH's extensibility is the
defunc command. This allows users to define new commands and syntactic sugar
directly within the shell at runtime. These "functions" are essentially macros that can
encapsulate sequences of commands, effectively allowing the user to mold the shell's
language to their specific needs or to prototype new control structures.
- **String-Centric Data Model:** All variables and command outputs are handled as strings.
While this simplifies the core, it places the onus of numerical or type-specific
operations on external utilities or user-defined functions that can parse and process
these strings accordingly. Built-in inc and dec commands offer basic integer arithmetic
on string-represented numbers.
- **Conceptual Dynamic Library Integration:** B[e]SH includes experimental support for
loading and calling functions from external shared libraries (.so files) using loadlib and
calllib. This feature, while rudimentary in its current form concerning ABI complexities,
opens avenues for extending the shell with high-performance C functions without
modifying the core shell binary.


## Delving Deeper: Extensibility and Operational Model

To fully appreciate B[e]SH's design, let's explore its key operational aspects in more detail:

### 1. Crafting Syntax: The Power of defunc

The defunc command is B[e]SH's primary mechanism for runtime syntax extension. It
operates as a sophisticated macro system, allowing users to define new command-like
constructs. When a user-defined function is called:

1. Arguments passed to the function are made available as local variables within the
    function's scope (shadowing any global variables with the same name).
2. The sequence of commands stored in the function's body is then executed by the
    shell's main processing loop.
This mechanism enables users to:

- **Abstract Complexity:** Encapsulate frequently used command sequences into a single,
new command.
- **Prototype New Control Structures:** As demonstrated in example.bsh with for_to_step,
users can build more complex control flow logic (like custom loops) on top of the shell's
primitives (while, if). For instance, one could define a repeat <N> <command_string>
function that executes <command_string> N times.
- **Introduce Domain-Specific Keywords:** If working in a particular problem domain,
users can define functions that act as keywords relevant to that domain, making scripts
more readable and expressive.
Consider a hypothetical assert_equals <val1> <val2> "message" function:

```
defunc assert_equals (v1 v2 msg) {
	if $v1 != $v2 {
		echo "Assertion Failed: $msg ($v1 != $v2)"
	}
}
```
This assert_equals then becomes a new "command" available in the shell session, extending
its vocabulary.

### 2. Variable Management: A String-Centric World

B[e]SH's variable system is intentionally simple and revolves entirely around strings:

- **Storage:** All variables, regardless of their conceptual "type" (number, path, boolean-like
string), are stored internally as null-terminated character arrays.
- **Assignment:**
- $var = "some string": Assigns a literal string.
- $var = external_command --arg: Executes external_command, captures its
standard output (stdout), and assigns this output (as a string, typically with
newlines trimmed) to $var.
- **Expansion:** The $ prefix is used for variable expansion (e.g., echo $var). The shell also
supports ${var} for clarity in ambiguous contexts. Array elements are accessed using a
mangled name internally (e.g., $myArray[idx] becomes a lookup for a variable like
myArray_ARRAYIDX_some_idx_value).

### Manipulation:
- Built-in commands like inc <varname> and dec <varname> attempt to interpret the
variable's string value as an integer, perform the arithmetic, and store the result
back as a string.
- More complex string manipulations (substrings, concatenation beyond simple
echo $var1$var2, pattern matching) would typically be delegated to external
utilities (like awk, sed, or a custom tool) whose output can then be captured.

### 3. Type Agnosticism: User-Driven Interpretation

A direct consequence of the string-centric model is that B[e]SH is fundamentally
**type-agnostic at its core**. It does not perform implicit type conversions or maintain type
information for variables.

**No Built-in Types:** There are no distinct integer, float, or boolean types within the shell
itself. A variable $num holding "123" is simply a string; $flag holding "true" is also just a
string.

**User Responsibility:** The interpretation of a variable's content as a specific type is
entirely up to the user and the commands or functions that operate on it.

- If you pass $num (holding "123") to inc, inc _tries_ to parse it as an integer.
- If you have a custom function or an external binary, say is_numeric <string_value>,
it would be responsible for analyzing the string and determining if it represents a
number.

```
$input = "42.5"
$is_num_result = check_if_numeric $input # external tool
if $is_num_result == "float" {
	# ... handle as float
}
```

This design choice keeps the shell core lean and delegates specialized logic to external tools
or user-defined extensions, aligning with the Unix philosophy of small, composable utilities.

### 4. Interfacing with Executable Binaries

B[e]SH interacts with external executable binaries in a standard Unix fashion:
● **PATH Resolution:** When a command is entered that isn't a built-in or a user-defined
function, B[e]SH searches the directories listed in the PATH environment variable
(colon-separated) to locate the corresponding executable.
● **Execution via fork/execv:** Once found, the shell uses the fork() system call to create a
new process and execv() to replace the child process's image with that of the command
to be executed. Arguments are passed as an array of strings.
● **Output Capturing:** As mentioned, the primary mechanism for an external command to
return data to the shell (for assignment to a variable) is by writing to its standard output.


B[e]SH captures this stdout. Standard error (stderr) from external commands is typically
passed through to the shell's stderr.
● **Return Codes:** While not explicitly detailed for variable assignment, the shell's C code
does retrieve the exit status of external commands. This could be exposed via a special
variable (e.g., $? in many shells) for conditional logic, though this specific feature might
require further explicit implementation in B[e]SH's variable system.
This model allows B[e]SH scripts to leverage the vast ecosystem of existing command-line
utilities for specialized tasks, from text processing (grep, sed, awk) to numerical computation
(bc) or network operations (curl).

### 5. Dynamic Libraries (loadlib/calllib): Advanced Extensibility

### (Conceptual)

The loadlib <path_to_lib.so> <alias> and calllib <alias> <function_name> [args...] commands
represent an advanced, and currently more conceptual, avenue for extensibility in B[e]SH. The
intent is to allow the shell to be augmented with high-performance functions written in C (or
other compiled languages that can expose a C ABI) without recompiling the shell itself.
**Mechanism:**

- dlopen(): loadlib would use this POSIX API to load the specified shared object
(.so) file into the shell's address space.
- dlsym(): calllib would use this to find the address of the specified function name
within the loaded library.
- Function Call: The most challenging part. Directly calling an arbitrary C function
involves:

**Argument Marshalling:** Converting shell strings (and potentially other
future B[e]SH data types) into the C data types expected by the library
function (e.g., int, char*, double, custom structs).

**ABI Compatibility:** Ensuring that the calling convention used by the shell
matches that of the compiled library function.

**Return Value Handling:** Converting the return value from the C function
back into a B[e]SH string or other representation.

**Memory Management:** If the library function allocates memory that it
returns to the shell (e.g., a dynamically allocated string), a clear contract is
needed for who is responsible for freeing that memory to prevent leaks.

**Current Status & Research:** In B[e]SH, this feature is marked as "conceptual" because
a full, robust, and safe implementation of arbitrary C function calls from a shell script is
a significant undertaking, often requiring a dedicated Foreign Function Interface (FFI)
library (like libffi). The current implementation in B[e]SH likely makes simplifying
assumptions about function signatures (e.g., all arguments are strings, or a simple int
main(int argc, char *argv[])-like signature).

**Potential:** If fully realized, this would allow users to write performance-critical
extensions in C, access complex system APIs, or integrate with existing C libraries
directly from B[e]SH scripts, offering a powerful blend of scripting flexibility and


compiled code efficiency.
This operational model underscores B[e]SH's philosophy: provide a simple, stable core and
empower users to build complexity and domain-specific features on top, either through its
scripting capabilities or by interfacing with external tools and libraries.

## The example.bsh Script

To illustrate the capabilities and the intended usage patterns of B[e]SH, this repository
includes an example.bsh script. This script is not merely a collection of test cases; it serves as
a practical demonstration of how B[e]SH's extensibility can be leveraged.
Within example.bsh, you will find:

**Custom Control Structures:** Demonstrations of how defunc can be used to create
higher-level looping constructs, such as a for_to_step function and a conceptual C-style
for loop, built upon the shell's primitive while and inc commands.

**Function Definition:** Clear examples of defining and using functions with parameters.

**Variable Manipulation:** Usage of variable assignment, expansion, and the inc/dec
commands.

**Built-in Usage:** Examples of if/else and direct while loops.
The example.bsh script is crucial for understanding how one might "grow" the shell's
language from its simple primitives. It highlights the philosophy that complexity should be
user-driven and composable, rather than pre-baked into an monolithic core.

## Research Goals and Aspirations

B[e]SH is a platform for investigating several research questions:

- To what extent can a shell's syntax and command set be practically extended at runtime
using simple macro-like mechanisms?
- What are the performance and usability trade-offs of a string-centric data model when
combined with user-defined extensions for more complex operations?
- How does such a minimalist, extensible design impact the learning curve and the
expressiveness for users compared to traditional shells?
- What are the practical challenges and safety considerations in providing dynamic library
linkage (FFI) within a lightweight shell environment?
This project is intended to be an educational tool for those interested in shell design,
interpreters, and the practical aspects of creating domain-specific scripting languages. We
encourage experimentation, contributions, and feedback as we continue to explore the
boundaries of basic, yet extensible, shell environments.
- Are we alone in the universe?

### Final notes
Well, this is just for faya. An experimental shell about incremental syntax and runtime construction

