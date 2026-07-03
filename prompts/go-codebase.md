---
description: Go codebase workflow - use LSP first, respect Go version, keep changes minimal
argument-hint: "<task>"
---
Work on this Go codebase task: $@

Follow this workflow:
1. Determine the effective Go version from `go.mod`, `toolchain`, repo docs, or `go version`.
2. Use the LSP tools first (`lsp_symbols`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_diagnostics`) to inspect the code instead of guessing.
3. Prefer the simplest relevant change.
4. Follow idiomatic Go best practices:
   - keep code small, clear, and direct
   - use early returns and explicit error handling
   - prefer standard library and existing project patterns
   - avoid unnecessary abstractions
5. Use only features supported by the detected Go version; if newer supported features simplify the change, use them.
6. Add or update tests only when they meaningfully verify the behavior change.
7. Re-run relevant LSP diagnostics before finishing.
