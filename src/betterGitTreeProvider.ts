import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

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
                const items: BetterGitItem[] = [];

                // 1. Repositories Section (if multiple)
                const hasSubmodules = repos && repos.submodules && repos.submodules.length > 0;
                const hasNested = repos && repos.nested && repos.nested.length > 0;

                if (hasSubmodules || hasNested) {
                    items.push(new BetterGitItem('Repositories', vscode.TreeItemCollapsibleState.Expanded, 'section-repos', ''));
                }

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
                        // Show Active Repo Name if we have multiple repos
                        if (hasSubmodules || hasNested) {
                            const name = path.basename(this.selectedRepoPath!);
                            items.push(new BetterGitItem(`Active: ${name}`, vscode.TreeItemCollapsibleState.None, 'info', ''));
                        }

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
            const items: BetterGitItem[] = [];
            
            // Root Repo (if it is one)
            // We assume workspaceRoot is the root repo.
            const rootItem = new BetterGitItem('Root Repository', vscode.TreeItemCollapsibleState.None, 'repo-item', '');
            rootItem.description = path.basename(this.workspaceRoot);
            rootItem.command = { command: 'bettersourcecontrol.selectRepo', title: 'Select', arguments: [this.workspaceRoot] };
            if (this.selectedRepoPath === this.workspaceRoot) rootItem.iconPath = new vscode.ThemeIcon('check');
            items.push(rootItem);

            if (this.repoData.submodules.length > 0) {
                items.push(new BetterGitItem('Submodules', vscode.TreeItemCollapsibleState.Collapsed, 'group-submodules', ''));
            }
            if (this.repoData.nested.length > 0) {
                items.push(new BetterGitItem('Nested Repositories', vscode.TreeItemCollapsibleState.Collapsed, 'group-nested', ''));
            }
            return Promise.resolve(items);
        }

        if (element.contextValue === 'group-submodules') {
            return Promise.resolve(this.repoData.submodules.map((r: any) => {
                const item = new BetterGitItem(r.name, vscode.TreeItemCollapsibleState.None, 'repo-item', '');
                // item.description = r.path; // Removed as requested
                const absPath = path.join(this.workspaceRoot!, r.path);
                item.command = { command: 'bettersourcecontrol.selectRepo', title: 'Select', arguments: [absPath] };
                if (this.selectedRepoPath === absPath) item.iconPath = new vscode.ThemeIcon('check');
                return item;
            }));
        }

        if (element.contextValue === 'group-nested') {
            return Promise.resolve(this.repoData.nested.map((r: any) => {
                const item = new BetterGitItem(r.name, vscode.TreeItemCollapsibleState.None, 'repo-item', '');
                item.description = r.path;
                const absPath = path.join(this.workspaceRoot!, r.path);
                item.command = { command: 'bettersourcecontrol.selectRepo', title: 'Select', arguments: [absPath] };
                if (this.selectedRepoPath === absPath) item.iconPath = new vscode.ThemeIcon('check');
                return item;
            }));
        }

        // Standard Sections
        return this.getDataFromCSharp(element.contextValue);
    }

    private scanRepositories(): Promise<any> {
        if (this.repoData) return Promise.resolve(this.repoData);

        return new Promise(resolve => {
            const config = vscode.workspace.getConfiguration('bettergit');
            let exePath = config.get<string>('executablePath');

            if (!exePath) {
                resolve({ submodules: [], nested: [] });
                return;
            }

            // Call scan-repos
            cp.exec(`"${exePath}" scan-repos --path "${this.workspaceRoot}"`, { cwd: this.workspaceRoot }, (err, stdout) => {
                if (err) {
                    resolve({ submodules: [], nested: [] });
                    return;
                }
                try {
                    const data = JSON.parse(stdout);
                    this.repoData = data;
                    resolve(data);
                } catch {
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
                resolve(null);
                return;
            }

            // Pass --path to get-tree-data
            cp.exec(`"${exePath}" get-tree-data --path "${repoPath}"`, { cwd: repoPath }, (err, stdout) => {
                if (err) {
                    resolve(null);
                    return;
                }
                try {
                    resolve(JSON.parse(stdout));
                } catch {
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
        public readonly resourceUri?: vscode.Uri
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