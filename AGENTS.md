# AGENTS.md

本仓库的 AI 协作规则统一写在 [./CLAUDE.md](./CLAUDE.md)，请先阅读。

Spec-driven 变更流程详见 [./OpenSpec/AGENTS.md](./OpenSpec/AGENTS.md)。

项目领域知识详见 [./OpenSpec/project.md](./OpenSpec/project.md)。

项目计划（缺什么、要做什么）详见 [./OpenSpec/roadmap.md](./OpenSpec/roadmap.md)。

# System Environment & Toolchain Context

You are operating in a highly customized Windows environment running modern PowerShell (pwsh). However, the user has installed a complete suite of modern, Rust-based, Linux-equivalent CLI tools via Scoop. 

**DO NOT** use traditional, verbose PowerShell cmdlets (like `Get-ChildItem`, `Select-String`, `Get-Content`) unless absolutely necessary for Windows-specific OS interactions.

You have full access to the following modern CLI tools. Please prioritize using them for file system operations, reading, and searching:

1. **Coreutils (`uutils-coreutils`)**: Native Windows ports of GNU tools. You can safely use `cp`, `mv`, `rm -rf`, `mkdir`, `cat`, `head`, `tail`, `touch` exactly as you would in Linux.
2. **Search & Find**:
   - Use `rg` (ripgrep) for searching file contents instead of `grep` or `Select-String`.
   - Use `fd` for finding files/directories instead of `find` or `dir`.
3. **Directory Listing**:
   - Use `eza` instead of `ls`.
   - Use `eza --tree` instead of `tree` to visualize directory structures (it respects `.gitignore`).
4. **File Reading**:
   - Use `bat` (which provides syntax highlighting) if you need the user to read code snippets in the terminal.
5. **Data Processing**:
   - `jq` is available for parsing and modifying JSON files.
6. **Version Control**:
   - `gh` (GitHub CLI) is authenticated and ready. You can use it to create PRs, list issues, etc.
   - `delta` is configured for `git diff`.
7. **Additional Developer Utilities**:
   - `make` is available and should be used for repository-defined workflows such as `make test` or `make release-preflight`.
   - `hyperfine` is available for command/runtime performance comparisons.
   - `watchexec` is available for file-watch driven test/build loops.
   - `yq` is available for YAML processing, especially Docker Compose, GitHub Actions, and config templates.
   - `tokei` is available for codebase statistics.
   - `xh` is available for readable HTTP/API smoke tests; `curl` is also available when raw curl behavior is preferred.
   - `sd` is available for simple find-and-replace tasks. Note: the installed Scoop package is `sd` 1.1.0, but the upstream Windows binary reports `sd 1.0.0` via `sd --version`; a functional smoke test confirmed replacements work.

**Execution Rules:**
- Write shell scripts or commands assuming these tools are globally available in the `PATH`.
- If a Codex/agent shell does not inherit the user's normal PATH, prepend the Scoop shims directory before running CLI-heavy commands:
  ` $env:Path = "$HOME\scoop\shims;$env:Path" `
- Verify command resolution with `Get-Command` when behavior looks suspicious. Linux-style commands such as `cat`, `cp`, `mv`, `rm`, `mkdir`, `head`, `tail`, and `touch` should resolve to Scoop/uutils executables, not PowerShell aliases or cmdlets. If PowerShell still shadows them in the current process, call the explicit executable name (for example `cat.exe`, `rm.exe`) or fix the session PATH/alias state before continuing.
- When asked to explore the codebase, utilize `fd` and `rg` for blazing-fast context gathering.
- Maintain PowerShell script compatibility for logic (variables, loops), but use the tools above for I/O and text processing.
