import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { BetterGitTreeProvider, BetterGitItem } from './betterGitTreeProvider';
import { BetterGitContentProvider } from './betterGitContentProvider';

// Create a global output channel for BetterGit logging
export const outputChannel = vscode.window.createOutputChannel('BetterGit');

let betterGitTreeView: vscode.TreeView<BetterGitItem> | undefined;

const expandedRepoPaths = new Set<string>();
const expandedSectionKeys = new Set<string>();

// When we refresh the tree, VS Code may emit collapse/expand events as nodes are re-materialized.
// We suppress our bookkeeping during that window so we only record user-driven changes.
let suppressTreeStateTracking = false;

function normalizeAbsPath(p: string): string {
    return path.normalize(p).toLowerCase();
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel.appendLine('[BetterGit] Extension activated');

    const rootPath = (vscode.workspace.workspaceFolders && (vscode.workspace.workspaceFolders.length > 0))
        ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined;

    // 1. Initialize the Tree Data Provider
    const betterGitProvider = new BetterGitTreeProvider(rootPath, context.extensionPath);

    // 2. Create the Tree View (needed for reveal/expand)
    betterGitTreeView = vscode.window.createTreeView('BetterSourceControlView', {
        treeDataProvider: betterGitProvider
    });
    context.subscriptions.push(betterGitTreeView);

    // Track expanded/collapsed state so refresh doesn't collapse the view.
    betterGitTreeView.onDidExpandElement(e => {
        if (suppressTreeStateTracking) return;
        const el = e.element;
        const repoPath = el?.data?.repoPath as string | undefined;
        if (el.contextValue === 'repo-section' && repoPath) {
            expandedRepoPaths.add(normalizeAbsPath(repoPath));
        }
        if (el.contextValue?.startsWith('section-') && repoPath) {
            expandedSectionKeys.add(`${normalizeAbsPath(repoPath)}|${el.contextValue}`);
        }
    });

    betterGitTreeView.onDidCollapseElement(e => {
        if (suppressTreeStateTracking) return;
        const el = e.element;
        const repoPath = el?.data?.repoPath as string | undefined;
        if (el.contextValue === 'repo-section' && repoPath) {
            expandedRepoPaths.delete(normalizeAbsPath(repoPath));
        }
        if (el.contextValue?.startsWith('section-') && repoPath) {
            expandedSectionKeys.delete(`${normalizeAbsPath(repoPath)}|${el.contextValue}`);
        }
    });

    // 3. Register Content Provider for Diffs
    const contentProvider = new BetterGitContentProvider(context.extensionPath, rootPath);
    vscode.workspace.registerTextDocumentContentProvider('bettergit', contentProvider);

    // 4. Register "Save" Command
    vscode.commands.registerCommand('bettersourcecontrol.save', async (repoPath?: string) => {
        const targetPath = repoPath || rootPath;
        if (!targetPath) return;

        const message = await vscode.window.showInputBox({ placeHolder: 'What did you change?' });
        if (message !== undefined) {
            // Get version info
            let currentVersion = '0.0.0';
            let lastCommitVersion = 'None';
            try {
                const output = await execBetterGit(['get-version-info'], targetPath, context);
                const info = JSON.parse(output);
                currentVersion = info.currentVersion || '0.0.0';
                lastCommitVersion = info.lastCommitVersion || 'None';
            } catch (e) {
                // ignore, fallback to defaults
            }

            // Calculate next versions
            // Parse current version
            let major = 0, minor = 0, patch = 0;
            let suffix = '';
            const vParts = currentVersion.split('-');
            if (vParts.length > 1) suffix = '-' + vParts[1];
            const nums = vParts[0].split('.');
            if (nums.length >= 1) major = parseInt(nums[0]) || 0;
            if (nums.length >= 2) minor = parseInt(nums[1]) || 0;
            if (nums.length >= 3) patch = parseInt(nums[2]) || 0;

            const nextPatch = `${major}.${minor}.${patch + 1}${suffix}`;
            const nextMinor = `${major}.${minor + 1}.0${suffix}`;
            const nextMajor = `${major + 1}.0.0${suffix}`;

            const versionType = await vscode.window.showQuickPick(
                [
                    { label: `Patch (Default) ${currentVersion} -> ${nextPatch}`, description: `Last saved: ${lastCommitVersion}`, type: '' },
                    { label: `Minor ${currentVersion} -> ${nextMinor}`, description: `Last saved: ${lastCommitVersion}`, type: '--minor' },
                    { label: `Major ${currentVersion} -> ${nextMajor}`, description: `Last saved: ${lastCommitVersion}`, type: '--major' },
                    { label: 'Don\'t Increment', description: 'Keep current version', type: '--no-increment' },
                    { label: 'Manual Version', description: 'Enter specific version', type: 'manual' }
                ],
                { placeHolder: 'Select version increment type' }
            );

            if (!versionType) return;

            let flag = versionType.type;
            let manualVer = '';

            if (flag === 'manual') {
                const v = await vscode.window.showInputBox({ placeHolder: 'Enter version (e.g. 1.2.3)' });
                if (!v) return;
                flag = '--set-version';
                manualVer = v;
            }

            const args = [message];
            if (flag) args.push(flag);
            if (manualVer) args.push(manualVer);

            runBetterGitCommand('save', args, targetPath, providerPath(context), betterGitProvider);
        }
    });

    // 5. Register "Undo" Command
    vscode.commands.registerCommand('bettersourcecontrol.undo', (repoPath?: string) => {
        vscode.window.showWarningMessage('Undo changes?', 'Yes', 'No')
            .then(selection => {
                if (selection === 'Yes') {
                    const targetPath = repoPath || rootPath;
                    runBetterGitCommand('undo', [], targetPath, providerPath(context), betterGitProvider);
                }
            });
    });

    // 5b. Register "Redo" Command
    vscode.commands.registerCommand('bettersourcecontrol.redo', (repoPath?: string) => {
        const targetPath = repoPath || rootPath;
        runBetterGitCommand('redo', [], targetPath, providerPath(context), betterGitProvider);
    });

    // 6. Register "Refresh" (Manual Trigger)
    vscode.commands.registerCommand('bettersourcecontrol.refresh', async () => {
        await refreshTreePreservingUiState(betterGitProvider);
    });

    // 6b. Handle directory/submodule change clicks
    vscode.commands.registerCommand('bettersourcecontrol.openDirectoryChange', async (targetAbsPath: string) => {
        const config = vscode.workspace.getConfiguration('bettergit');
        const openRepoNode = config.get<boolean>('submoduleChanges.openRepoNode', true);
        const revealInExplorer = config.get<boolean>('submoduleChanges.revealInExplorer', false);

        if (openRepoNode && betterGitTreeView) {
            const repoItem = betterGitProvider.getRepoItemByRepoPath(targetAbsPath);
            if (repoItem) {
                await betterGitTreeView.reveal(repoItem, { expand: 2, focus: true, select: true });
            } else {
                // If we can't find the node (not scanned / not in tree), fall back to explorer if enabled.
                if (!revealInExplorer) {
                    vscode.window.showInformationMessage('Submodule repo node not found in BetterGit view.');
                }
            }
        }

        if (revealInExplorer) {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(targetAbsPath));
        }
    });

    // 7. Register "Open Diff" Command
    vscode.commands.registerCommand('bettersourcecontrol.openDiff', (file: string, status: string, repoPath?: string) => {
        if (!rootPath) return;

        // We need to know which repo this file belongs to.
        // For now, we assume it's relative to the selected repo or root.
        // But the file path coming from the tree view is relative to the repo root.
        const effectiveRepoPath = repoPath || rootPath;

        let leftUri = vscode.Uri.parse(`bettergit://HEAD/${file}?repo=${encodeURIComponent(effectiveRepoPath)}`);
        let rightUri = vscode.Uri.file(path.join(effectiveRepoPath, file));

        if (status) {
            if (status.includes('Deleted')) {
                rightUri = vscode.Uri.parse(`bettergit://EMPTY/${file}?repo=${encodeURIComponent(effectiveRepoPath)}`);
            } else if (status.includes('New')) {
                leftUri = vscode.Uri.parse(`bettergit://EMPTY/${file}?repo=${encodeURIComponent(effectiveRepoPath)}`);
            }
        }

        const title = `${file} (HEAD) ↔ (Current)`;

        vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    });

    // 8. Register "Publish" Command
    vscode.commands.registerCommand('bettersourcecontrol.publish', async (repoPath?: string) => {
        const targetPath = repoPath || rootPath;
        if (!targetPath) return;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Publishing to all remotes...'
            },
            async () => {
                await runBetterGitCommand('publish', [], targetPath, providerPath(context), betterGitProvider);
            }
        );
    });

    // --- NEW: INIT ---
    vscode.commands.registerCommand('bettersourcecontrol.init', (repoPath?: string) => {
        // If invoked from a repo node, init that repo. Otherwise fall back to workspace root / open dialog.
        if (repoPath) {
            runBetterGitCommand('init', [repoPath], repoPath, providerPath(context), betterGitProvider);
            return;
        }

        if (rootPath) {
            runBetterGitCommand('init', [rootPath], rootPath, providerPath(context), betterGitProvider);
            return;
        }

        vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false })
            .then(folders => {
                if (folders && folders[0]) {
                    runBetterGitCommand('init', [folders[0].fsPath], folders[0].fsPath, providerPath(context), betterGitProvider);
                }
            });
    });

    // --- NEW: INIT NODE ---
    vscode.commands.registerCommand('bettersourcecontrol.initNode', (repoPath?: string) => {
        if (repoPath) {
            runBetterGitCommand('init', [repoPath, '--node'], repoPath, providerPath(context), betterGitProvider);
            return;
        }

        if (rootPath) {
            runBetterGitCommand('init', [rootPath, '--node'], rootPath, providerPath(context), betterGitProvider);
            return;
        }

        vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false })
            .then(folders => {
                if (folders && folders[0]) {
                    runBetterGitCommand('init', [folders[0].fsPath, '--node'], folders[0].fsPath, providerPath(context), betterGitProvider);
                }
            });
    });

    // --- NEW: RESTORE ---
    // This command receives the 'BetterGitItem' that was clicked
    vscode.commands.registerCommand('bettersourcecontrol.restore', (item: BetterGitItem) => {
        if (!item || !item.sha) return;

        vscode.window.showWarningMessage(`Restore version ${item.label}? Current changes will be swapped to an archive.`, 'Yes', 'No')
            .then(selection => {
                if (selection === 'Yes') {
                    const targetPath = item.data?.repoPath || rootPath;
                    runBetterGitCommand('restore', [item.sha], targetPath, providerPath(context), betterGitProvider);
                }
            });
    });

    // --- NEW: MERGE ---
    vscode.commands.registerCommand('bettersourcecontrol.merge', (item: BetterGitItem) => {
        if (!item || !item.sha) return;

        vscode.window.showWarningMessage(`Merge ${item.label} into current state?`, 'Yes', 'No')
            .then(selection => {
                if (selection === 'Yes') {
                    const targetPath = item.data?.repoPath || rootPath;
                    runBetterGitCommand('merge', [item.sha], targetPath, providerPath(context), betterGitProvider);
                }
            });
    });

    // --- NEW: SET CHANNEL ---
    vscode.commands.registerCommand('bettersourcecontrol.setChannel', async (repoPath?: string) => {
        const channel = await vscode.window.showQuickPick(
            ['Stable', 'Alpha', 'Beta'],
            { placeHolder: 'Select Release Channel' }
        );

        if (channel) {
            const targetPath = repoPath || rootPath;
            runBetterGitCommand('set-channel', [channel], targetPath, providerPath(context), betterGitProvider);
        }
    });
}

