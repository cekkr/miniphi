#!/usr/bin/env python3
import os

# For debug purposes

OUTPUT_FILE = "allFramework.txt"
FRAMEWORKS_DIR = "framework/"
BSHRC_FILE = ".bshrc" # Assumes .bshrc is in the same directory as the script

def create_all_framework_file():
    """
    Creates the 'allFramework.txt' file by first adding the content of '.bshrc'
    (if found) and then merging all textual files from the 'frameworks/'
    directory and its subdirectories. Each merged framework file's content is
    preceded by a header like '## File: relative/path/to/file.bsh'.
    """
    print(f"Starting to create {OUTPUT_FILE}...")

    with open(OUTPUT_FILE, 'w', encoding='utf-8') as outfile:
        # --- 1. Add .bshrc content ---
        bshrc_content_added = False
        try:
            if os.path.exists(BSHRC_FILE):
                print(f"Attempting to add content from {BSHRC_FILE}...")
                with open(BSHRC_FILE, 'r', encoding='utf-8') as bshrc_f:
                    bshrc_content = bshrc_f.read()
                
                if bshrc_content:
                    outfile.write("# .bshrc file: \n")
                    outfile.write(bshrc_content)
                    if not bshrc_content.endswith('\n'):
                        outfile.write("\n") # Ensure .bshrc content ends with a newline
                    bshrc_content_added = True
                    print(f"Successfully added content from {BSHRC_FILE}.")
                else:
                    print(f"{BSHRC_FILE} is empty. Nothing to add from it.")
                
            else:
                print(f"Warning: {BSHRC_FILE} not found in the current directory. Skipping this step.")
        except IOError as e:
            print(f"Error reading {BSHRC_FILE}: {e}. Skipping.")
        except UnicodeDecodeError as e:
            print(f"Error decoding {BSHRC_FILE} (not a valid UTF-8 text file?): {e}. Skipping.")
        
        # Add a separator line if .bshrc content was added and there will be framework files
        # or even if .bshrc was empty/not found, to mark the start of framework files if any.
        # For simplicity, always add a newline if we are about to process framework files,
        # unless .bshrc was the *only* content and it already ended with multiple newlines.
        # Let's ensure a clear separation if framework files are to follow.
        if bshrc_content_added : # If .bshrc content was actually written
             outfile.write("\n") # This creates a blank line separator after .bshrc content


        # --- 2. Merge files from frameworks/ directory ---
        if not os.path.isdir(FRAMEWORKS_DIR):
            print(f"Warning: Directory '{FRAMEWORKS_DIR}' not found. Cannot process framework files.")
            if not bshrc_content_added:
                 print(f"{OUTPUT_FILE} might be empty or only contain minimal newlines.")
            else:
                 print(f"{OUTPUT_FILE} created with content from {BSHRC_FILE} only.")
            print(f"\nScript finished.")
            return

        print(f"\nProcessing files in {FRAMEWORKS_DIR}...")
        processed_files_count = 0
        first_framework_file = True # To manage spacing after .bshrc

        for root, _, files in os.walk(FRAMEWORKS_DIR):
            for filename in files:
                full_path = os.path.join(root, filename)
                
                # Add separation before the first framework file if .bshrc was not added or was empty
                if first_framework_file and not bshrc_content_added:
                    # No extra newline needed here as the header itself will start a new line.
                    pass 
                elif first_framework_file and bshrc_content_added:
                    # .bshrc was added, and outfile.write("\n") already added one separator line.
                    # No additional newline needed before the first header.
                    pass


                first_framework_file = False

                try:
                    # Attempt to read as text to confirm it's a "textual file"
                    with open(full_path, 'r', encoding='utf-8') as infile_check:
                        content = infile_check.read() 

                    # If readable as UTF-8 text, proceed
                    relative_path = os.path.relpath(full_path, FRAMEWORKS_DIR)
                    # Ensure forward slashes in the header path as per example "file/relative/path.bsh"
                    relative_path_header_fmt = relative_path.replace(os.sep, '/')
                    
                    header = f"## File: {relative_path_header_fmt}.bsh\n"
                    
                    print(f"  Adding: {full_path} (Header: {relative_path_header_fmt}.bsh)")
                    
                    outfile.write(header)
                    outfile.write(content)
                    
                    # Ensure the file's content block ends with a newline
                    if not content.endswith('\n'):
                        outfile.write("\n")
                    
                    # Add one blank line for separation after this file's block
                    outfile.write("\n") 
                    
                    processed_files_count += 1

                except UnicodeDecodeError:
                    print(f"  Skipping binary or non-UTF-8 file: {full_path}")
                except IOError as e:
                    print(f"  Error reading file {full_path}: {e}. Skipping.")
        
        if processed_files_count > 0:
            print(f"\nSuccessfully processed and added {processed_files_count} file(s) from {FRAMEWORKS_DIR}.")
        elif os.path.isdir(FRAMEWORKS_DIR): # Check if dir existed but no files processed
            print(f"\nNo textual files found or processed in {FRAMEWORKS_DIR}.")

    print(f"\n{OUTPUT_FILE} created successfully.")

if __name__ == "__main__":
    create_all_framework_file()
