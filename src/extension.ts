import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { BetterGitTreeProvider, BetterGitItem } from './betterGitTreeProvider';
import { BetterGitContentProvider } from './betterGitContentProvider';

export function activate(context: vscode.ExtensionContext) {

    const rootPath = (vscode.workspace.workspaceFolders && (vscode.workspace.workspaceFolders.length > 0))
        ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined;

    // 1. Initialize the Tree Data Provider
    const betterGitProvider = new BetterGitTreeProvider(rootPath, context.extensionPath);

    // 2. Register the Tree View
    vscode.window.registerTreeDataProvider('BetterSourceControlView', betterGitProvider);

    // 3. Register Content Provider for Diffs
    const contentProvider = new BetterGitContentProvider(context.extensionPath, rootPath);
    vscode.workspace.registerTextDocumentContentProvider('bettergit', contentProvider);

    // 4. Register "Save" Command
    vscode.commands.registerCommand('bettersourcecontrol.save', async () => {
        const message = await vscode.window.showInputBox({ placeHolder: 'What did you change?' });
        if (message) {
            const versionType = await vscode.window.showQuickPick(
                [
                    { label: 'Patch (Default)', description: '0.0.X -> 0.0.X+1', type: '' },
                    { label: 'Minor', description: '0.X.0', type: '--minor' },
                    { label: 'Major', description: 'X.0.0', type: '--major' }
                ],
                { placeHolder: 'Select version increment type' }
            );

            const flag = versionType ? versionType.type : '';
            runBetterGitCommand('save', `"${message}" ${flag}`, rootPath, context.extensionPath, betterGitProvider);
        }
    });

    // 5. Register "Undo" Command
    vscode.commands.registerCommand('bettersourcecontrol.undo', () => {
        vscode.window.showWarningMessage('Undo changes?', 'Yes', 'No')
            .then(selection => {
                if (selection === 'Yes') {
                    runBetterGitCommand('undo', '', rootPath, context.extensionPath, betterGitProvider);
                }
            });
    });

    // 5b. Register "Redo" Command
    vscode.commands.registerCommand('bettersourcecontrol.redo', () => {
        runBetterGitCommand('redo', '', rootPath, context.extensionPath, betterGitProvider);
    });

    // 6. Register "Refresh" (Manual Trigger)
    vscode.commands.registerCommand('bettersourcecontrol.refresh', () => betterGitProvider.refresh());

    // 7. Register "Open Diff" Command
    vscode.commands.registerCommand('bettersourcecontrol.openDiff', (file: string) => {
        if (!rootPath) return;
        
        const leftUri = vscode.Uri.parse(`bettergit://HEAD/${file}`);
        const rightUri = vscode.Uri.file(path.join(rootPath, file));
        const title = `${file} (HEAD) ↔ (Current)`;
        
        vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    });

    // 8. Register "Publish" Command
    vscode.commands.registerCommand('bettersourcecontrol.publish', () => {
        vscode.window.showInformationMessage('Publishing to all remotes...', 'Cancel')
            .then(selection => {
                if (selection !== 'Cancel') {
                    runBetterGitCommand('publish', '', rootPath, context.extensionPath, betterGitProvider);
                }
            });
    });

    // --- NEW: INIT ---
    vscode.commands.registerCommand('bettersourcecontrol.init', () => {
        // If we have an open folder, init there. Otherwise ask user to pick one.
        if (rootPath) {
            runBetterGitCommand('init', `"${rootPath}"`, rootPath, context.extensionPath, betterGitProvider);
        } else {
             vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false })
                .then(folders => {
                    if (folders && folders[0]) {
                        runBetterGitCommand('init', `"${folders[0].fsPath}"`, folders[0].fsPath, context.extensionPath, betterGitProvider);
                    }
                });
        }
    });

    // --- NEW: INIT NODE ---
    vscode.commands.registerCommand('bettersourcecontrol.initNode', () => {
        if (rootPath) {
            runBetterGitCommand('init', `"${rootPath}" --node`, rootPath, context.extensionPath, betterGitProvider);
        } else {
             vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false })
                .then(folders => {
                    if (folders && folders[0]) {
                        runBetterGitCommand('init', `"${folders[0].fsPath}" --node`, folders[0].fsPath, context.extensionPath, betterGitProvider);
                    }
                });
        }
    });

    // --- NEW: RESTORE ---
    // This command receives the 'BetterGitItem' that was clicked
    vscode.commands.registerCommand('bettersourcecontrol.restore', (item: BetterGitItem) => {
        if (!item || !item.sha) return;

        vscode.window.showWarningMessage(`Restore version ${item.label}? Current changes will be swapped to an archive.`, 'Yes', 'No')
            .then(selection => {
                if (selection === 'Yes') {
                     runBetterGitCommand('restore', item.sha, rootPath, context.extensionPath, betterGitProvider);
                }
            });
    });
}

// Helper to run your C# EXE
function runBetterGitCommand(command: string, args: string, cwd: string | undefined, extPath: string, provider: BetterGitTreeProvider) {
    if (!cwd) {
        // If running init from a blank window, we might not have a CWD, so we don't pass one to exec
        if (command !== 'init') return; 
    }

    const config = vscode.workspace.getConfiguration('bettergit');
    let exePath = config.get<string>('executablePath');

    if (!exePath) {
        vscode.window.showErrorMessage('BetterGit executable path is not configured. Please set "bettergit.executablePath" in settings.');
        return;
    }

    // Fix: Ensure we don't double quote if args already has quotes, but here args is constructed by us.
    // The command string needs to be carefully constructed.
    cp.exec(`"${exePath}" ${command} ${args}`, { cwd: cwd }, (err, stdout, stderr) => {
        if (err) {
            vscode.window.showErrorMessage('BetterGit Error: ' + stderr);
        } else {
            if (stdout) vscode.window.showInformationMessage(stdout);
            provider.refresh(); // Update the tree view after action
        }
    });
}