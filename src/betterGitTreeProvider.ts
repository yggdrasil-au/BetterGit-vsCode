// deno-lint-ignore-file no-explicit-any
import * as vscode from 'vscode';
import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { outputChannel } from './extension.ts';

const ThemeIconCtor = vscode.ThemeIcon as unknown as {
    new(id: string, color?: vscode.ThemeColor): vscode.ThemeIcon;
};

function createThemeIcon(id: string, color?: vscode.ThemeColor): vscode.ThemeIcon {
    return new ThemeIconCtor(id, color);
}

export class BetterGitTreeProvider implements vscode.TreeDataProvider<BetterGitItem> {

    private _onDidChangeTreeData: vscode.EventEmitter<BetterGitItem | undefined | null> = new vscode.EventEmitter<BetterGitItem | undefined | null>();
    readonly onDidChangeTreeData: vscode.Event<BetterGitItem | undefined | null> = this._onDidChangeTreeData.event;

    private repoData: any = null;
    private treeDataCache: Map<string, any> = new Map();
    private treeDataErrorCache: Map<string, string> = new Map();
    private otherModulesCache: BetterGitItem[] | null = null;
    private repoItemCache: Map<string, BetterGitItem> = new Map();
    private sectionItemCache: Map<string, BetterGitItem> = new Map();
    private submoduleRelPathsByRepo: Map<string, Set<string>> = new Map();

    // Root/header items are kept stable so VS Code preserves their expanded/collapsed UI state
    private repositoriesHeaderItem: BetterGitItem | null = null;
    private submodulesHeaderItem: BetterGitItem | null = null;
    private otherModulesHeaderItem: BetterGitItem | null = null;

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

    /**
     * Finds a scanned repository item for a directory change, materializing its stable tree item when necessary.
     */
    public resolveRepoItemByRepoPath(repoPath: string): BetterGitItem | undefined {
        const cached = this.getRepoItemByRepoPath(repoPath);
        if (cached || !this.repoData || !this.workspaceRoot) {
            return cached;
        }

        const targetKey = this.normalizeAbsPath(repoPath);
        const find = (node: any): BetterGitItem | undefined => {
            const nodePath = path.join(this.workspaceRoot!, node.Path || '');
            if (this.normalizeAbsPath(nodePath) === targetKey) {
                return this.createRepoItem(node, false, false);
            }

            if (!Array.isArray(node.Children)) {
                return undefined;
            }

            for (const child of node.Children) {
                const match = find(child);
                if (match) {
                    return match;
                }
            }

            return undefined;
        };

        return find(this.repoData);
    }

    /**
     * Returns the configured submodule paths represented by a repository status response.
     */
    public getChangedSubmodulePaths(repoPath: string, changes: unknown): string[] {
        if (!Array.isArray(changes)) {
            return [];
        }

        const paths = changes
            .map(change => typeof change?.path === 'string' ? change.path : '')
            .filter(changePath => changePath.length > 0 && this.isSubmoduleChange(repoPath, changePath))
            .map(changePath => this.normalizeRelPath(changePath));

        return [...new Set(paths)].sort((firstPath, secondPath) => firstPath.localeCompare(secondPath));
    }

    public getSectionItem(repoPath: string, sectionContextValue: string): BetterGitItem | undefined {
        return this.sectionItemCache.get(this.sectionKey(repoPath, sectionContextValue));
    }

    getTreeItem(element: BetterGitItem): vscode.TreeItem {
        return element;
    }

