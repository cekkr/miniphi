These repositories are for testing purposes:

# bash
Bash is a classic GNU/Linux shell, and its source code is not used for miniphi code, but for its testing:
the first hardcore test to do is to analyze the code with a maximum of depth of 1 subfolders and creating the folder samples/bash-results with EXPLAIN-x.md where x is the number of test that wrote this result.
The EXPLAIN code should be a detailed explaination of how works the code flow beginning from main and delving into function and their summarization.
The resulting markdown file should be very large: this is a perfect test about how divide in multiple pieces prompts and merging results, and take advantages of information saved in .miniphi directory through several test (and knowing when ignore/remove useless information).