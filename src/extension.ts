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
        const message = await vscode.window.showInputBox({ placeHolder: 'What did you change?' });
        if (message !== undefined) {
            const versionType = await vscode.window.showQuickPick(
                [
                    { label: 'Patch (Default)', description: '0.0.X -> 0.0.X+1', type: '' },
                    { label: 'Minor', description: '0.X.0', type: '--minor' },
                    { label: 'Major', description: 'X.0.0', type: '--major' }
                ],
                { placeHolder: 'Select version increment type' }
            );

            const flag = versionType ? versionType.type : '';
            const targetPath = repoPath || rootPath;
            const args = flag ? [message, flag] : [message];
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
    vscode.commands.registerCommand('bettersourcecontrol.refresh', () => betterGitProvider.refresh());

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
        cp.execFile(exePath, [command, ...args], { cwd: cwd }, (err, stdout, stderr) => {
            try {
                if (err) {
                    if (stderr) {
                        outputChannel.appendLine(`[ERROR] ${stderr}`);
                        vscode.window.showErrorMessage('BetterGit Error: ' + stderr);
                    } else {
                        outputChannel.appendLine(`[ERROR] ${String(err)}`);
                        vscode.window.showErrorMessage('BetterGit Error: ' + String(err));
                    }
                } else {
                    if (stdout) {
                        outputChannel.appendLine(`[OUTPUT] ${stdout}`);
                        vscode.window.showInformationMessage(stdout);
                    }
                    provider.refresh(); // Update the tree view after action
                    restoreExpandedState(provider);
                }
            } finally {
                resolve();
            }
        });
    });
}

function restoreExpandedState(provider: BetterGitTreeProvider) {
    if (!betterGitTreeView) return;

    // Restore repo expansions first, then section expansions.
    const repoPaths = Array.from(expandedRepoPaths);
    const sectionKeys = Array.from(expandedSectionKeys);

    // Defer slightly so the provider has a chance to re-scan and re-materialize nodes.
    setTimeout(async () => {
        for (const repoKey of repoPaths) {
            // repoKey is normalized; provider expects the real absolute path. Try to find any cached item that matches.
            const repoItem = provider.getRepoItemByRepoPath(repoKey) || provider.getRepoItemByRepoPath(repoKey.toUpperCase()) || provider.getRepoItemByRepoPath(repoKey.toLowerCase());
            if (repoItem) {
                try {
                    await betterGitTreeView!.reveal(repoItem, { expand: 1, select: false, focus: false });
                } catch {
                    // ignore
                }
            }
        }

        for (const key of sectionKeys) {
            const [repoKey, section] = key.split('|');
            if (!repoKey || !section) continue;

            // Best-effort: provider caches section items by repoPath+context.
            const sectionItem = provider.getSectionItem(repoKey, section);
            if (sectionItem) {
                try {
                    await betterGitTreeView!.reveal(sectionItem, { expand: 1, select: false, focus: false });
                } catch {
                    // ignore
                }
            }
        }
    }, 75);
}
