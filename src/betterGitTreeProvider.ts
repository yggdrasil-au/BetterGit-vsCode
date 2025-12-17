import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { outputChannel } from './extension';

export class BetterGitTreeProvider implements vscode.TreeDataProvider<BetterGitItem> {

    private _onDidChangeTreeData: vscode.EventEmitter<BetterGitItem | undefined | null | void> = new vscode.EventEmitter<BetterGitItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<BetterGitItem | undefined | null | void> = this._onDidChangeTreeData.event;

    public selectedRepoPath: string | undefined;
    private repoData: any = null;

    constructor(private workspaceRoot: string | undefined, private extensionPath: string) {
        this.selectedRepoPath = workspaceRoot;
    }

    refresh(): void {
        this.repoData = null; // Clear cache to re-scan
        this._onDidChangeTreeData.fire();
    }

    selectRepo(path: string) {
        this.selectedRepoPath = path;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: BetterGitItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: BetterGitItem): Thenable<BetterGitItem[]> {
        if (!this.workspaceRoot) {
            return Promise.resolve([
                new BetterGitItem('A folder needs to be opened first before source control can be used', vscode.TreeItemCollapsibleState.None, 'info', '')
            ]);
        }

        // Root Level
        if (!element) {
            return this.scanRepositories().then(repos => {
                this.repoData = repos;
                const items: BetterGitItem[] = [];

                // 1. Repositories Section (always show for visibility, even if no children)
                // Check if root has children
                const hasChildren = repos && repos.Children && repos.Children.length > 0;

                items.push(new BetterGitItem('Repositories', vscode.TreeItemCollapsibleState.Expanded, 'section-repos', ''));

                // 2. Active Repo Status
                // Ensure selectedRepoPath is set
                if (!this.selectedRepoPath) this.selectedRepoPath = this.workspaceRoot;

                return this.getTreeData(this.selectedRepoPath!).then(data => {
                    if (!data || !data.isInitialized) {
                        const initItem = new BetterGitItem("Initialize Repository", vscode.TreeItemCollapsibleState.None, 'action', '');
                        initItem.command = { command: 'bettersourcecontrol.init', title: 'Initialize' };

                        const initNodeItem = new BetterGitItem("Initialize Node Repository", vscode.TreeItemCollapsibleState.None, 'action', '');
                        initNodeItem.command = { command: 'bettersourcecontrol.initNode', title: 'Initialize Node' };

                        items.push(initItem);
                        items.push(initNodeItem);
                    } else {
                        // Always show Active Repo Name for clarity
                        const name = path.basename(this.selectedRepoPath!);
                        items.push(new BetterGitItem(`Active: ${name}`, vscode.TreeItemCollapsibleState.None, 'info', ''));

                        items.push(new BetterGitItem('Manage Repo', vscode.TreeItemCollapsibleState.Expanded, 'section-manage', ''));
                        items.push(new BetterGitItem('Changes', vscode.TreeItemCollapsibleState.Expanded, 'section-changes', ''));
                        items.push(new BetterGitItem('Timeline', vscode.TreeItemCollapsibleState.Collapsed, 'section-timeline', ''));
                        items.push(new BetterGitItem('Archives (Undone)', vscode.TreeItemCollapsibleState.Collapsed, 'section-archives', ''));
                    }
                    return items;
                });
            });
        }

        // Repositories Section
        if (element.contextValue === 'section-repos') {
            if (this.repoData) {
                // FIX: Only show the root repo. Its children are accessible by expanding it.
                // Previously, we were pushing the root AND its children, causing duplication.
                const items: BetterGitItem[] = [this.createRepoItem(this.repoData)];
                return Promise.resolve(items);
            }
            return Promise.resolve([]);
        }

        // Repo Item (Recursive)
        if (element.contextValue === 'repo-item') {
            if (element.data && element.data.Children && element.data.Children.length > 0) {
                return Promise.resolve(element.data.Children.map((child: any) => this.createRepoItem(child)));
            }
            return Promise.resolve([]);
        }

        // Standard Sections
        return this.getDataFromCSharp(element.contextValue);
    }

