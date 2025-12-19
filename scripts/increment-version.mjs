import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = path.join(extensionRoot, 'package.json');
const metaTomlPath = path.join(extensionRoot, '.betterGit', 'meta.toml');

function fail(message) {
	console.error(message);
	process.exit(1);
}

if (!fs.existsSync(packageJsonPath)) {
	fail(`package.json not found at: ${packageJsonPath}`);
}

if (!fs.existsSync(metaTomlPath)) {
	fail(`meta.toml not found at: ${metaTomlPath}`);
}

const pnpmResult = spawnSync('pnpm', ['version', 'patch', '--no-git-tag-version'], {
	cwd: extensionRoot,
	stdio: 'inherit',
	shell: process.platform === 'win32',
});

if (pnpmResult.status !== 0) {
	process.exit(pnpmResult.status ?? 1);
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const version = String(packageJson.version ?? '').trim();

const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+].*)?$/.exec(version);
if (!match) {
	fail(`Unexpected package.json version format: ${version}`);
}

const major = Number(match[1]);
const minor = Number(match[2]);
const patch = Number(match[3]);

let metaToml = fs.readFileSync(metaTomlPath, 'utf8');

function setTomlNumber(key, value) {
	const re = new RegExp(`^${key}\\s*=\\s*\\d+\\s*$`, 'm');
	if (re.test(metaToml)) {
		metaToml = metaToml.replace(re, `${key} = ${value}`);
		return;
	}
	if (!metaToml.endsWith('\n')) {
		metaToml += '\n';
	}
	metaToml += `${key} = ${value}\n`;
}

setTomlNumber('major', major);
setTomlNumber('minor', minor);
setTomlNumber('patch', patch);

fs.writeFileSync(metaTomlPath, metaToml, 'utf8');
console.log(`Synced .betterGit/meta.toml to ${major}.${minor}.${patch}`);