function providerPath(context: vscode.ExtensionContext): string {
    return context.extensionPath;
}

async function refreshTreePreservingUiState(provider: BetterGitTreeProvider): Promise<void> {
    if (!betterGitTreeView) {
        provider.refresh();
        return;
    }

    // Snapshot state before refresh, because refresh can trigger collapse events.
    const repoPathsSnapshot = Array.from(expandedRepoPaths);
    const sectionKeysSnapshot = Array.from(expandedSectionKeys);

    const selected = betterGitTreeView.selection?.[0];
    const selectedRepoPath = selected?.data?.repoPath as string | undefined;
    const selectedContext = selected?.contextValue;

    suppressTreeStateTracking = true;
    try {
        provider.refresh();
        await restoreExpandedState(provider, repoPathsSnapshot, sectionKeysSnapshot);

        // Best-effort: keep selection stable across refresh.
        if (selectedRepoPath && selectedContext) {
            if (selectedContext === 'repo-section') {
                const repoItem = provider.getRepoItemByRepoPath(selectedRepoPath);
                if (repoItem) {
                    await betterGitTreeView.reveal(repoItem, { expand: false, select: true, focus: false });
                }
            } else if (selectedContext.startsWith('section-')) {
                const sectionItem = provider.getSectionItem(selectedRepoPath, selectedContext);
                if (sectionItem) {
                    await betterGitTreeView.reveal(sectionItem, { expand: false, select: true, focus: false });
                }
            }
        }
    } finally {
        suppressTreeStateTracking = false;
    }
}

