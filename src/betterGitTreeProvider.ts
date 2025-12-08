import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

export class BetterGitTreeProvider implements vscode.TreeDataProvider<BetterGitItem> {

    private _onDidChangeTreeData: vscode.EventEmitter<BetterGitItem | undefined | null | void> = new vscode.EventEmitter<BetterGitItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<BetterGitItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private workspaceRoot: string | undefined, private extensionPath: string) {}

    refresh(): void {
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

        // If 'element' is undefined, we are at the Root Level (Top of the tree)
        if (!element) {
            // Fetch status to decide what to show at root
            return this.getTreeData().then(data => {
                if (!data || !data.isInitialized) {
                    // Show Init Options directly at root
                    const initItem = new BetterGitItem("Initialize Repository", vscode.TreeItemCollapsibleState.None, 'action', '');
                    initItem.command = { command: 'bettersourcecontrol.init', title: 'Initialize' };
                    
                    const initNodeItem = new BetterGitItem("Initialize Node Repository", vscode.TreeItemCollapsibleState.None, 'action', '');
                    initNodeItem.command = { command: 'bettersourcecontrol.initNode', title: 'Initialize Node' };
                    
                    return [initItem, initNodeItem];
                } else {
                    // Show Sections
                    return [
                        new BetterGitItem('Manage Repo', vscode.TreeItemCollapsibleState.Expanded, 'section-manage', ''),
                        new BetterGitItem('Changes', vscode.TreeItemCollapsibleState.Expanded, 'section-changes', ''),
                        new BetterGitItem('Timeline', vscode.TreeItemCollapsibleState.Collapsed, 'section-timeline', ''),
                        new BetterGitItem('Archives (Undone)', vscode.TreeItemCollapsibleState.Collapsed, 'section-archives', '')
                    ];
                }
            });
        }

        // If we are opening a section, fetch data from C#
        return this.getDataFromCSharp(element.contextValue);
    }

    private getTreeData(): Promise<any> {
        return new Promise(resolve => {
            const config = vscode.workspace.getConfiguration('bettergit');
            let exePath = config.get<string>('executablePath');

            if (!exePath) {
                resolve(null);
                return;
            }

            cp.exec(`"${exePath}" get-tree-data`, { cwd: this.workspaceRoot }, (err, stdout) => {
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
        return this.getTreeData().then(data => {
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
                data.changes.forEach((file: string) => {
                    const item = new BetterGitItem(file, vscode.TreeItemCollapsibleState.None, 'file', '');

                    // NEW: Add click command to open the file
                    if (this.workspaceRoot) {
                        item.command = {
                            command: 'bettersourcecontrol.openDiff',
                            title: 'Open Diff',
                            arguments: [file]
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
                    items.push(new BetterGitItem(branch.name, vscode.TreeItemCollapsibleState.None, 'archive-item', branch.sha));
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
        public readonly sha: string
    ) {
        super(label, collapsibleState);

        // Add icons based on type
        if (contextValue === 'file') this.iconPath = new vscode.ThemeIcon('file');
        if (contextValue === 'commit') this.iconPath = new vscode.ThemeIcon('git-commit');
        if (contextValue === 'archive-item') this.iconPath = new vscode.ThemeIcon('history');
        if (contextValue === 'settings') this.iconPath = new vscode.ThemeIcon('settings-gear');
        if (contextValue === 'info') this.iconPath = new vscode.ThemeIcon('info');
        if (contextValue === 'error') this.iconPath = new vscode.ThemeIcon('error');
        if (contextValue === 'action') this.iconPath = new vscode.ThemeIcon('play');

        this.tooltip = sha ? `ID: ${sha}` : label;
    }
}