    private createRepoItem(data: any): BetterGitItem {
        const hasChildren = data.Children && data.Children.length > 0;
        const state = hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;

        const item = new BetterGitItem(data.Name, state, 'repo-item', '', undefined, data);

        // Path handling
        // data.Path is relative to workspace root.
        const absPath = path.join(this.workspaceRoot!, data.Path);

        item.description = data.Path;
        item.command = { command: 'bettersourcecontrol.selectRepo', title: 'Select', arguments: [absPath] };

        // Normalize paths for comparison
        const normSelected = this.selectedRepoPath ? path.normalize(this.selectedRepoPath).toLowerCase() : '';
        const normCurrent = path.normalize(absPath).toLowerCase();

        if (normSelected === normCurrent) {
            item.iconPath = new vscode.ThemeIcon('check');
        } else {
            item.iconPath = new vscode.ThemeIcon('repo');
        }

        return item;
    }

    private scanRepositories(): Promise<any> {
        if (this.repoData) return Promise.resolve(this.repoData);

        return new Promise(resolve => {
            const config = vscode.workspace.getConfiguration('bettergit');
            let exePath = config.get<string>('executablePath');

            if (!exePath) {
                outputChannel.appendLine('[ERROR] BetterGit executable path not configured');
                resolve({ submodules: [], nested: [] });
                return;
            }

            // Call scan-repos
            outputChannel.appendLine(`[INFO] Scanning repositories in ${this.workspaceRoot}`);
            const child = cp.exec(`"${exePath}" scan-repos --path "${this.workspaceRoot}"`, { cwd: this.workspaceRoot }, (err, stdout, stderr) => {
                if (err) {
                    outputChannel.appendLine(`[ERROR] Failed to scan repositories: ${err.message}`);
                    if (stderr) {
                        outputChannel.appendLine(`[STDERR] ${stderr}`);
                    }
                    resolve({ submodules: [], nested: [] });
                    return;
                }
                if (stderr) {
                    outputChannel.appendLine(`[STDERR] ${stderr}`);
                }
                try {
                    const data = JSON.parse(stdout);
                    outputChannel.appendLine(`[INFO] Repository scan completed successfully`);
                    this.repoData = data;
                    resolve(data);
                } catch (e) {
                    outputChannel.appendLine(`[ERROR] Failed to parse repository scan output: ${e}`);
                    outputChannel.appendLine(`[DEBUG] Received stdout: "${stdout}"`);
                    resolve({ submodules: [], nested: [] });
                }
            });
        });
    }

    private getTreeData(repoPath: string): Promise<any> {
        return new Promise(resolve => {
            const config = vscode.workspace.getConfiguration('bettergit');
            let exePath = config.get<string>('executablePath');

            if (!exePath) {
                outputChannel.appendLine('[ERROR] BetterGit executable path not configured');
                resolve(null);
                return;
            }

            // Pass --path to get-tree-data
            outputChannel.appendLine(`[INFO] Loading tree data from ${repoPath}`);

            // FIX: Add maxBuffer (e.g., 10MB) to handle large JSON outputs
            cp.exec(`"${exePath}" get-tree-data --path "${repoPath}"`, { 
                cwd: repoPath,
                maxBuffer: 1024 * 1024 * 10 // 10 MB
            }, (err, stdout, stderr) => {
                if (err) {
                    outputChannel.appendLine(`[ERROR] Failed to load tree data: ${err.message}`);
                    if (stderr) {
                        outputChannel.appendLine(`[STDERR] ${stderr}`);
                    }
                    resolve(null);
                    return;
                }
                if (stderr) {
                    outputChannel.appendLine(`[STDERR] ${stderr}`);
                }
                try {
                    outputChannel.appendLine(`[INFO] Tree data loaded successfully`);
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    outputChannel.appendLine(`[ERROR] Failed to parse tree data: ${e}`);
                    outputChannel.appendLine(`[DEBUG] Received stdout: "${stdout}"`);
                    resolve(null);
                }
            });
        });
    }

