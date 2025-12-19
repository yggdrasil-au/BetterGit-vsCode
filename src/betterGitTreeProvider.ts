import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { outputChannel } from './extension';

export class BetterGitTreeProvider implements vscode.TreeDataProvider<BetterGitItem> {

    private _onDidChangeTreeData: vscode.EventEmitter<BetterGitItem | undefined | null | void> = new vscode.EventEmitter<BetterGitItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<BetterGitItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private repoData: any = null;
    private treeDataCache: Map<string, any> = new Map();
    private treeDataErrorCache: Map<string, string> = new Map();
    private otherModulesCache: BetterGitItem[] | null = null;
    private repoItemCache: Map<string, BetterGitItem> = new Map();
    private sectionItemCache: Map<string, BetterGitItem> = new Map();
    private submoduleRelPathsByRepo: Map<string, Set<string>> = new Map();

    constructor(private workspaceRoot: string | undefined, private extensionPath: string) {
    }

    refresh(): void {
        this.repoData = null; // Clear cache to re-scan
        this.treeDataCache.clear();
        this.treeDataErrorCache.clear();
        this.otherModulesCache = null;
        // Keep item caches so the TreeView doesn't collapse and reveal() stays reliable.
        // They will be updated in-place as new scan/tree data arrives.
        this.submoduleRelPathsByRepo.clear();
        this._onDidChangeTreeData.fire();
    }

    public getRepoItemByRepoPath(repoPath: string): BetterGitItem | undefined {
        return this.repoItemCache.get(this.normalizeAbsPath(repoPath));
    }

