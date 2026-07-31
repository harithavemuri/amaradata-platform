---
name: feedback-verify-exit-codes
description: Never trust the exit code of a piped command as the exit code of the real command — redirect to a file and check its content directly
metadata:
  type: feedback
---

`command | tail -N` (or any pipe) reports the *last* command's exit code by default, not the piped-into command's. `tail` always exits 0, so `command | tail -150; echo $?` prints 0 even when `command` itself failed.

**Why:** During the testing-parity work, `npx playwright test ... 2>&1 | tail -150` reported exit code 0 and was treated as a clean pass. The actual output (once read in full) showed 8 real test failures. The same mistake repeated with `npm test 2>&1 | tail -40`. Both times the failures were real and needed fixing — the false "0" nearly caused a broken state to be reported as verified.

**How to apply:**
- When running a test/build command whose pass/fail matters, redirect to a file (`command > file 2>&1`) and inspect the file's content for the actual result — never pipe through `tail`/`head`/`grep` and trust the shell's reported exit code.
- If a pipe is unavoidable (e.g. for readability), check `${PIPESTATUS[0]}` (bash) explicitly instead of `$?`, or just read the full output and look for "failed"/"passed" counts directly rather than relying on any exit code.
- This applies to any long-running command backgrounded via the Bash tool too — read the output file's actual content before declaring success, even if the task-completion notification's summary says "exit code 0".