    getParent(element: BetterGitItem): vscode.ProviderResult<BetterGitItem> {
        return element.parent;
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
                if (!this.repositoriesHeaderItem) {
                    this.repositoriesHeaderItem = new BetterGitItem('Repositories', vscode.TreeItemCollapsibleState.Expanded, 'section-repos', '');
                } else {
                    this.repositoriesHeaderItem.label = 'Repositories';
                }
                items.push(this.repositoriesHeaderItem);

                return Promise.resolve(items);
            });
        }

        // Repositories Section
        if (element.contextValue === 'section-repos') {
            if (this.repoData) {
                // CHANGED: Use recursive build to pre-calculate all deep changes and "bubbles"
                return this.buildRepoWithStatusRecursive(this.repoData).then(result => {
                    const mainRepoItem = result.item;
                    const items: BetterGitItem[] = [];
                    items.push(mainRepoItem);

                    if (!this.submodulesHeaderItem) {
                        this.submodulesHeaderItem = new BetterGitItem('Submodules', vscode.TreeItemCollapsibleState.Expanded, 'section-submodules', '');
                    } else {
                        this.submodulesHeaderItem.label = 'Submodules';
                    }

                    if (!this.otherModulesHeaderItem) {
                        this.otherModulesHeaderItem = new BetterGitItem('Other Modules', vscode.TreeItemCollapsibleState.Collapsed, 'section-other-modules', '');
                    } else {
                        this.otherModulesHeaderItem.label = 'Other Modules';
                    }

                    items.push(this.submodulesHeaderItem);
                    items.push(this.otherModulesHeaderItem);
                    return items;
                });
            }
            return Promise.resolve([]);
        }

        // Main Repo container
        if (element.contextValue === 'section-main-repo') {
            return Promise.resolve([]);
        }

        // Submodules section (expanded by default)
        if (element.contextValue === 'section-submodules') {
            const submodules = (this.repoData?.Children || []).filter((c: any) => (c.Type || '').toLowerCase() === 'submodule');
            if (!submodules.length) return Promise.resolve([]);

            // CHANGED: Retrieve items from cache (populated by the recursive build in section-repos)
            // If for some reason missing (scan mismatch), fallback to createRepoItemWithStatus
            const items = submodules.map((child: any) => {
                const absPath = path.join(this.workspaceRoot!, child.Path || '');
                const cached = this.repoItemCache.get(this.normalizeAbsPath(absPath));
                if (cached) return Promise.resolve(cached);
                return this.createRepoItemWithStatus(child);
            });

            return Promise.all(items);
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

            // Show sub-submodules under their parent submodule
            // CHANGED: Use cached items to preserve state/icons
            const isRootRepo = (element.data?.Type || '').toLowerCase() === 'root';
            const submoduleChildren = !isRootRepo && element.data?.Children
                ? (element.data.Children as any[]).filter(c => (c.Type || '').toLowerCase() === 'submodule')
                : [];

            const submoduleItemsPromise = submoduleChildren.length
                ? Promise.all(submoduleChildren.map(child => {
                    const abs = path.join(this.workspaceRoot!, child.Path);
                    const cached = this.repoItemCache.get(this.normalizeAbsPath(abs));
                    return cached ? Promise.resolve(cached) : this.createRepoItemWithStatus(child);
                }))
                : Promise.resolve([] as BetterGitItem[]);

            return submoduleItemsPromise.then(subItems => {
                items.push(...subItems);

                if (repoPath) {
                    items.push(this.getOrCreateSectionItem(repoPath, 'section-manage', 'Manage Repo', vscode.TreeItemCollapsibleState.Expanded));
                    items.push(this.getOrCreateSectionItem(repoPath, 'section-remotes', 'Remotes', vscode.TreeItemCollapsibleState.Collapsed));
                    items.push(this.getOrCreateSectionItem(repoPath, 'section-changes', 'Changes', vscode.TreeItemCollapsibleState.Expanded));
                    items.push(this.getOrCreateSectionItem(repoPath, 'section-timeline', 'Timeline', vscode.TreeItemCollapsibleState.Collapsed));
                    items.push(this.getOrCreateSectionItem(repoPath, 'section-archives', 'Archives (Undone)', vscode.TreeItemCollapsibleState.Collapsed));
                }

                return items;
            });
        }

        // Remote Groups (scoped to a repo)
        if (element.contextValue === 'remote-group') {
            const repoPath: string | undefined = element.data?.repoPath;
            const remotes: any[] = Array.isArray(element.data?.remotes) ? element.data.remotes : [];
            if (!repoPath) return Promise.resolve([]);

            remotes.sort((a: any, b: any) => {
                const ap = String(a?.provider || '').toLowerCase();
                const bp = String(b?.provider || '').toLowerCase();
                if (ap < bp) return -1;
                if (ap > bp) return 1;
                const an = String(a?.name || '').toLowerCase();
                const bn = String(b?.name || '').toLowerCase();
                if (an < bn) return -1;
                if (an > bn) return 1;
                return 0;
            });

            return Promise.resolve(remotes.map(r => this.createRemoteItem(repoPath, r)));
        }

        // Standard Sections (scoped to a repo)
        if (element.contextValue?.startsWith('section-')) {
            const repoPath: string | undefined = element.data?.repoPath;
            if (!repoPath) return Promise.resolve([]);
            return this.getDataFromCSharp(element.contextValue, repoPath);
        }

        return Promise.resolve([]);
    }

    // --- NEW: Recursive Builder for Deep Status & Bubbling Labels ---
    private async buildRepoWithStatusRecursive(data: any): Promise<{ item: BetterGitItem, totalChangeCount: number }> {
        const absPath = path.join(this.workspaceRoot!, data.Path || '');

        // 1. Get status of current node (Async)
        let hasDirectChanges = false;
        let isPublishPending = false;
        let hasSubmoduleInChanges = false;

        try {
            const treeData = await this.getTreeData(absPath);
            const changes = (treeData && treeData.isInitialized && Array.isArray(treeData.changes)) ? treeData.changes : [];
            hasDirectChanges = changes.length > 0;

            // Check if one of the changes IS a submodule (gitlink)
            hasSubmoduleInChanges = changes.some((c: any) => this.isSubmoduleChange(absPath, c.path));

            const aheadBy = typeof treeData?.publish?.aheadBy === 'number' ? treeData.publish.aheadBy : 0;
            isPublishPending = !!(treeData && treeData.isInitialized && treeData.publish && treeData.publish.isPublishPending) || aheadBy > 0;
        } catch {
            // Ignore errors, assume no changes
        }

        // 2. Process Children (Recursively)
        const submodules = (data.Children || []).filter((c: any) => (c.Type || '').toLowerCase() === 'submodule');

        // Execute recursive calls in parallel
        const childResults = await Promise.all(submodules.map((child: any) => this.buildRepoWithStatusRecursive(child)));

        // 3. Aggregate Stats for Bubbling
        // Calculate total count of changes below this node.
        // Logic: My Total = (My Direct ? 1 : 0) + Sum(Children's Total)
        const directCount = hasDirectChanges ? 1 : 0;
        const childrenTotalCount = childResults.reduce((acc, res) => acc + res.totalChangeCount, 0);
        const totalChangeCount = directCount + childrenTotalCount;

        // 4. Construct Label
        // Format: Name [ *] [ **] [ **]
        let label = data.Name;

        // Add * if self has changes
        if (hasDirectChanges) {
            label += ' *';
        }

        // Add ** for every unit of change contributing from descendants
        // Note: The user requested 'WebDev * ** **'. This implies accumulating markers.
        for (let i = 0; i < childrenTotalCount; i++) {
            label += ' **';
        }

        // 5. Create Item and Cache It
        // We pass descendantChangeCount > 0 to getRepoIcon so it can color the root even if only sub-submodules have changes.
        const item = this.createRepoItemRaw(
            data,
            label,
            hasDirectChanges,
            isPublishPending,
            hasSubmoduleInChanges,
            childrenTotalCount > 0 // Has dirty descendants
        );

        return { item, totalChangeCount };
    }

    private createRepoItemRaw(
        data: any,
        label: string,
        hasActiveChanges: boolean,
        isPublishPending: boolean,
        hasSubmoduleInChanges: boolean,
        hasDirtyDescendants: boolean
    ): BetterGitItem {
        const state = vscode.TreeItemCollapsibleState.Collapsed;
        const absPath = path.join(this.workspaceRoot!, data.Path);

        const key = this.normalizeAbsPath(absPath);
        const existing = this.repoItemCache.get(key);

        if (existing) {
            existing.label = label;
            existing.description = data.Path;
            existing.iconPath = this.getRepoIcon(hasActiveChanges, isPublishPending, hasSubmoduleInChanges, hasDirtyDescendants);
            existing.data = { ...data, repoPath: absPath };
            return existing;
        }

        const item = new BetterGitItem(label, state, 'repo-section', '', undefined, {
            ...data,
            repoPath: absPath
        });

        item.description = data.Path;
        item.iconPath = this.getRepoIcon(hasActiveChanges, isPublishPending, hasSubmoduleInChanges, hasDirtyDescendants);

        this.repoItemCache.set(key, item);
        return item;
    }
    // -----------------------------------------------------------

    private createRepoItem(data: any, hasActiveChanges: boolean, hasSubmoduleChanges: boolean): BetterGitItem {
        // Fallback method, forwarded to new Raw method
        const label = hasActiveChanges ? `* ${data.Name}` : data.Name;
        return this.createRepoItemRaw(data, label, hasActiveChanges, !!data.__publishPending, hasSubmoduleChanges, false);
    }

    private async createRepoItemWithStatus(data: any): Promise<BetterGitItem> {
        // Legacy method: now mostly a fallback if recursion misses something
        const absPath = path.join(this.workspaceRoot!, data.Path || '');
        try {
            const treeData = await this.getTreeData(absPath);
            const changes = (treeData && treeData.isInitialized && Array.isArray(treeData.changes)) ? treeData.changes : [];
            const hasChanges = changes.length > 0;
            const hasSubmoduleChanges = changes.some((c: any) => this.isSubmoduleChange(absPath, c.path));
            const aheadBy = typeof treeData?.publish?.aheadBy === 'number' ? treeData.publish.aheadBy : 0;
            const publishPending = !!(treeData && treeData.isInitialized && treeData.publish && treeData.publish.isPublishPending) || aheadBy > 0;
            return this.createRepoItem({ ...data, __publishPending: publishPending }, hasChanges, hasSubmoduleChanges);
        } catch {
            return this.createRepoItem(data, false, false);
        }
    }

    /// set repo icon based on status
    private getRepoIcon(
        hasActiveChanges: boolean,
        isPublishPending: boolean,
        hasSubmoduleChanges: boolean, // This means a direct child submodule is modified in the git index
        hasDirtyDescendants: boolean = false // This means a submodule deeper down has changes
    ): vscode.ThemeIcon {
        if (hasActiveChanges && isPublishPending) {
            return createThemeIcon('repo', new vscode.ThemeColor('terminal.ansiBrightMagenta'));
        }
        if (hasActiveChanges) {
            return createThemeIcon('repo', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
        }
        if (isPublishPending) {
            return createThemeIcon('repo', new vscode.ThemeColor('terminal.ansiMagenta'));
        }
        if (hasDirtyDescendants) {
            return createThemeIcon('repo', new vscode.ThemeColor('terminal.ansiYellow'));
        }
        if (hasSubmoduleChanges) {
            return createThemeIcon('repo', new vscode.ThemeColor('terminal.ansiCyan'));
        }
        return createThemeIcon('repo');
    }

    private getPublishTintColor(hasActiveChanges: boolean, isPublishPending: boolean): vscode.ThemeColor | undefined {
        if (!isPublishPending) return undefined;
        return hasActiveChanges
            ? new vscode.ThemeColor('terminal.ansiBrightMagenta')
            : new vscode.ThemeColor('terminal.ansiMagenta');
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

            // Sanitize exePath: remove surrounding quotes if present
            if (exePath.startsWith('"') && exePath.endsWith('"')) {
                exePath = exePath.substring(1, exePath.length - 1);
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
            let exePath = config.get<string>('executablePath');
            if (!exePath) {
                outputChannel.appendLine('[ERROR] BetterGit executable path not configured');
                resolve([]);
                return;
            }

            // Sanitize exePath: remove surrounding quotes if present
            if (exePath.startsWith('"') && exePath.endsWith('"')) {
                exePath = exePath.substring(1, exePath.length - 1);
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

            // Sanitize exePath: remove surrounding quotes if present
            if (exePath.startsWith('"') && exePath.endsWith('"')) {
                exePath = exePath.substring(1, exePath.length - 1);
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
                const items: BetterGitItem[] = [];

                if (detail && detail.includes('is not owned by current user')) {
                    const errorItem = new BetterGitItem("Error: Repository not owned by current user.", vscode.TreeItemCollapsibleState.None, 'error', '', undefined, { repoPath });
                    errorItem.tooltip = detail;
                    items.push(errorItem);

                    const fixItem = new BetterGitItem("Fix: Add to Git Safe Directories", vscode.TreeItemCollapsibleState.None, 'action', '', undefined, { repoPath });
                    fixItem.command = { command: 'bettersourcecontrol.addSafeDirectory', title: 'Fix', arguments: [repoPath] };
                    fixItem.iconPath = createThemeIcon('shield');
                    items.push(fixItem);
                    return items;
                }

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

                    const initDenoItem = new BetterGitItem("Initialize Deno Repository", vscode.TreeItemCollapsibleState.None, 'action', '');
                    initDenoItem.command = { command: 'bettersourcecontrol.initDeno', title: 'Initialize Deno', arguments: [repoPath] };
                    items.push(initDenoItem);
                } else {
                    const hasActiveChanges = Array.isArray(data.changes) && data.changes.length > 0;
                    const aheadBy = typeof data.publish?.aheadBy === 'number' ? data.publish.aheadBy : 0;
                    const isPublishPending = !!data.publish?.isPublishPending || aheadBy > 0;

                    const saveItem = new BetterGitItem("Save Changes", vscode.TreeItemCollapsibleState.None, 'action', '');
                    saveItem.command = { command: 'bettersourcecontrol.save', title: 'Save', arguments: [repoPath] };
                    saveItem.iconPath = hasActiveChanges
                        ? createThemeIcon('save', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'))
                        : createThemeIcon('save');
                    items.push(saveItem);

                    const undoItem = new BetterGitItem("Undo Last Save", vscode.TreeItemCollapsibleState.None, 'action', '');
                    undoItem.command = { command: 'bettersourcecontrol.undo', title: 'Undo', arguments: [repoPath] };
                    undoItem.iconPath = createThemeIcon('arrow-left');
                    items.push(undoItem);

                    const redoItem = new BetterGitItem("Redo Last Undo", vscode.TreeItemCollapsibleState.None, 'action', '');
                    redoItem.command = { command: 'bettersourcecontrol.redo', title: 'Redo', arguments: [repoPath] };
                    redoItem.iconPath = createThemeIcon('arrow-right');
                    items.push(redoItem);

                    const publishItem = new BetterGitItem("Publish (Push)", vscode.TreeItemCollapsibleState.None, 'action', '');
                    publishItem.command = { command: 'bettersourcecontrol.publish', title: 'Publish', arguments: [repoPath] };
                    publishItem.iconPath = isPublishPending
                        ? createThemeIcon('cloud-upload', this.getPublishTintColor(hasActiveChanges, isPublishPending))
                        : createThemeIcon('cloud-upload');
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
            else if (section === 'section-remotes') {
                if (!data.isInitialized) {
                    items.push(new BetterGitItem("Repository is not initialized", vscode.TreeItemCollapsibleState.None, 'info', ''));
                    return items;
                }

                const remotes: any[] = Array.isArray(data.remotes) ? data.remotes : [];
                if (!remotes.length) {
                    items.push(new BetterGitItem("No remotes configured", vscode.TreeItemCollapsibleState.None, 'info', ''));
                    return items;
                }

                const groups = new Map<string, any[]>();
                for (const r of remotes) {
                    const group = String(r?.group || 'Ungrouped').trim() || 'Ungrouped';
                    const existing = groups.get(group) || [];
                    existing.push(r);
                    groups.set(group, existing);
                }

                const groupNames = Array.from(groups.keys()).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                for (const groupName of groupNames) {
                    const groupRemotes = groups.get(groupName) || [];
                    const groupItem = new BetterGitItem(
                        groupName,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'remote-group',
                        '',
                        undefined,
                        { repoPath, groupName, remotes: groupRemotes }
                    );
                    groupItem.description = `${groupRemotes.length}`;
                    groupItem.iconPath = createThemeIcon('folder');
                    items.push(groupItem);
                }

                return items;
            }
            else if (section === 'section-timeline') {
                if (!data.isInitialized) {
                    items.push(new BetterGitItem("Repository is not initialized", vscode.TreeItemCollapsibleState.None, 'info', ''));
                    return items;
                }
                const aheadBy = typeof data.publish?.aheadBy === 'number' ? data.publish.aheadBy : 0;
                const hasActiveChanges = Array.isArray(data.changes) && data.changes.length > 0;
                const isPublishPending = !!data.publish?.isPublishPending || aheadBy > 0;
                data.timeline.forEach((commit: any, index: number) => {
                    const item = new BetterGitItem(`[${commit.version}] ${commit.message}`, vscode.TreeItemCollapsibleState.None, 'commit', commit.id, undefined, { repoPath });

                    // Highlight local-only commits (not yet pushed/published).
                    if (aheadBy > 0 && index < aheadBy) {
                        item.iconPath = createThemeIcon('git-commit', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
                        item.description = 'Local only (not published)';
                        item.tooltip = `ID: ${commit.id}\nLocal only (not published)`;
                    }

                    items.push(item);
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
                    item.iconPath = createThemeIcon('history');
                    items.push(item);
                });
            }

            return items;
        });
    }

    private createRemoteItem(repoPath: string, remote: any): BetterGitItem {
        const name = String(remote?.name || 'unknown');
        const provider = String(remote?.provider || 'other');
        const branch = String(remote?.branch || '');
        const group = String(remote?.group || 'Ungrouped');
        const isPublic = !!remote?.isPublic;
        const isMisconfigured = !!remote?.isMisconfigured;
        const hasMetadata = !!remote?.hasMetadata;
        const url = String(remote?.pushUrl || remote?.fetchUrl || '');

        const pubLabel = isPublic ? 'Public' : 'Private';
        const status = isMisconfigured ? 'Misconfigured' : (hasMetadata ? provider : 'Unmanaged');
        const branchLabel = branch || 'Current branch';
        const description = url ? `${status} • ${pubLabel} • ${branchLabel}` : `${status} • ${pubLabel} • ${branchLabel} • (no url)`;

        const item = new BetterGitItem(
            name,
            vscode.TreeItemCollapsibleState.None,
            'remote-item',
            '',
            undefined,
            { repoPath, remoteName: name, provider, group, branch, isPublic, isMisconfigured, url }
        );

        item.description = description;
        item.tooltip = url
            ? `${name}\n${url}\nGroup: ${group}\nProvider: ${provider}\nBranch: ${branchLabel}\nVisibility: ${pubLabel}\nMetadata: ${hasMetadata ? 'Yes' : 'No'}`
            : `${name}\nGroup: ${group}\nProvider: ${provider}\nBranch: ${branchLabel}\nVisibility: ${pubLabel}\nMetadata: ${hasMetadata ? 'Yes' : 'No'}`;
        item.iconPath = createThemeIcon('cloud');

        return item;
    }

    private normalizeAbsPath(p: string): string {
        const normalized = path.normalize(p);
        const parsed = path.parse(normalized);
        const withoutTrailingSeparator = normalized === parsed.root
            ? normalized
            : normalized.replace(/[\\/]+$/, '');
        return withoutTrailingSeparator.toLowerCase();
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
            this.createRepoItem(node, false, false);
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
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        contextValue: string, // Used to identify what type of item this is
        public readonly sha: string,
        public override resourceUri?: vscode.Uri,
        public data?: any,
        public readonly parent?: BetterGitItem
    ) {
        super(label, collapsibleState);
        this.label = label;
        this.collapsibleState = collapsibleState;
        this.contextValue = contextValue;
        if (contextValue === 'file' && !resourceUri) {
            this.iconPath = vscode.ThemeIcon.File;
        }
        if (contextValue === 'repo-item' || contextValue === 'remote-group') {
            this.iconPath = vscode.ThemeIcon.Folder;
        }
        if (contextValue === 'submodule-change' && !resourceUri) {
            this.iconPath = vscode.ThemeIcon.File;
        }

        this.tooltip = sha ? `ID: ${sha}` : label;
    }
}
