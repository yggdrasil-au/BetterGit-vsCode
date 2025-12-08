# BetterGit for VS Code

A Visual Studio Code extension that provides a simplified interface for Git, powered by the BetterGit CLI.

## Features
*   **Project Status View:** A dedicated view in the Activity Bar showing your project's status.
*   **One-Click Save:** Save your work with a message and choose a version increment (Patch, Minor, Major).
*   **Safe Undo/Redo:** Revert changes without fear of losing code.
*   **File History:** View and restore previous versions of files.
*   **Node.js Support:** Automatically initializes and updates `package.json` versions.

## Configuration

This extension requires the **BetterGit CLI** to function.

1.  **bettergit.executablePath**: Set this to the absolute path of the `BetterGit.exe` file.
    *   *Example:* `A:\BetterGit\BetterGit.exe`

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

