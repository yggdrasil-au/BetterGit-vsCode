import * as vscode from 'vscode';
import * as cp from 'node:child_process';
import * as path from 'node:path';
import { BetterGitTreeProvider, type BetterGitItem } from './betterGitTreeProvider.ts';
import { BetterGitContentProvider } from './betterGitContentProvider.ts';

// Create a global output channel for BetterGit logging
export const outputChannel = vscode.window.createOutputChannel('BetterGit');

let betterGitTreeView: vscode.TreeView<BetterGitItem> | undefined;

type LanguageModelChatModelLike = {
    id: string;
    sendRequest(messages: unknown[], options: Record<string, unknown>, token: vscode.CancellationToken): Promise<{
        text: AsyncIterable<string>;
    }>;
};

type VscodeLanguageModelApi = {
    selectChatModels(options?: unknown): Promise<LanguageModelChatModelLike[]>;
};

type VscodeWithLanguageModel = typeof vscode & {
    lm?: VscodeLanguageModelApi;
};

type VscodeWithLanguageModelStatics = typeof vscode & {
    LanguageModelChatMessage: {
        User(content: string): unknown;
    };
    LanguageModelError: new (...args: never[]) => Error;
};

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => {
        (globalThis as typeof globalThis & {
            setTimeout(handler: () => void, timeout: number): number;
        }).setTimeout(resolve, milliseconds);
    });
}

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
    // The runtime TreeView stays strongly typed as BetterGitItem; the cast keeps the Deno
    // checker aligned with the VS Code declaration shape used by the bundled extension.
    betterGitTreeView = vscode.window.createTreeView('BetterSourceControlView', {
        treeDataProvider: betterGitProvider
    }) as vscode.TreeView<BetterGitItem>;
    context.subscriptions.push(betterGitTreeView);

    // Track expanded/collapsed state so refresh doesn't collapse the view.
    betterGitTreeView.onDidExpandElement(e => {
        if (suppressTreeStateTracking) return;
        const el = e.element;
        const repoPath = el?.data?.repoPath as string | undefined;
        if ((el.contextValue === 'repo-section' || el.contextValue === 'nested-repo') && repoPath) {
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
        if ((el.contextValue === 'repo-section' || el.contextValue === 'nested-repo') && repoPath) {
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

        const inputBox = vscode.window.createInputBox();
        inputBox.placeholder = 'What did you change? (AI is generating...)';
        inputBox.busy = true;
        inputBox.show();

        const cts = new vscode.CancellationTokenSource();
        let userInterrupted = false;
        let aiGeneratedMessage = "";

        // Handle user typing: Stop AI if they start typing manually
        inputBox.onDidChangeValue(v => {
            if (inputBox.busy && v !== aiGeneratedMessage) {
                userInterrupted = true;
                cts.cancel();
                inputBox.busy = false;
                inputBox.placeholder = 'What did you change?';
            }
        });

        inputBox.onDidHide(() => {
            cts.cancel();
            inputBox.dispose();
        });

        inputBox.onDidAccept(async () => {
            const message = inputBox.value;
            inputBox.hide();
            if (message === undefined) return;

            // Get version info
            let currentVersion = '0.0.0';
            let lastCommitVersion = 'None';
            try {
                const output = await execBetterGit(['get-version-info'], targetPath, context);
                const info = JSON.parse(output);
                currentVersion = info.currentVersion || '0.0.0';
                lastCommitVersion = info.lastCommitVersion || 'None';
            } catch (_e) {
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
        });

        // -- AI COMMIT MESSAGE GENERATION --
        try {
            // 1. Check if the user has an active Copilot/Language Model available
            const lmApi = (vscode as VscodeWithLanguageModel).lm;
            const models = lmApi ? await lmApi.selectChatModels({ vendor: 'copilot' }) : [];
            const model = models[0];

            if (!model) {
                outputChannel.appendLine('[WARN] No compatible AI models found for commit message generation.');
                inputBox.busy = false;
                inputBox.placeholder = 'What did you change?';
            } else {
                outputChannel.appendLine('[INFO] Generating AI commit message...');

                // 2. Fetch the diff summary from BetterGit CLI
                const diffOutput = await execBetterGit(['diff'], targetPath, context);
                outputChannel.appendLine(`[DEBUG] Diff output length: ${diffOutput?.length || 0}`);

                // Filter out the version file from the diff so it doesn't trigger "No changes" if it's the only thing that changed
                // and doesn't clutter the AI's understanding if it's mixed with other things.
                // Assuming BetterGit uses a specific file or pattern for versions.
                // We split by "diff --git" but use a regex to ensure it's at the start of a line to avoid false splits in hunk headers.
                const diffSegments = diffOutput.split(/^diff --git /m).filter(s => s.trim().length > 0);
                outputChannel.appendLine(`[DEBUG] Found ${diffSegments.length} diff segments.`);

                const significantSegments = diffSegments.filter((chunk, idx) => {
                    const isSignificant = !chunk.startsWith('a/.betterGit/project.toml');
                    outputChannel.appendLine(`[DEBUG] Segment ${idx}: significant=${isSignificant}, preview="${chunk.substring(0, 60).replace(/\r?\n/g, ' ')}"`);
                    return isSignificant;
                });

                const significantDiff = significantSegments.length > 0 
                    ? significantSegments.map(s => 'diff --git ' + s).join('')
                    : '';

                if (significantDiff.trim().length > 0 && diffOutput.trim() !== "No changes detected") {
                    outputChannel.appendLine('[DEBUG] Diff output being sent to AI model.');
                    const vscodeLanguageModel = vscode as VscodeWithLanguageModelStatics;
                    const messages = [
                        vscodeLanguageModel.LanguageModelChatMessage.User(
                            "You are a technical git commit message generator. Your sole task is to explain the underlying intent or business logic of the changes in a single, professional line. " +
                            "CRITICAL CONSTRAINTS: " +
                            "1. DO NOT mention version numbers or version bumps (this is handled automatically). " +
                            "2. DO NOT list modified files or state that dependencies were updated just because a version changed. " +
                            "3. Use the imperative mood (e.g., 'Refine AI generation prompts' not 'Refined'). " +
                            "4. Be specific about the 'what' and 'why', avoiding generic filler like 'enhance functionality' or 'improve compatibility'. " +
                            "5. Do not use quotes, backticks, or periods."
                        ),
                        vscodeLanguageModel.LanguageModelChatMessage.User(
                            `Analyze this diff and describe the core logic changes ONLY. Ignore version increments:\n\n${significantDiff}`
                        )
                    ];

                    outputChannel.appendLine(`[DEBUG] Requesting response from model: ${model.id}`);
                    // 3. Request the response from the AI model
                    try {
                        const chatResponse = await model.sendRequest(messages, {}, cts.token);

                        for await (const fragment of chatResponse.text) {
                            if (userInterrupted) {
                                outputChannel.appendLine('[DEBUG] Generation interrupted by user.');
                                break;
                            }
                            aiGeneratedMessage += fragment;
                            inputBox.value = aiGeneratedMessage.trim().replace(/^["']|["']$/g, '');
                            outputChannel.appendLine(`[AI] ${fragment}`);
                        }
                        outputChannel.appendLine(`[DEBUG] Final generated message: "${aiGeneratedMessage}"`);
                    } catch (err) {
                        if (err instanceof vscodeLanguageModel.LanguageModelError) {
                            const languageModelError = err as Error & { code?: string | number };
                            outputChannel.appendLine(`[ERROR] Language Model Error: ${languageModelError.message} (Code: ${languageModelError.code})`);
                        } else {
                            const errorRecord = err as Record<string, unknown>;
                            const errorName = typeof errorRecord.name === 'string' ? errorRecord.name : '';
                            const errorMessage = typeof errorRecord.message === 'string' ? errorRecord.message : '';

                            if (errorName === 'CanceledError' || errorMessage.toLowerCase().includes('cancel')) {
                                outputChannel.appendLine('[INFO] AI generation canceled by user.');
                            } else {
                                outputChannel.appendLine(`[ERROR] Unexpected error during AI generation: ${err instanceof Error ? err.message : String(err)}`);
                                throw err;
                            }
                        }
                    }
                } else {
                    outputChannel.appendLine(`[DEBUG] Diff skipped logic. Significant content empty or "No changes detected".`);
                    if (diffOutput.includes('.betterGit/project.toml') && significantDiff.trim().length === 0) {
                        outputChannel.appendLine(`[DEBUG] Only version metadata changes detected. Skipping AI message.`);
                    }
                }
            }
        } catch (_e) {
            outputChannel.appendLine(`[WARN] AI generation failed or is unavailable: ${_e}`);
        } finally {
            inputBox.busy = false;
            inputBox.placeholder = 'What did you change?';
            cts.dispose();
            outputChannel.appendLine('[INFO] AI commit message generation process completed.');
        }
        // -- END AI GENERATION --
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
            const repoItem = betterGitProvider.resolveRepoItemByRepoPath(targetAbsPath);
            if (repoItem) {
                await betterGitTreeView.reveal(repoItem, { expand: 2, focus: true, select: true });
            } else {
                if (!revealInExplorer) {
                    vscode.window.showWarningMessage(`BetterGit could not find a scanned repository node for ${targetAbsPath}. Refresh BetterGit and try again.`);
                }
            }
        }

        if (revealInExplorer) {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(targetAbsPath));
        }
    });

    // 7. Register "Open Diff" Command
    vscode.commands.registerCommand('bettersourcecontrol.openDiff', (file: string, status: string, repoPath?: string) => {
        if (!file) return;
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
                await runBetterGitCommandStreaming('publish', [], targetPath, providerPath(context), betterGitProvider);
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

    // --- NEW: INIT DENO ---
    vscode.commands.registerCommand('bettersourcecontrol.initDeno', (repoPath?: string) => {
        if (repoPath) {
            runBetterGitCommand('init', [repoPath, '--deno'], repoPath, providerPath(context), betterGitProvider);
            return;
        }

        if (rootPath) {
            runBetterGitCommand('init', [rootPath, '--deno'], rootPath, providerPath(context), betterGitProvider);
            return;
        }

        vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false })
            .then(folders => {
                if (folders && folders[0]) {
                    runBetterGitCommand('init', [folders[0].fsPath, '--deno'], folders[0].fsPath, providerPath(context), betterGitProvider);
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

    // --- NEW: REMOTE META (GROUP / PUBLIC) ---
    vscode.commands.registerCommand('bettersourcecontrol.remoteMoveGroup', async (item: BetterGitItem) => {
        if (!item) return;

        const repoPath = item.data?.repoPath || rootPath;
        const remoteName = item.data?.remoteName || item.label;
        if (!repoPath || !remoteName) return;

        const currentGroup = String(item.data?.group || '');
        const group = await vscode.window.showInputBox({
            prompt: 'Move remote to group',
            placeHolder: 'e.g. Public, Private, Mirrors, Work',
            value: currentGroup || undefined
        });

        if (group === undefined) return;

        await runBetterGitCommand('remote', ['set-meta', remoteName, '--group', group], repoPath, providerPath(context), betterGitProvider);
    });

    vscode.commands.registerCommand('bettersourcecontrol.remoteTogglePublic', async (item: BetterGitItem) => {
        if (!item) return;

        const repoPath = item.data?.repoPath || rootPath;
        const remoteName = item.data?.remoteName || item.label;
        if (!repoPath || !remoteName) return;

        const isPublic = !!item.data?.isPublic;
        const flag = isPublic ? '--private' : '--public';
        await runBetterGitCommand('remote', ['set-meta', remoteName, flag], repoPath, providerPath(context), betterGitProvider);
    });

    vscode.commands.registerCommand('bettersourcecontrol.remoteSetBranch', async (item: BetterGitItem) => {
        if (!item) return;

        const repoPath = item.data?.repoPath || rootPath;
        const remoteName = item.data?.remoteName || item.label;
        if (!repoPath || !remoteName) return;

        const branch = await vscode.window.showInputBox({
            prompt: 'Set the branch this remote should publish to',
            placeHolder: 'e.g. main',
            value: String(item.data?.branch || '')
        });

        if (branch === undefined) return;

        await runBetterGitCommand('remote', ['set-meta', remoteName, '--branch', branch], repoPath, providerPath(context), betterGitProvider);
    });

    vscode.commands.registerCommand('bettersourcecontrol.remoteAdd', async (item: BetterGitItem) => {
        if (!item) return;
        const repoPath = item.data?.repoPath || rootPath;
        if (!repoPath) return;

        const remoteName = await vscode.window.showInputBox({
            prompt: 'Enter the name for the new remote mirror',
            placeHolder: 'Remote Name'
        });
        if (!remoteName) return;

        const remoteUrl = await vscode.window.showInputBox({
            prompt: `Enter the URL for remote '${remoteName}'`,
            placeHolder: 'Remote URL (https://... or git@...)'
        });
        if (!remoteUrl) return;

        const branch = await vscode.window.showInputBox({
            prompt: 'Enter the branch this mirror should publish to',
            placeHolder: 'e.g. main'
        });
        if (branch === undefined) return;

        const group = await vscode.window.showInputBox({
            prompt: 'Assign the remote to a group',
            placeHolder: 'e.g. Mirrors, Private, Public',
            value: 'Mirrors'
        });

        if (group === undefined) return;

        await runBetterGitCommand('remote', ['add', remoteName, remoteUrl, '--group', group || 'Mirrors', '--branch', branch], repoPath, providerPath(context), betterGitProvider);
    });

    vscode.commands.registerCommand('bettersourcecontrol.convertNestedRepoToSubmodule', async (item: BetterGitItem) => {
        const childRepoPath = item?.data?.repoPath as string | undefined;
        if (!childRepoPath || !rootPath) return;

        const relativePath = path.relative(rootPath, childRepoPath).replace(/\\/g, '/');
        if (!relativePath || relativePath.startsWith('../')) {
            vscode.window.showErrorMessage('BetterGit can only convert repositories inside the current workspace root.');
            return;
        }

        let remoteUrl = '';
        try {
            const remotes = JSON.parse(await execBetterGit(['remote', 'list', '--json'], childRepoPath, context));
            const origin = Array.isArray(remotes) ? remotes.find(remote => remote?.name === 'origin') : undefined;
            remoteUrl = String(origin?.fetchUrl || origin?.pushUrl || '');
        } catch (error) {
            outputChannel.appendLine(`[WARN] Could not read the nested repository origin: ${error}`);
        }

        if (!remoteUrl) {
            const enteredUrl = await vscode.window.showInputBox({
                prompt: `Enter the remote URL for submodule '${relativePath}'`,
                placeHolder: 'https://... or git@...'
            });
            if (!enteredUrl) return;
            remoteUrl = enteredUrl;
        }

        const confirmation = await vscode.window.showWarningMessage(
            `Convert '${relativePath}' into a submodule using ${remoteUrl}? Its working files and uncommitted changes will be preserved.`,
            { modal: true },
            'Convert'
        );
        if (confirmation !== 'Convert') return;

        await runBetterGitCommand('convert-to-submodule', [relativePath, remoteUrl], rootPath, providerPath(context), betterGitProvider);
    });

    // --- ADD SAFE DIRECTORY ---
    vscode.commands.registerCommand('bettersourcecontrol.addSafeDirectory', async (repoPath: string) => {
        if (!repoPath) return;
        await runBetterGitCommand('add-safe-directory', [repoPath], repoPath, context.extensionPath, betterGitProvider);
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
            if (selectedContext === 'repo-section' || selectedContext === 'nested-repo') {
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
function execBetterGit(args: string[], cwd: string, _context: vscode.ExtensionContext): Promise<string> {
    const config = vscode.workspace.getConfiguration('bettergit');
    let exePath = config.get<string>('executablePath');

    if (!exePath) {
        return Promise.reject('BetterGit executable path not configured.');
    }

    // Sanitize exePath: remove surrounding quotes if present
    if (exePath.startsWith('"') && exePath.endsWith('"')) {
        exePath = exePath.substring(1, exePath.length - 1);
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
function runBetterGitCommand(command: string, args: string[], cwd: string | undefined, _extPath: string, provider: BetterGitTreeProvider): Promise<void> {
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

    // Sanitize exePath: remove surrounding quotes if present
    if (exePath.startsWith('"') && exePath.endsWith('"')) {
        exePath = exePath.substring(1, exePath.length - 1);
    }

    // Log the command being executed
    outputChannel.appendLine(`[${new Date().toISOString()}] Running: ${command} ${args.join(' ')}${cwd ? ` (in ${cwd})` : ''}`);

    return new Promise<void>((resolve) => {
        cp.execFile(exePath, [command, ...args], { cwd: cwd }, async (err, stdout, stderr) => {
            try {
                // BetterGit may write warnings/errors to stderr even when it exits with code 0.
                // Surface stderr so actions like Publish don't appear to do nothing.
                const trimmedStdout = (stdout || '').trim();
                const trimmedStderr = (stderr || '').trim();

                const userOutputLines = trimmedStdout.split(/\r?\n/).filter(line => line.length > 0 && !line.startsWith('[INFO]'));
                const infoOutputLines = trimmedStdout.split(/\r?\n/).filter(line => line.startsWith('[INFO]'));
                for (const infoLine of infoOutputLines) {
                    outputChannel.appendLine(infoLine);
                }

                if (userOutputLines.length > 0) {
                    const userOutput = userOutputLines.join('\n');
                    outputChannel.appendLine(`[OUTPUT] ${userOutput}`);
                    vscode.window.showInformationMessage(userOutput);
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

function runBetterGitCommandStreaming(command: string, args: string[], cwd: string | undefined, _extPath: string, provider: BetterGitTreeProvider): Promise<void> {
    if (!cwd) {
        if (command !== 'init') return Promise.resolve();
    }

    const config = vscode.workspace.getConfiguration('bettergit');
    let exePath = config.get<string>('executablePath');

    if (!exePath) {
        outputChannel.appendLine(`[ERROR] BetterGit executable path is not configured. Please set "bettergit.executablePath" in settings.`);
        vscode.window.showErrorMessage('BetterGit executable path is not configured. Please set "bettergit.executablePath" in settings.');
        return Promise.resolve();
    }

    if (exePath.startsWith('"') && exePath.endsWith('"')) {
        exePath = exePath.substring(1, exePath.length - 1);
    }

    outputChannel.show(true);
    outputChannel.appendLine(`[${new Date().toISOString()}] Running: ${command} ${args.join(' ')}${cwd ? ` (in ${cwd})` : ''}`);

    return new Promise<void>((resolve) => {
        const child = cp.spawn(exePath, [command, ...args], {
            cwd: cwd,
            windowsHide: true
        });

        let stdoutBuffer = '';
        let stderrBuffer = '';
        let completed = false;

        const appendChunk = (buffer: string, chunk: string, prefix: string): string => {
            const text = buffer + chunk;
            const lines = text.split(/\r?\n/);
            const remainder = lines.pop() ?? '';

            for (const line of lines) {
                if (line.length > 0) {
                    outputChannel.appendLine(`${prefix}${line}`);
                }
            }

            return remainder;
        };

        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');

        child.stdout?.on('data', (chunk: string) => {
            stdoutBuffer = appendChunk(stdoutBuffer, chunk, '[OUTPUT] ');
        });

        child.stderr?.on('data', (chunk: string) => {
            stderrBuffer = appendChunk(stderrBuffer, chunk, '[STDERR] ');
        });

        child.on('error', async error => {
            if (completed) return;
            completed = true;
            outputChannel.appendLine(`[ERROR] Failed to start BetterGit: ${error.message}`);
            vscode.window.showErrorMessage(`BetterGit Error: ${error.message}`);
            await refreshTreePreservingUiState(provider);
            resolve();
        });

        child.on('close', async code => {
            if (completed) return;
            completed = true;
            if (stdoutBuffer.trim().length > 0) {
                outputChannel.appendLine(`[OUTPUT] ${stdoutBuffer.trim()}`);
            }
            if (stderrBuffer.trim().length > 0) {
                outputChannel.appendLine(`[STDERR] ${stderrBuffer.trim()}`);
            }

            if (code === 0) {
                outputChannel.appendLine('[INFO] Publish completed.');
            } else {
                outputChannel.appendLine(`[ERROR] BetterGit publish exited with code ${code ?? 'unknown'}`);
                vscode.window.showErrorMessage(`BetterGit publish failed with exit code ${code ?? 'unknown'}.`);
            }

            await refreshTreePreservingUiState(provider);
            resolve();
        });
    });
}

async function restoreExpandedState(provider: BetterGitTreeProvider, repoPaths: string[], sectionKeys: string[]): Promise<void> {
    if (!betterGitTreeView) return;

    // Defer slightly so the provider has a chance to re-scan and re-materialize nodes.
    await delay(75);

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