    private getDataFromCSharp(section: string | undefined): Promise<BetterGitItem[]> {
        if (!this.selectedRepoPath) return Promise.resolve([]);

        return this.getTreeData(this.selectedRepoPath).then(data => {
            if (!data) {
                const errorItem = new BetterGitItem("Error loading data", vscode.TreeItemCollapsibleState.None, 'error', '');
                return [errorItem];
            }

            const items: BetterGitItem[] = [];

            if (section === 'section-manage') {
                // We only show Manage items if initialized (which is guaranteed if we are here)
                const saveItem = new BetterGitItem("Save Changes", vscode.TreeItemCollapsibleState.None, 'action', '');
                saveItem.command = { command: 'bettersourcecontrol.save', title: 'Save' };
                items.push(saveItem);

                const undoItem = new BetterGitItem("Undo Last Save", vscode.TreeItemCollapsibleState.None, 'action', '');
                undoItem.command = { command: 'bettersourcecontrol.undo', title: 'Undo' };
                items.push(undoItem);

                const redoItem = new BetterGitItem("Redo Last Undo", vscode.TreeItemCollapsibleState.None, 'action', '');
                redoItem.command = { command: 'bettersourcecontrol.redo', title: 'Redo' };
                items.push(redoItem);

                const publishItem = new BetterGitItem("Publish (Push)", vscode.TreeItemCollapsibleState.None, 'action', '');
                publishItem.command = { command: 'bettersourcecontrol.publish', title: 'Publish' };
                items.push(publishItem);
            }
            else if (section === 'section-changes') {
                data.changes.forEach((change: any) => {
                    const file = change.path;
                    const status = change.status;

                    const uri = vscode.Uri.file(path.join(this.selectedRepoPath!, file));

                    const label = path.basename(file);
                    const item = new BetterGitItem(label, vscode.TreeItemCollapsibleState.None, 'file', '', uri);

                    const dirname = path.dirname(file);
                    if (dirname && dirname !== '.') {
                        item.description = `${dirname} • ${status}`;
                    } else {
                        item.description = status;
                    }

                    // NEW: Add click command to open the file
                    if (this.workspaceRoot) {
                        item.command = {
                            command: 'bettersourcecontrol.openDiff',
                            title: 'Open Diff',
                            arguments: [file, status]
                        };
                    }
                    items.push(item);
                });
            }
            else if (section === 'section-timeline') {
                data.timeline.forEach((commit: any) => {
                    items.push(new BetterGitItem(`[${commit.version}] ${commit.message}`, vscode.TreeItemCollapsibleState.None, 'commit', commit.id));
                });
            }
            else if (section === 'section-archives') {
                data.archives.forEach((branch: any) => {
                    const label = `[${branch.version}] ${branch.message}`;
                    const item = new BetterGitItem(label, vscode.TreeItemCollapsibleState.None, 'archive-item', branch.sha);
                    item.description = branch.name;
                    items.push(item);
                });
            }

            return items;
        });
    }
}

export class BetterGitItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string, // Used to identify what type of item this is
        public readonly sha: string,
        public readonly resourceUri?: vscode.Uri,
        public readonly data?: any
    ) {
        super(label, collapsibleState);

        if (resourceUri) {
            this.resourceUri = resourceUri;
        }

        // Add icons based on type
        // If it's a file and we have a resourceUri, let VS Code handle the icon (ThemeIcon.File is default behavior for resourceUri)
        if (contextValue === 'file' && !resourceUri) this.iconPath = new vscode.ThemeIcon('file');
        if (contextValue === 'commit') this.iconPath = new vscode.ThemeIcon('git-commit');
        if (contextValue === 'archive-item') this.iconPath = new vscode.ThemeIcon('history');
        if (contextValue === 'settings') this.iconPath = new vscode.ThemeIcon('settings-gear');
        if (contextValue === 'info') this.iconPath = new vscode.ThemeIcon('info');
        if (contextValue === 'error') this.iconPath = new vscode.ThemeIcon('error');
        if (contextValue === 'action') this.iconPath = new vscode.ThemeIcon('play');
        if (contextValue === 'repo-item') this.iconPath = new vscode.ThemeIcon('repo');

        this.tooltip = sha ? `ID: ${sha}` : label;
    }
}