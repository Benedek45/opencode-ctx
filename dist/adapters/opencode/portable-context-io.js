// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Project-confined handoff file access for a workspace whose concurrent writers
// are trusted. Static traversal/symlinks are rejected and identities are
// rechecked, but Node's pathname APIs cannot pin parent lookup like openat(2).
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PORTABLE_LIMITS } from "./portable-context.js";
const NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
export function parseHandoffArguments(argumentsText, allowOverwrite) {
    if (typeof argumentsText !== "string")
        throw new Error("portable-context-io: arguments must be a string");
    if (typeof allowOverwrite !== "boolean")
        throw new Error("portable-context-io: allowOverwrite must be boolean");
    const tokens = tokenizeArguments(argumentsText);
    let path;
    let overwrite = false;
    for (const token of tokens) {
        if (token === "--overwrite") {
            if (!allowOverwrite)
                throw new Error("portable-context-io: --overwrite is not allowed for this command");
            if (overwrite)
                throw new Error("portable-context-io: duplicate --overwrite option");
            overwrite = true;
        }
        else if (token.startsWith("-")) {
            throw new Error(`portable-context-io: unknown option ${JSON.stringify(token)}`);
        }
        else if (path !== undefined) {
            throw new Error("portable-context-io: expected at most one path");
        }
        else {
            if (token.length === 0)
                throw new Error("portable-context-io: path cannot be empty");
            path = token;
        }
    }
    return { path: path ?? ".ctx/context.json", overwrite };
}
export async function readBundleFile(projectRoot, path, limits) {
    const maxFileBytes = resolveMaxFileBytes(limits);
    const resolved = await resolveProjectPath(projectRoot, path, false);
    await recheckDirectories(resolved.directories);
    const pathBefore = await lstat(resolved.target);
    if (pathBefore.isSymbolicLink())
        throw new Error("portable-context-io: refusing symbolic-link file");
    validateRegularFile(pathBefore, "input file");
    if (pathBefore.size > maxFileBytes) {
        throw new Error(`portable-context-io: input exceeds maxFileBytes (${pathBefore.size} > ${maxFileBytes})`);
    }
    await recheckDirectories(resolved.directories);
    let handle;
    try {
        handle = await open(resolved.target, constants.O_RDONLY | NOFOLLOW);
    }
    catch (error) {
        if (isCode(error, "ELOOP"))
            throw new Error("portable-context-io: refusing symbolic-link file");
        throw error;
    }
    try {
        const before = await handle.stat();
        validateRegularFile(before, "input file");
        if (!sameIdentity(pathBefore, before))
            throw new Error("portable-context-io: input file changed during open");
        if (before.size > maxFileBytes) {
            throw new Error(`portable-context-io: input exceeds maxFileBytes (${before.size} > ${maxFileBytes})`);
        }
        const leaf = await lstat(resolved.target);
        if (leaf.isSymbolicLink() || !leaf.isFile() || !sameIdentity(before, leaf)) {
            throw new Error("portable-context-io: input file changed during open");
        }
        await recheckDirectories(resolved.directories);
        const data = Buffer.allocUnsafe(before.size);
        let total = 0;
        while (total < data.byteLength) {
            const { bytesRead } = await handle.read(data, total, data.byteLength - total, null);
            if (bytesRead === 0)
                break;
            total += bytesRead;
        }
        const probe = Buffer.allocUnsafe(1);
        if ((await handle.read(probe, 0, 1, null)).bytesRead !== 0) {
            throw new Error("portable-context-io: input grew while reading");
        }
        const after = await handle.stat();
        validateRegularFile(after, "input file");
        if (!sameIdentity(before, after))
            throw new Error("portable-context-io: input identity changed while reading");
        if (after.size !== before.size || total !== after.size
            || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            throw new Error("portable-context-io: input file changed while reading");
        }
        const leafAfter = await lstat(resolved.target);
        if (leafAfter.isSymbolicLink() || !leafAfter.isFile() || !sameIdentity(after, leafAfter)) {
            throw new Error("portable-context-io: input path changed while reading");
        }
        await recheckDirectories(resolved.directories);
        return data;
    }
    finally {
        await handle.close();
    }
}
export async function writeBundleFile(projectRoot, path, bytes, overwrite = false, onPublished) {
    if (!(bytes instanceof Uint8Array))
        throw new Error("portable-context-io: bytes must be a Uint8Array");
    if (typeof overwrite !== "boolean")
        throw new Error("portable-context-io: overwrite must be boolean");
    if (bytes.byteLength > PORTABLE_LIMITS.maxFileBytes) {
        throw new Error(`portable-context-io: output exceeds maxFileBytes (${bytes.byteLength} > ${PORTABLE_LIMITS.maxFileBytes})`);
    }
    const resolved = await resolveProjectPath(projectRoot, path, true);
    await recheckDirectories(resolved.directories);
    // The caller owns this immutable-for-the-duration input. Avoid duplicating a
    // maximum-size bundle merely to pass it to FileHandle.write().
    const data = bytes;
    const temporary = join(resolved.parent, `.ctx-context-${randomUUID()}.tmp`);
    let temporaryExists = false;
    let handle;
    try {
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
        temporaryExists = true;
        let offset = 0;
        while (offset < data.byteLength) {
            const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset, null);
            if (bytesWritten <= 0)
                throw new Error("portable-context-io: short write to temporary file");
            offset += bytesWritten;
        }
        await handle.sync();
        const temporaryStat = await handle.stat();
        validateRegularFile(temporaryStat, "temporary file");
        if (temporaryStat.nlink !== 1)
            throw new Error("portable-context-io: temporary file has unexpected hard links");
        await handle.close();
        handle = undefined;
        await recheckDirectories(resolved.directories);
        await inspectDestination(resolved.target, overwrite);
        await recheckDirectories(resolved.directories);
        const temporaryBeforePublish = await lstat(temporary);
        if (temporaryBeforePublish.isSymbolicLink() || !temporaryBeforePublish.isFile()
            || !sameIdentity(temporaryStat, temporaryBeforePublish) || temporaryBeforePublish.nlink !== 1) {
            throw new Error("portable-context-io: temporary file changed before publication");
        }
        if (overwrite) {
            // rename publishes the complete same-directory file atomically.
            await rename(temporary, resolved.target);
            onPublished?.({ path: resolved.target, dev: temporaryStat.dev, ino: temporaryStat.ino });
            temporaryExists = false;
        }
        else {
            // A hard-link creation is an atomic create-if-absent operation; unlike access()+rename it cannot clobber a racer.
            try {
                await link(temporary, resolved.target);
            }
            catch (error) {
                if (isCode(error, "EEXIST"))
                    throw destinationExistsError();
                throw error;
            }
            onPublished?.({ path: resolved.target, dev: temporaryStat.dev, ino: temporaryStat.ino });
            await rm(temporary, { force: true }).then(() => { temporaryExists = false; }, () => undefined);
        }
        const published = await lstat(resolved.target);
        if (published.isSymbolicLink() || !published.isFile() || !sameIdentity(published, temporaryStat)) {
            throw new Error("portable-context-io: published file identity mismatch");
        }
        await recheckDirectories(resolved.directories);
    }
    finally {
        if (handle)
            await handle.close().catch(() => undefined);
        if (temporaryExists)
            await rm(temporary, { force: true }).catch(() => undefined);
    }
}
function tokenizeArguments(source) {
    const tokens = [];
    let token = "";
    let started = false;
    let quote;
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (quote) {
            if (character === quote) {
                quote = undefined;
            }
            else if (quote === '"' && character === "\\") {
                const next = source[index + 1];
                if (next === '"' || next === "\\") {
                    token += next;
                    index++;
                }
                else {
                    token += character;
                }
            }
            else {
                token += character;
            }
            started = true;
            continue;
        }
        if (character === "'" || character === '"') {
            quote = character;
            started = true;
        }
        else if (/\s/.test(character)) {
            if (started) {
                tokens.push(token);
                token = "";
                started = false;
            }
        }
        else if (character === "\\") {
            const next = source[index + 1];
            if (next !== undefined && (/\s/.test(next) || next === "'" || next === '"' || next === "\\")) {
                token += next;
                index++;
            }
            else {
                token += character;
            }
            started = true;
        }
        else {
            token += character;
            started = true;
        }
    }
    if (quote)
        throw new Error("portable-context-io: unterminated quoted argument");
    if (started)
        tokens.push(token);
    return tokens;
}
function validateRelativePath(path) {
    if (typeof path !== "string" || path.length === 0)
        throw new Error("portable-context-io: path must be non-empty");
    if (path.includes("\0"))
        throw new Error("portable-context-io: path contains NUL");
    if (isAbsolute(path) || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
        throw new Error("portable-context-io: path must be project-relative");
    }
    const rawComponents = path.split(/[\\/]+/);
    if (rawComponents.some(component => component === "..")) {
        throw new Error("portable-context-io: parent traversal is not allowed");
    }
    const components = rawComponents.filter(component => component !== "" && component !== ".");
    if (components.length === 0)
        throw new Error("portable-context-io: path must name a file");
    if (components.some(component => /[:\x00-\x1f\x7f]/.test(component) || /[. ]$/.test(component)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component))) {
        throw new Error("portable-context-io: path contains a non-portable or reserved component");
    }
    if (components.some(component => component.toLowerCase() === ".git")) {
        throw new Error("portable-context-io: paths inside .git are not allowed");
    }
    return components;
}
async function resolveProjectPath(projectRoot, path, createParents) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0 || projectRoot.includes("\0") || !isAbsolute(projectRoot)) {
        throw new Error("portable-context-io: projectRoot must be an absolute path");
    }
    const components = validateRelativePath(path);
    const root = await realpath(projectRoot);
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new Error("portable-context-io: projectRoot must resolve to a directory");
    }
    const directories = [identity(root, rootStat)];
    let current = root;
    for (const component of components.slice(0, -1)) {
        current = join(current, component);
        let info;
        try {
            info = await lstat(current);
        }
        catch (error) {
            if (!createParents || !isCode(error, "ENOENT"))
                throw error;
            try {
                await mkdir(current, { mode: 0o700 });
            }
            catch (mkdirError) {
                if (!isCode(mkdirError, "EEXIST"))
                    throw mkdirError;
            }
            info = await lstat(current);
        }
        if (info.isSymbolicLink())
            throw new Error(`portable-context-io: refusing symbolic-link path component ${JSON.stringify(component)}`);
        if (!info.isDirectory())
            throw new Error(`portable-context-io: path component is not a directory: ${JSON.stringify(component)}`);
        directories.push(identity(current, info));
    }
    return { parent: current, target: join(current, components[components.length - 1]), directories };
}
async function recheckDirectories(directories) {
    for (const expected of directories) {
        const current = await lstat(expected.path);
        if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(expected, current)) {
            throw new Error("portable-context-io: parent directory identity changed during operation");
        }
    }
}
async function inspectDestination(path, overwrite) {
    let before;
    try {
        before = await lstat(path);
    }
    catch (error) {
        if (isCode(error, "ENOENT"))
            return;
        throw error;
    }
    if (before.isSymbolicLink())
        throw new Error("portable-context-io: refusing symbolic-link destination");
    if (!before.isFile())
        throw new Error("portable-context-io: destination is not a regular file");
    if (!overwrite)
        throw destinationExistsError();
    if (before.nlink > 1)
        throw new Error("portable-context-io: refusing to overwrite a hard-linked file");
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | NOFOLLOW);
        const opened = await handle.stat();
        validateRegularFile(opened, "destination");
        const after = await lstat(path);
        if (after.isSymbolicLink() || !after.isFile() || !sameIdentity(before, opened) || !sameIdentity(opened, after)) {
            throw new Error("portable-context-io: destination changed during validation");
        }
        if (opened.nlink > 1 || after.nlink > 1) {
            throw new Error("portable-context-io: refusing to overwrite a hard-linked file");
        }
    }
    finally {
        if (handle)
            await handle.close().catch(() => undefined);
    }
}
function resolveMaxFileBytes(limits) {
    if (limits !== undefined && (limits === null || typeof limits !== "object" || Array.isArray(limits))) {
        throw new Error("portable-context-io: limits must be an object");
    }
    if (limits) {
        const allowed = new Set(Object.keys(PORTABLE_LIMITS));
        for (const key of Object.keys(limits)) {
            if (!allowed.has(key))
                throw new Error(`portable-context-io: unknown limit ${JSON.stringify(key)}`);
            const value = limits[key];
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
                throw new Error(`portable-context-io: ${key} must be a non-negative safe integer`);
            }
        }
    }
    return limits?.maxFileBytes ?? PORTABLE_LIMITS.maxFileBytes;
}
function validateRegularFile(info, description) {
    if (!info.isFile())
        throw new Error(`portable-context-io: ${description} is not a regular file`);
    if (!Number.isSafeInteger(info.size) || info.size < 0)
        throw new Error(`portable-context-io: ${description} has invalid size`);
}
function identity(path, info) {
    return { path, dev: info.dev, ino: info.ino };
}
function sameIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function isCode(error, code) {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function destinationExistsError() {
    return Object.assign(new Error("portable-context-io: destination already exists"), { code: "EEXIST" });
}
//# sourceMappingURL=portable-context-io.js.map