// Helper to run your C# EXE and get stdout
function execBetterGit(args: string[], cwd: string, context: vscode.ExtensionContext): Promise<string> {
    const config = vscode.workspace.getConfiguration('bettergit');
    let exePath = config.get<string>('executablePath');

    if (!exePath) {
        return Promise.reject('BetterGit executable path not configured.');
    }

    return new Promise((resolve, reject) => {
        cp.execFile(exePath!, args, { cwd: cwd }, (err, stdout, stderr) => {
            if (err) {
                reject(stderr || err.message);
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

// Helper to run your C# EXE
function runBetterGitCommand(command: string, args: string[], cwd: string | undefined, extPath: string, provider: BetterGitTreeProvider): Promise<void> {
    if (!cwd) {
        // If running init from a blank window, we might not have a CWD, so we don't pass one to exec
        if (command !== 'init') return Promise.resolve();
    }

    const config = vscode.workspace.getConfiguration('bettergit');
    let exePath = config.get<string>('executablePath');

    if (!exePath) {
        outputChannel.appendLine(`[ERROR] BetterGit executable path is not configured. Please set "bettergit.executablePath" in settings.`);
        vscode.window.showErrorMessage('BetterGit executable path is not configured. Please set "bettergit.executablePath" in settings.');
        return Promise.resolve();
    }

    // Log the command being executed
    outputChannel.appendLine(`[${new Date().toISOString()}] Running: ${command} ${args.join(' ')}${cwd ? ` (in ${cwd})` : ''}`);

    // Fix: Ensure we don't double quote if args already has quotes, but here args is constructed by us.
    // The command string needs to be carefully constructed.
    return new Promise<void>((resolve) => {
        cp.execFile(exePath, [command, ...args], { cwd: cwd }, async (err, stdout, stderr) => {
            try {
                // BetterGit may write warnings/errors to stderr even when it exits with code 0.
                // Surface stderr so actions like Publish don't appear to do nothing.
                const trimmedStdout = (stdout || '').trim();
                const trimmedStderr = (stderr || '').trim();

                if (trimmedStdout) {
                    outputChannel.appendLine(`[OUTPUT] ${trimmedStdout}`);
                    vscode.window.showInformationMessage(trimmedStdout);
                }

                if (err) {
                    const detail = trimmedStderr || String(err);
                    outputChannel.appendLine(`[ERROR] ${detail}`);
                    vscode.window.showErrorMessage('BetterGit Error: ' + detail);
                } else if (trimmedStderr) {
                    // Exit code 0, but stderr has content.
                    outputChannel.appendLine(`[WARN] ${trimmedStderr}`);
                    if (trimmedStderr.toLowerCase().includes('failed') || trimmedStderr.toLowerCase().includes('error')) {
                        vscode.window.showErrorMessage('BetterGit: ' + trimmedStderr);
                    } else {
                        vscode.window.showWarningMessage('BetterGit: ' + trimmedStderr);
                    }
                }
            } finally {
                // Always refresh after an attempted action so the UI reflects the latest state.
                await refreshTreePreservingUiState(provider);
                resolve();
            }
        });
    });
}

async function restoreExpandedState(provider: BetterGitTreeProvider, repoPaths: string[], sectionKeys: string[]): Promise<void> {
    if (!betterGitTreeView) return;

    // Defer slightly so the provider has a chance to re-scan and re-materialize nodes.
    await new Promise(resolve => setTimeout(resolve, 75));

    // Restore repo expansions first, then section expansions.
    for (const repoKey of repoPaths) {
        // repoKey is normalized; provider expects the real absolute path. Try to find any cached item that matches.
        const repoItem = provider.getRepoItemByRepoPath(repoKey) || provider.getRepoItemByRepoPath(repoKey.toUpperCase()) || provider.getRepoItemByRepoPath(repoKey.toLowerCase());
        if (!repoItem) continue;
        try {
            await betterGitTreeView.reveal(repoItem, { expand: 1, select: false, focus: false });
        } catch {
            // ignore
        }
    }

    for (const key of sectionKeys) {
        const [repoKey, section] = key.split('|');
        if (!repoKey || !section) continue;

        // Best-effort: provider caches section items by repoPath+context.
        const sectionItem = provider.getSectionItem(repoKey, section);
        if (!sectionItem) continue;
        try {
            await betterGitTreeView.reveal(sectionItem, { expand: 1, select: false, focus: false });
        } catch {
            // ignore
        }
    }
}
