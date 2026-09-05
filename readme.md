# BetterGit for VS Code

A Visual Studio Code extension that provides a simplified interface for Git, powered by the BetterGit CLI.

## Features
*   **Project Status View:** A dedicated view in the Activity Bar showing your project's status.
*   **One-Click Save:** Save your work with a message and choose a version increment (Patch, Minor, Major).
*   **Safe Undo/Redo:** Revert changes without fear of losing code.
*   **File History:** View and restore previous versions of files.
*   **Web Project Support:** Automatically initializes and updates `package.json`, `deno.json`, and `deno.jsonc` versions.
*   **Remote Mirrors:** Add manually managed mirror remotes directly from the Remotes section.

## Build Pipeline

*   TypeScript is bundled with Deno into `out/extension.js`.
*   `pnpm` is only used for VSIX packaging and installing the extension into VS Code.
*   The Deno build config lives in `deno.jsonc`, which also provides the extension-local tasks.

## Configuration

This extension requires the **BetterGit CLI** to function.

1.  **bettergit.executablePath**: Set this to the absolute path of the `BetterGit.exe` file.
    *   *Example:* `A:\BetterGit\BetterGit.exe`

## Remotes

Use the inline `+` action on the **Remotes** section to create a new mirror remote. The command prompts for the remote name, URL, and group, and defaults the group to `Mirrors`.

Use the inline branch action on a remote row to change the branch that mirror publishes to.

## Directory And Submodule Changes

Selecting a directory or submodule change reveals its scanned repository node in the BetterGit view. If BetterGit cannot find that node, refresh the view and try again. Enable `bettergit.submoduleChanges.revealInExplorer` to also reveal the folder in your OS file explorer.

## Saving Child Repositories

When a parent repository has only child repository changes, BetterGit leaves them to their own repository nodes and does not create a parent commit. When a parent file also changes, BetterGit includes child repository references in the background. If that attempt fails, it retries the parent save without child repository references and records each step in the BetterGit output channel.

Clean child repositories are hidden from the parent's Changes section. Dirty child repositories remain visible when the parent also has ordinary changes.

Unregistered nested repositories have an inline **Convert to Submodule** action in Other Modules. BetterGit uses the child repository's `origin` URL when available, otherwise it asks for a URL. Git preserves the child working files and uncommitted changes during conversion.

## Development

1.  Install dependencies:
    ```pwsh
    pnpm install
    ```
2.  Compile:
    ```pwsh
    pnpm run build
    ```
3.  Run/Debug:
    Press `F5` in VS Code to launch the Extension Development Host.

## Notice

This project was generated entirely with AI.