    public getSectionItem(repoPath: string, sectionContextValue: string): BetterGitItem | undefined {
        return this.sectionItemCache.get(this.sectionKey(repoPath, sectionContextValue));
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
                this.indexRepoTreeForSubmodules();
                const items: BetterGitItem[] = [];

                // Repositories Section (always show for visibility)
                items.push(new BetterGitItem('Repositories', vscode.TreeItemCollapsibleState.Expanded, 'section-repos', ''));

                return Promise.resolve(items);
            });
        }

        // Repositories Section
        if (element.contextValue === 'section-repos') {
            if (this.repoData) {
                const mainRepoPromise = this.createRepoItemWithStatus(this.repoData);
                return mainRepoPromise.then(mainRepoItem => {
                    const items: BetterGitItem[] = [];
                    //items.push(new BetterGitItem('Main Repo', vscode.TreeItemCollapsibleState.Expanded, 'section-main-repo', ''));
                    items.push(mainRepoItem);
                    items.push(new BetterGitItem('Submodules', vscode.TreeItemCollapsibleState.Expanded, 'section-submodules', ''));
                    items.push(new BetterGitItem('Other Modules', vscode.TreeItemCollapsibleState.Collapsed, 'section-other-modules', ''));
                    return items;
                });
            }
            return Promise.resolve([]);
        }

        // Main Repo container (no children; main repo is a sibling item below the header)
        if (element.contextValue === 'section-main-repo') {
            return Promise.resolve([]);
        }

        // Submodules section (expanded by default)
        if (element.contextValue === 'section-submodules') {
            const submodules = (this.repoData?.Children || []).filter((c: any) => (c.Type || '').toLowerCase() === 'submodule');
            if (!submodules.length) return Promise.resolve([]);
            return Promise.all(submodules.map((child: any) => this.createRepoItemWithStatus(child)));
        }

        // Other modules section (collapsed by default, lazy-loaded)
        if (element.contextValue === 'section-other-modules') {
            if (this.otherModulesCache) return Promise.resolve(this.otherModulesCache);
            return this.scanOtherModules().then(repos => {
                return Promise.all(repos.map((r: any) => this.createRepoItemWithStatus(r))).then(items => {
                    this.otherModulesCache = items;
                    return items;
                });
            });
        }

        // Repo Section (children: Manage/Changes/Timeline/Archives + nested repos)
        if (element.contextValue === 'repo-section') {
            const repoPath: string | undefined = element.data?.repoPath;
            const items: BetterGitItem[] = [];

            // Show sub-submodules under their parent submodule (but never under the root repo)
            const isRootRepo = (element.data?.Type || '').toLowerCase() === 'root';
            const submoduleChildren = !isRootRepo && element.data?.Children
                ? (element.data.Children as any[]).filter(c => (c.Type || '').toLowerCase() === 'submodule')
                : [];

            const submoduleItemsPromise = submoduleChildren.length
                ? Promise.all(submoduleChildren.map(child => this.createRepoItemWithStatus(child)))
                : Promise.resolve([] as BetterGitItem[]);

            return submoduleItemsPromise.then(subItems => {
                items.push(...subItems);

                if (repoPath) {
                    items.push(this.getOrCreateSectionItem(repoPath, 'section-manage', 'Manage Repo', vscode.TreeItemCollapsibleState.Expanded));
                    items.push(this.getOrCreateSectionItem(repoPath, 'section-changes', 'Changes', vscode.TreeItemCollapsibleState.Expanded));
                    items.push(this.getOrCreateSectionItem(repoPath, 'section-timeline', 'Timeline', vscode.TreeItemCollapsibleState.Collapsed));
                    items.push(this.getOrCreateSectionItem(repoPath, 'section-archives', 'Archives (Undone)', vscode.TreeItemCollapsibleState.Collapsed));
                }

                return items;
            });
        }

        // Standard Sections (scoped to a repo)
        if (element.contextValue?.startsWith('section-')) {
            const repoPath: string | undefined = element.data?.repoPath;
            if (!repoPath) return Promise.resolve([]);
            return this.getDataFromCSharp(element.contextValue, repoPath);
        }

        return Promise.resolve([]);
    }

    private createRepoItem(data: any, hasActiveChanges: boolean): BetterGitItem {
        const state = vscode.TreeItemCollapsibleState.Collapsed;

        // Path handling
        // data.Path is relative to workspace root.
        const absPath = path.join(this.workspaceRoot!, data.Path);

        const isPublishPending = !!data.__publishPending;
        const label = hasActiveChanges ? `* ${data.Name}` : data.Name;

        const key = this.normalizeAbsPath(absPath);
        const existing = this.repoItemCache.get(key);
        if (existing) {
            existing.label = label;
            existing.description = data.Path;
            existing.iconPath = this.getRepoIcon(hasActiveChanges, isPublishPending);
            existing.data = {
                ...data,
                repoPath: absPath
            };
            return existing;
        }

        const item = new BetterGitItem(label, state, 'repo-section', '', undefined, {
            ...data,
            repoPath: absPath
        });

        item.description = data.Path;
        item.iconPath = this.getRepoIcon(hasActiveChanges, isPublishPending);

        this.repoItemCache.set(key, item);

        return item;
    }

    private async createRepoItemWithStatus(data: any): Promise<BetterGitItem> {
        const absPath = path.join(this.workspaceRoot!, data.Path);
        try {
            const treeData = await this.getTreeData(absPath);
            const hasChanges = !!(treeData && treeData.isInitialized && Array.isArray(treeData.changes) && treeData.changes.length > 0);
            const publishPending = !!(treeData && treeData.isInitialized && treeData.publish && treeData.publish.isPublishPending);
            return this.createRepoItem({ ...data, __publishPending: publishPending }, hasChanges);
        } catch {
            return this.createRepoItem(data, false);
        }
    }

    private getRepoIcon(hasActiveChanges: boolean, isPublishPending: boolean): vscode.ThemeIcon {
        // If both apply, prefer the "changes" color, since it's more immediate.
        if (hasActiveChanges) {
            return new vscode.ThemeIcon('repo', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
        }
        if (isPublishPending) {
            // Distinct color indicating local commits ahead of upstream (needs push).
            return new vscode.ThemeIcon('repo', new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'));
        }
        return new vscode.ThemeIcon('repo');
    }

    private sectionKey(repoPath: string, sectionContextValue: string): string {
        return `${this.normalizeAbsPath(repoPath)}|${sectionContextValue}`;
    }

    private getOrCreateSectionItem(
        repoPath: string,
        contextValue: string,
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState
    ): BetterGitItem {
        const key = this.sectionKey(repoPath, contextValue);
        const existing = this.sectionItemCache.get(key);
        if (existing) {
            existing.label = label;
            existing.data = { repoPath };
            return existing;
        }

        const item = new BetterGitItem(label, collapsibleState, contextValue, '', undefined, { repoPath });
        this.sectionItemCache.set(key, item);
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
            const workspaceRoot = this.workspaceRoot!;
            outputChannel.appendLine(`[INFO] Scanning repositories in ${workspaceRoot}`);
            // UI: do not scan nested repos at startup; lazy-load them under "Other Modules".
            cp.execFile(
                exePath,
                ['scan-repos', '--path', workspaceRoot, '--no-nested'],
                { cwd: workspaceRoot, encoding: 'utf8' },
                (err: cp.ExecFileException | null, stdout: string, stderr: string) => {
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
                    this.ensureRepoItemsCachedFromRepoTree();
                    this.indexRepoTreeForSubmodules();
                    resolve(data);
                } catch (e) {
                    outputChannel.appendLine(`[ERROR] Failed to parse repository scan output: ${e}`);
                    outputChannel.appendLine(`[DEBUG] Received stdout: "${stdout}"`);
                    resolve({ submodules: [], nested: [] });
                }
            });
        });
    }

    private scanOtherModules(): Promise<any[]> {
        return new Promise(resolve => {
            const config = vscode.workspace.getConfiguration('bettergit');
            const exePath = config.get<string>('executablePath');
            if (!exePath) {
                outputChannel.appendLine('[ERROR] BetterGit executable path not configured');
                resolve([]);
                return;
            }

            outputChannel.appendLine(`[INFO] Scanning other modules in ${this.workspaceRoot}`);
            cp.execFile(exePath, ['scan-nested-repos', '--path', this.workspaceRoot!], { cwd: this.workspaceRoot }, (err, stdout, stderr) => {
                if (err) {
                    outputChannel.appendLine(`[ERROR] Failed to scan other modules: ${err.message}`);
                    if (stderr) outputChannel.appendLine(`[STDERR] ${stderr}`);
                    resolve([]);
                    return;
                }
                if (stderr) outputChannel.appendLine(`[STDERR] ${stderr}`);
                try {
                    const data = JSON.parse(stdout);
                    resolve(Array.isArray(data) ? data : []);
                } catch (e) {
                    outputChannel.appendLine(`[ERROR] Failed to parse other modules output: ${e}`);
                    outputChannel.appendLine(`[DEBUG] Received stdout: "${stdout}"`);
                    resolve([]);
                }
            });
        });
    }

    private getTreeData(repoPath: string): Promise<any> {
        const cached = this.treeDataCache.get(repoPath);
        if (cached) return Promise.resolve(cached);

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
            cp.execFile(exePath, ['get-tree-data', '--path', repoPath], { 
                cwd: repoPath,
                maxBuffer: 1024 * 1024 * 10 // 10 MB
            }, (err, stdout, stderr) => {
                if (err) {
                    outputChannel.appendLine(`[ERROR] Failed to load tree data: ${err.message}`);
                    if (stderr) {
                        outputChannel.appendLine(`[STDERR] ${stderr}`);
                    }
                    this.treeDataErrorCache.set(repoPath, stderr || err.message);
                    resolve(null);
                    return;
                }
                if (stderr) {
                    outputChannel.appendLine(`[STDERR] ${stderr}`);
                }

                const trimmed = (stdout || '').trim();
                if (!trimmed) {
                    const detail = stderr ? stderr.trim() : 'Empty output from BetterGit.';
                    outputChannel.appendLine(`[ERROR] Tree data was empty for ${repoPath}. ${detail}`);
                    this.treeDataErrorCache.set(repoPath, detail);
                    resolve(null);
                    return;
                }
                try {
                    outputChannel.appendLine(`[INFO] Tree data loaded successfully`);
                    const parsed = JSON.parse(stdout);
                    this.treeDataCache.set(repoPath, parsed);
                    this.treeDataErrorCache.delete(repoPath);
                    resolve(parsed);
                } catch (e) {
                    outputChannel.appendLine(`[ERROR] Failed to parse tree data: ${e}`);
                    outputChannel.appendLine(`[DEBUG] Received stdout: "${stdout}"`);
                    this.treeDataErrorCache.set(repoPath, `Failed to parse JSON from BetterGit. ${stderr ? `STDERR: ${stderr.trim()}` : ''}`.trim());
                    resolve(null);
                }
            });
        });
    }

    private getDataFromCSharp(section: string | undefined, repoPath: string): Promise<BetterGitItem[]> {
        return this.getTreeData(repoPath).then(data => {
            if (!data) {
                const detail = this.treeDataErrorCache.get(repoPath);
                const label = detail ? `Error loading data: ${detail}` : 'Error loading data';
                const errorItem = new BetterGitItem(label, vscode.TreeItemCollapsibleState.None, 'error', '', undefined, { repoPath });
                return [errorItem];
            }

            const items: BetterGitItem[] = [];

            if (section === 'section-manage') {
                if (!data.isInitialized) {
                    const initItem = new BetterGitItem("Initialize Repository", vscode.TreeItemCollapsibleState.None, 'action', '');
                    initItem.command = { command: 'bettersourcecontrol.init', title: 'Initialize', arguments: [repoPath] };
                    items.push(initItem);

                    const initNodeItem = new BetterGitItem("Initialize Node Repository", vscode.TreeItemCollapsibleState.None, 'action', '');
                    initNodeItem.command = { command: 'bettersourcecontrol.initNode', title: 'Initialize Node', arguments: [repoPath] };
                    items.push(initNodeItem);
                } else {
                    const saveItem = new BetterGitItem("Save Changes", vscode.TreeItemCollapsibleState.None, 'action', '');
                    saveItem.command = { command: 'bettersourcecontrol.save', title: 'Save', arguments: [repoPath] };
                    items.push(saveItem);

                    const undoItem = new BetterGitItem("Undo Last Save", vscode.TreeItemCollapsibleState.None, 'action', '');
                    undoItem.command = { command: 'bettersourcecontrol.undo', title: 'Undo', arguments: [repoPath] };
                    items.push(undoItem);

                    const redoItem = new BetterGitItem("Redo Last Undo", vscode.TreeItemCollapsibleState.None, 'action', '');
                    redoItem.command = { command: 'bettersourcecontrol.redo', title: 'Redo', arguments: [repoPath] };
                    items.push(redoItem);

                    const publishItem = new BetterGitItem("Publish (Push)", vscode.TreeItemCollapsibleState.None, 'action', '');
                    publishItem.command = { command: 'bettersourcecontrol.publish', title: 'Publish', arguments: [repoPath] };
                    items.push(publishItem);

                    const channelItem = new BetterGitItem("Set Release Channel", vscode.TreeItemCollapsibleState.None, 'action', '');
                    channelItem.command = { command: 'bettersourcecontrol.setChannel', title: 'Set Release Channel', arguments: [repoPath] };
                    items.push(channelItem);
                }
            }
            else if (section === 'section-changes') {
                if (!data.isInitialized) {
                    items.push(new BetterGitItem("Repository is not initialized", vscode.TreeItemCollapsibleState.None, 'info', ''));
                    return items;
                }
                data.changes.forEach((change: any) => {
                    const file = change.path;
                    const status = change.status;

                    const absTargetPath = path.join(repoPath, file);
                    const label = path.basename(file);

                    const isSubmodule = this.isSubmoduleChange(repoPath, file) || this.pathIsDirectory(absTargetPath);
                    const uri = vscode.Uri.file(absTargetPath);

                    const item = new BetterGitItem(label, vscode.TreeItemCollapsibleState.None, isSubmodule ? 'submodule-change' : 'file', '', uri, { repoPath, targetAbsPath: absTargetPath });

                    const dirname = path.dirname(file);
                    if (dirname && dirname !== '.') {
                        item.description = `${dirname} • ${status}`;
                    } else {
                        item.description = status;
                    }

                    if (this.workspaceRoot) {
                        if (isSubmodule) {
                            item.command = {
                                command: 'bettersourcecontrol.openDirectoryChange',
                                title: 'Open',
                                arguments: [absTargetPath]
                            };
                        } else {
                            item.command = {
                                command: 'bettersourcecontrol.openDiff',
                                title: 'Open Diff',
                                arguments: [file, status, repoPath]
                            };
                        }
                    }
                    items.push(item);
                });
            }
            else if (section === 'section-timeline') {
                if (!data.isInitialized) {
                    items.push(new BetterGitItem("Repository is not initialized", vscode.TreeItemCollapsibleState.None, 'info', ''));
                    return items;
                }
                data.timeline.forEach((commit: any) => {
                    items.push(new BetterGitItem(`[${commit.version}] ${commit.message}`, vscode.TreeItemCollapsibleState.None, 'commit', commit.id, undefined, { repoPath }));
                });
            }
            else if (section === 'section-archives') {
                if (!data.isInitialized) {
                    items.push(new BetterGitItem("Repository is not initialized", vscode.TreeItemCollapsibleState.None, 'info', ''));
                    return items;
                }
                data.archives.forEach((branch: any) => {
                    const label = `[${branch.version}] ${branch.message}`;
                    const item = new BetterGitItem(label, vscode.TreeItemCollapsibleState.None, 'archive-item', branch.sha, undefined, { repoPath });
                    item.description = branch.name;
                    items.push(item);
                });
            }

            return items;
        });
    }

    private normalizeAbsPath(p: string): string {
        return path.normalize(p).toLowerCase();
    }

    private normalizeRelPath(p: string): string {
        return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    }

    private indexRepoTreeForSubmodules(): void {
        this.submoduleRelPathsByRepo.clear();
        if (!this.repoData || !this.workspaceRoot) return;

        const visit = (node: any) => {
            const repoAbs = path.join(this.workspaceRoot!, node.Path || '');
            const repoKey = this.normalizeAbsPath(repoAbs);

            if (node.Children && Array.isArray(node.Children)) {
                const submoduleRelSet = this.submoduleRelPathsByRepo.get(repoKey) ?? new Set<string>();

                for (const child of node.Children) {
                    if ((child.Type || '').toLowerCase() === 'submodule') {
                        const childAbs = path.join(this.workspaceRoot!, child.Path || '');
                        const relToParent = path.relative(repoAbs, childAbs);
                        submoduleRelSet.add(this.normalizeRelPath(relToParent));
                    }
                    visit(child);
                }

                if (submoduleRelSet.size > 0) {
                    this.submoduleRelPathsByRepo.set(repoKey, submoduleRelSet);
                }
            }
        };

        visit(this.repoData);
    }

    private ensureRepoItemsCachedFromRepoTree(): void {
        if (!this.repoData || !this.workspaceRoot) return;

        const visit = (node: any) => {
            // Creates / updates cache entry (label without change-star for now)
            this.createRepoItem(node, false);
            if (node.Children && Array.isArray(node.Children)) {
                for (const child of node.Children) {
                    visit(child);
                }
            }
        };

        visit(this.repoData);
    }

    private isSubmoduleChange(repoAbsPath: string, changeRelPath: string): boolean {
        const key = this.normalizeAbsPath(repoAbsPath);
        const set = this.submoduleRelPathsByRepo.get(key);
        if (!set) return false;
        return set.has(this.normalizeRelPath(changeRelPath));
    }

    private pathIsDirectory(absPath: string): boolean {
        try {
            return fs.existsSync(absPath) && fs.statSync(absPath).isDirectory();
        } catch {
            return false;
        }
    }
}

export class BetterGitItem extends vscode.TreeItem {
    constructor(
        public label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string, // Used to identify what type of item this is
        public readonly sha: string,
        public readonly resourceUri?: vscode.Uri,
        public data?: any
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
        if (contextValue === 'submodule-change') this.iconPath = new vscode.ThemeIcon('repo', new vscode.ThemeColor('gitDecoration.submoduleResourceForeground'));

        this.tooltip = sha ? `ID: ${sha}` : label;
    }
}