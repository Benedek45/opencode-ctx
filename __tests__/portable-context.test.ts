// PolyForm Noncommercial License 1.0.0 — see LICENSE

import { afterEach, describe, expect, it } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createResourcePathMatcher } from "../adapters/opencode/resource-path-matcher.js";
import {
  blobId,
  canonicalJson,
  canonicalJsonByteLength,
  canonicalSha256,
  createBundle,
  decodeBundle,
  encodeBundle,
  MAX_PORTABLE_TOPIC_BYTES,
  makeBlob,
  normalizePortableTopic,
  sha256,
  validateBundle,
  type PortableBlob,
  type PortablePayload,
} from "../adapters/opencode/portable-context.js";
import {
  parseHandoffArguments,
  readBundleFile,
  writeBundleFile,
  type FilePublication,
} from "../adapters/opencode/portable-context-io.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function addBlob(target: Record<string, PortableBlob>, blob: PortableBlob): string {
  const id = blobId(blob);
  target[id] = blob;
  return id;
}

function fixture(): PortablePayload {
  const blobs: Record<string, PortableBlob> = {};
  const summaryBlobId = addBlob(blobs, makeBlob("Earlier work summarized."));
  const sourceBlobId = addBlob(blobs, makeBlob("Earlier assistant answer."));
  const textBlobId = addBlob(blobs, makeBlob("Current request."));
  const inputBlobId = addBlob(blobs, makeBlob('{"path":"src/main.ts","line":4}'));
  const outputBlobId = addBlob(blobs, makeBlob("tool output"));
  return {
    sequence: [{ type: "root", rootId: "b1" }, { type: "hot", recordId: "r2" }],
    roots: [{
      id: "b1",
      topic: "history",
      summaryBlobId,
      tier: "warm",
      sourceRecordIds: ["r1"],
      recoverable: true,
    }],
    records: {
      r1: { role: "assistant", parts: [{ type: "text", blobId: sourceBlobId }] },
      r2: {
        role: "user",
        parts: [
          { type: "text", blobId: textBlobId },
          { type: "tool", tool: "read", callId: "call-1", status: "completed", inputBlobId, outputBlobId },
        ],
      },
    },
    blobs,
  };
}

function signedBytes(payload: unknown, extraEnvelope: Record<string, unknown> = {}): Uint8Array {
  const unsigned = { format: "ctx-context", version: 1, mode: "handoff", payload, ...extraEnvelope };
  return Buffer.from(JSON.stringify({ ...unsigned, sha256: sha256(canonicalJson(unsigned)) }), "utf8");
}

describe("portable context codec", () => {
  it("finds literal overlapping resource paths with reusable bounded search", () => {
    const paths = ["/root/😀/file", "/file", "file", "/root/😀/file2", "not-present"];
    const match = createResourcePathMatcher(paths);
    for (const text of ["/root/😀/file2 /root/😀/file2", "nothing", "/file file", "/root/😀/file"]) {
      expect(match(text)).toEqual(paths.filter(path => text.includes(path)));
    }
    expect(() => match("/root/😀/file2", 1)).toThrow("too many resource");
    expect(() => createResourcePathMatcher(["a".repeat(100)], 10)).toThrow("node limit");
  });

  it("canonicalizes key order and rejects non-JSON or over-deep values", () => {
    expect(canonicalJson({ z: 1, a: { z: 2, a: true } })).toBe('{"a":{"a":true,"z":2},"z":1}');
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalJson({ value: undefined })).toThrow(/non-JSON/);
    const decorated: unknown[] = [];
    (decorated as unknown as { extra: boolean }).extra = true;
    expect(() => canonicalJson(decorated)).toThrow(/non-index array/);
    let nested: unknown = null;
    for (let index = 0; index < 66; index++) nested = { nested };
    expect(() => canonicalJson(nested)).toThrow(/depth/);
  });

  it("round-trips a pretty UTF-8 bundle and uses canonical full-blob IDs", () => {
    const payload = fixture();
    const bytes = encodeBundle(payload);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("\n  \"format\": \"ctx-context\"");
    expect(decodeBundle(bytes).payload).toEqual(payload);

    const first = makeBlob("x");
    const dependency = makeBlob("dependency");
    const bound = makeBlob("use TOKEN", [{ path: "TOKEN", blobId: blobId(dependency) }]);
    expect(blobId({ ...first, bindings: [{ path: "x", blobId: "0".repeat(64) }] })).not.toBe(blobId(first));
    expect(bound.sha256).toBe(sha256("use TOKEN"));
    expect(canonicalJsonByteLength(payload)).toBe(Buffer.byteLength(canonicalJson(payload)));
    const inMemory = createBundle(payload);
    expect(inMemory.sha256).toBe(sha256(canonicalJson({
      format: inMemory.format,
      version: inMemory.version,
      mode: inMemory.mode,
      payload: inMemory.payload,
    })));
    expect(validateBundle(inMemory)).toBe(inMemory);
  });

  it("keeps streamed canonical hashing compatible for escaped and Unicode strings", () => {
    const payload = fixture();
    const textId = (payload.records.r2.parts[0] as { type: "text"; blobId: string }).blobId;
    const textBlob = makeBlob("quote=\" slash=\\ controls=\b\f\n\r\t unicode=🙂 line=\u2028");
    const replacementId = blobId(textBlob);
    delete payload.blobs[textId];
    payload.blobs[replacementId] = textBlob;
    (payload.records.r2.parts[0] as { type: "text"; blobId: string }).blobId = replacementId;
    const bundle = createBundle(payload);
    expect(bundle.sha256).toBe(sha256(canonicalJson({
      format: bundle.format,
      version: bundle.version,
      mode: bundle.mode,
      payload: bundle.payload,
    })));
    expect(decodeBundle(encodeBundle(payload)).sha256).toBe(bundle.sha256);
  });

  it("does not split Unicode characters at a streaming hash chunk boundary", () => {
    for (const prefix of ["", "\n", "\"\\"]) {
      const value = { text: prefix + "x".repeat(65_535) + "🙂" + "y".repeat(65_535) + "🙂" };
      const canonical = canonicalJson(value);
      expect(canonicalSha256(value)).toBe(sha256(canonical));
      expect(canonicalJsonByteLength(value)).toBe(Buffer.byteLength(canonical));
    }
  });

  it("bounds binding counts, path bytes, and repeated-search work", () => {
    const dependency = makeBlob("dependency");
    const dependencyId = blobId(dependency);
    const bound = makeBlob("FIRST SECOND", [
      { path: "FIRST", blobId: dependencyId },
      { path: "SECOND", blobId: dependencyId },
    ]);
    const boundId = blobId(bound);
    const payload: PortablePayload = {
      sequence: [{ type: "hot", recordId: "r1" }],
      roots: [],
      records: { r1: { role: "user", parts: [{ type: "text", blobId: boundId }] } },
      blobs: { [boundId]: bound, [dependencyId]: dependency },
    };
    expect(() => encodeBundle(payload, { maxBindingsPerBlob: 1 })).toThrow(/maxBindingsPerBlob/);
    expect(() => encodeBundle(payload, { maxBindings: 1 })).toThrow(/maxBindings/);
    expect(() => encodeBundle(payload, { maxBindingPathBytes: 5 })).toThrow(/maxBindingPathBytes/);
    expect(() => encodeBundle(payload, { maxBindingPathBytesTotal: 10 })).toThrow(/maxBindingPathBytesTotal/);
    expect(() => encodeBundle(payload, { maxBindingSearchBytes: bound.data.length * 2 - 1 })).toThrow(/maxBindingSearchBytes/);
  });

  it("rejects control-bearing topics and deterministically normalizes legacy topics", () => {
    const payload = fixture();
    payload.roots[0].topic = "line one\nline two\u0000tail";
    expect(() => encodeBundle(payload)).toThrow(/single-line/);
    const normalized = normalizePortableTopic(`${"topic ".repeat(200)}\nnext`);
    expect(/[\r\n\u0000]/.test(normalized)).toBe(false);
    expect(Buffer.byteLength(normalized)).toBeLessThanOrEqual(MAX_PORTABLE_TOPIC_BYTES);
    expect(normalizePortableTopic(`${"topic ".repeat(200)}\nnext`)).toBe(normalized);
  });

  it("supports optional baked root exclusion and rejects non-boolean values", () => {
    const included = fixture();
    expect(decodeBundle(encodeBundle(included)).payload.roots[0].excluded ?? false).toBe(false);

    const excluded = fixture();
    excluded.roots[0].excluded = true;
    expect(decodeBundle(encodeBundle(excluded)).payload.roots[0].excluded).toBe(true);

    const invalid = fixture() as unknown as { roots: Array<Record<string, unknown>> };
    invalid.roots[0].excluded = "true";
    expect(() => encodeBundle(invalid as unknown as PortablePayload)).toThrow(/excluded must be boolean/);
    expect(() => decodeBundle(signedBytes(invalid))).toThrow(/excluded must be boolean/);
  });

  it("rejects both forms of lone UTF-16 surrogate without rejecting a valid pair", () => {
    expect(() => makeBlob("\ud800")).toThrow(/unpaired UTF-16 surrogate/);
    expect(() => makeBlob("\udc00")).toThrow(/unpaired UTF-16 surrogate/);
    expect(() => makeBlob("\ud83d\ude42")).not.toThrow();
  });

  it("round-trips binary attachments and rejects binary bindings or non-canonical base64", () => {
    const binary = makeBlob(Uint8Array.from([0, 1, 2, 255]));
    const binaryId = blobId(binary);
    const payload: PortablePayload = {
      sequence: [{ type: "hot", recordId: "r1" }],
      roots: [],
      records: { r1: { role: "user", parts: [{ type: "attachment", blobId: binaryId, mime: "application/octet-stream", name: "data.bin" }] } },
      blobs: { [binaryId]: binary },
    };
    expect(decodeBundle(encodeBundle(payload)).payload.blobs[binaryId]).toEqual(binary);
    expect(() => makeBlob(Uint8Array.from([1]), [{ path: "x", blobId: "a".repeat(64) }])).toThrow(/binary blobs/);

    const nonCanonical: PortableBlob = {
      encoding: "base64",
      data: "AB==",
      byteLength: 1,
      sha256: sha256(Uint8Array.from([0])),
      bindings: [],
    };
    const nonCanonicalId = blobId(nonCanonical);
    payload.blobs = { [nonCanonicalId]: nonCanonical };
    payload.records.r1.parts = [{ type: "attachment", blobId: nonCanonicalId, mime: "x", name: "x" }];
    expect(() => encodeBundle(payload)).toThrow(/non-canonical base64/);
  });

  it("accepts distinct record IDs with identical content", () => {
    const blob = makeBlob("same text");
    const id = blobId(blob);
    const payload: PortablePayload = {
      sequence: [{ type: "hot", recordId: "r1" }, { type: "hot", recordId: "r2" }],
      roots: [],
      records: {
        r1: { role: "user", parts: [{ type: "text", blobId: id }] },
        r2: { role: "user", parts: [{ type: "text", blobId: id }] },
      },
      blobs: { [id]: blob },
    };
    expect(decodeBundle(encodeBundle(payload)).payload.records.r2).toEqual(payload.records.r1);
  });

  it("rejects checksum mutation, invalid UTF-8, and duplicate decoded JSON keys", () => {
    const bytes = encodeBundle(fixture());
    const changed = new TextDecoder().decode(bytes).replace('"topic": "history"', '"topic": "changed"');
    expect(() => decodeBundle(Buffer.from(changed))).toThrow(/checksum/);
    expect(() => decodeBundle(Uint8Array.from([0xc3, 0x28]))).toThrow(/UTF-8/);

    const duplicate = new TextDecoder().decode(bytes).replace(
      '"format": "ctx-context",',
      '"format": "ctx-context", "\\u0066ormat": "ctx-context",',
    );
    expect(() => decodeBundle(Buffer.from(duplicate))).toThrow(/duplicate object key/);
  });

  it("rejects exact-schema violations and finite-number violations", () => {
    const payload = fixture() as PortablePayload & { extra?: boolean };
    payload.extra = true;
    expect(() => encodeBundle(payload)).toThrow(/unknown field/);
    delete payload.extra;

    const decodedPayload = structuredClone(payload) as PortablePayload & { extra?: boolean };
    decodedPayload.extra = true;
    expect(() => decodeBundle(signedBytes(decodedPayload))).toThrow(/unknown field/);

    const text = new TextDecoder().decode(encodeBundle(payload)).replace('"version": 1', '"version": 1e400');
    expect(() => decodeBundle(Buffer.from(text))).toThrow(/non-finite/);
  });

  it("enforces byte, count, edge, and depth bounds", () => {
    const payload = fixture();
    const bytes = encodeBundle(payload);
    expect(encodeBundle(payload, { maxFileBytes: bytes.byteLength })).toHaveLength(bytes.byteLength);
    expect(() => encodeBundle(payload, { maxFileBytes: bytes.byteLength - 1 })).toThrow(/maxFileBytes/);
    expect(() => decodeBundle(bytes, { maxFileBytes: bytes.byteLength - 1 })).toThrow(/maxFileBytes/);
    expect(() => encodeBundle(payload, { maxFileBytes: undefined })).not.toThrow();
    expect(() => encodeBundle(payload, { maxDecodedBytes: 1 })).toThrow(/maxDecodedBytes/);
    expect(() => encodeBundle(payload, { maxRecords: 1 })).toThrow(/maxRecords/);
    expect(() => encodeBundle(payload, { maxRoots: 0 })).toThrow(/maxRoots/);
    expect(() => encodeBundle(payload, { maxEdges: 1 })).toThrow(/maxEdges/);

    const input = makeBlob('{"a":{"b":1}}');
    const inputId = blobId(input);
    const shallow: PortablePayload = {
      sequence: [{ type: "hot", recordId: "r1" }],
      roots: [],
      records: { r1: { role: "assistant", parts: [{ type: "tool", tool: "x", callId: "c", status: "pending", inputBlobId: inputId }] } },
      blobs: { [inputId]: input },
    };
    expect(() => encodeBundle(shallow, { maxDepth: 1 })).toThrow(/depth/);
  });

  it("rejects invalid references, duplicate sequence IDs, and orphans while deduplicating shared recovery", () => {
    const missing = fixture();
    (missing.records.r2.parts[0] as { type: "text"; blobId: string }).blobId = "f".repeat(64);
    expect(() => encodeBundle(missing)).toThrow(/missing blob/);

    const duplicate = fixture();
    duplicate.sequence.push({ type: "hot", recordId: "r2" });
    expect(() => encodeBundle(duplicate)).toThrow(/duplicate hot record/);

    const overlap = fixture();
    const secondSummary = addBlob(overlap.blobs, makeBlob("second summary"));
    overlap.roots.push({ id: "b2", topic: "second", summaryBlobId: secondSummary, tier: "cold", sourceRecordIds: ["r1"], recoverable: true });
    overlap.sequence.push({ type: "root", rootId: "b2" });
    expect(() => encodeBundle(overlap)).not.toThrow();
    overlap.roots[1].sourceRecordIds.push("r1");
    expect(() => encodeBundle(overlap)).toThrow(/duplicate source record/);

    const orphan = fixture();
    addBlob(orphan.blobs, makeBlob("not referenced"));
    expect(() => encodeBundle(orphan)).toThrow(/orphan blob/);
  });

  it("rejects binding cycles and malformed binding paths", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const blobA = makeBlob("A_PATH", [{ path: "A_PATH", blobId: b }]);
    const blobB = makeBlob("B_PATH", [{ path: "B_PATH", blobId: a }]);
    const cyclic: PortablePayload = {
      sequence: [{ type: "hot", recordId: "r1" }],
      roots: [],
      records: { r1: { role: "user", parts: [{ type: "text", blobId: a }] } },
      blobs: { [a]: blobA, [b]: blobB },
    };
    expect(() => encodeBundle(cyclic)).toThrow(/cycle/);

    const target = Object.keys(fixture().blobs)[0];
    expect(() => makeBlob("plain text", [{ path: "missing", blobId: target }])).toThrow(/absent from blob data/);
  });

  it("bounds binding dependency depth and rejects a recoverable root without sources", () => {
    const blobs: PortablePayload["blobs"] = {};
    let id = addBlob(blobs, makeBlob("leaf"));
    for (let index = 0; index < 65; index++) id = addBlob(blobs, makeBlob("PATH", [{ path: "PATH", blobId: id }]));
    const payload: PortablePayload = { sequence: [{ type: "hot", recordId: "r1" }], roots: [], records: { r1: { role: "user", parts: [{ type: "text", blobId: id }] } }, blobs };
    expect(() => encodeBundle(payload)).toThrow(/dependency depth/);
    const emptySources = fixture();
    emptySources.roots[0].sourceRecordIds = [];
    expect(() => encodeBundle(emptySources)).toThrow(/requires sources/);
  });

  it("requires duplicate-safe JSON-object tool inputs and completed outputs", () => {
    const duplicateInput = makeBlob('{"x":1,"\\u0078":2}');
    const duplicateInputId = blobId(duplicateInput);
    const payload: PortablePayload = {
      sequence: [{ type: "hot", recordId: "r1" }],
      roots: [],
      records: { r1: { role: "assistant", parts: [{ type: "tool", tool: "x", callId: "c", status: "pending", inputBlobId: duplicateInputId }] } },
      blobs: { [duplicateInputId]: duplicateInput },
    };
    expect(() => encodeBundle(payload)).toThrow(/duplicate object key/);

    const validInput = makeBlob("{}");
    const validInputId = blobId(validInput);
    payload.blobs = { [validInputId]: validInput };
    payload.records.r1.parts = [{ type: "tool", tool: "x", callId: "c", status: "completed", inputBlobId: validInputId }];
    expect(() => encodeBundle(payload)).toThrow(/requires outputBlobId/);
  });
});

describe("portable context file IO", () => {
  it("parses defaults, quoted paths, and export-only overwrite strictly", () => {
    expect(parseHandoffArguments("", true)).toEqual({ path: ".ctx/context.json", overwrite: false });
    expect(parseHandoffArguments('"folder with spaces/context.json" --overwrite', true)).toEqual({
      path: "folder with spaces/context.json",
      overwrite: true,
    });
    expect(() => parseHandoffArguments("--overwrite", false)).toThrow(/not allowed/);
    expect(() => parseHandoffArguments("--unknown", true)).toThrow(/unknown option/);
    expect(() => parseHandoffArguments("-x", true)).toThrow(/unknown option/);
    expect(() => parseHandoffArguments("one two", true)).toThrow(/at most one path/);
    expect(() => parseHandoffArguments("'unterminated", true)).toThrow(/unterminated/);
  });

  it("writes and reads paths with spaces and preserves old content without overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-portable-io-"));
    temporaryRoots.push(root);
    const path = "folder with spaces/context file.json";
    const first = Buffer.from("first");
    const second = Buffer.from("second");
    await writeBundleFile(root, path, first);
    expect(await readBundleFile(root, path)).toEqual(first);
    await expect(writeBundleFile(root, path, second)).rejects.toThrow(/already exists/);
    expect(await readFile(join(root, "folder with spaces", "context file.json"), "utf8")).toBe("first");
    await writeBundleFile(root, path, second, true);
    expect(await readBundleFile(root, path)).toEqual(second);
  });

  it("reports canonical publication ownership exactly once for create and overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-portable-publication-"));
    temporaryRoots.push(root);
    const publications: FilePublication[] = [];
    const path = "nested/context.json";
    await writeBundleFile(root, path, Buffer.from("first"), false, file => publications.push(file));
    expect(publications).toHaveLength(1);
    expect(publications[0].path).toBe(join(await realpath(root), path));
    let published = await lstat(join(root, path));
    expect(publications[0].dev).toBe(published.dev);
    expect(publications[0].ino).toBe(published.ino);

    await writeBundleFile(root, path, Buffer.from("second"), true, file => publications.push(file));
    expect(publications).toHaveLength(2);
    published = await lstat(join(root, path));
    expect(publications[1].dev).toBe(published.dev);
    expect(publications[1].ino).toBe(published.ino);
    expect(await readFile(join(root, path), "utf8")).toBe("second");
  });

  it("tags pre-existing conflicts as EEXIST without reporting ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-portable-conflict-"));
    temporaryRoots.push(root);
    await writeBundleFile(root, "context.json", Buffer.from("owned"));
    const publications: FilePublication[] = [];
    let caught: unknown;
    try {
      await writeBundleFile(root, "context.json", Buffer.from("unrelated"), false, file => publications.push(file));
    } catch (error) {
      caught = error;
    }
    expect((caught as NodeJS.ErrnoException).code).toBe("EEXIST");
    expect(caught).toBeDefined();
    expect(publications).toEqual([]);
    expect(await readFile(join(root, "context.json"), "utf8")).toBe("owned");
  });

  it("propagates publication callback errors after recording true publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-portable-callback-"));
    temporaryRoots.push(root);
    const publications: FilePublication[] = [];
    await expect(writeBundleFile(root, "context.json", Buffer.from("published"), false, file => {
      publications.push(file);
      throw new Error("ownership callback failed");
    })).rejects.toThrow("ownership callback failed");
    expect(publications).toHaveLength(1);
    expect(await readFile(join(root, "context.json"), "utf8")).toBe("published");
  });

  it("uses race-safe no-clobber publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-portable-race-"));
    temporaryRoots.push(root);
    const results = await Promise.allSettled([
      writeBundleFile(root, "out/context.json", Buffer.from("alpha")),
      writeBundleFile(root, "out/context.json", Buffer.from("beta")),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as NodeJS.ErrnoException).code).toBe("EEXIST");
    expect(["alpha", "beta"]).toContain(await readFile(join(root, "out", "context.json"), "utf8"));
  });

  it("rejects traversal, absolute paths, .git, symlinks, directories, and hard-linked overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-portable-safe-"));
    const outside = await mkdtemp(join(tmpdir(), "ctx-portable-outside-"));
    temporaryRoots.push(root, outside);
    await expect(writeBundleFile(root, "../escape.json", Buffer.from("x"))).rejects.toThrow(/traversal/);
    await expect(writeBundleFile(root, "..\\escape.json", Buffer.from("x"))).rejects.toThrow(/traversal/);
    await expect(writeBundleFile(root, join(root, "absolute.json"), Buffer.from("x"))).rejects.toThrow(/project-relative/);
    await expect(writeBundleFile(root, ".GIT/context.json", Buffer.from("x"))).rejects.toThrow(/\.git/);
    for (const path of [".git./context.json", ".git /context.json", "file.json:stream", "NUL.json", "line\nbreak.json"]) {
      await expect(writeBundleFile(root, path, Buffer.from("x"))).rejects.toThrow(/reserved/);
    }

    await symlink(outside, join(root, "linked"));
    await expect(writeBundleFile(root, "linked/context.json", Buffer.from("x"))).rejects.toThrow(/symbolic-link/);
    await writeFile(join(outside, "source.json"), "outside");
    await symlink(join(outside, "source.json"), join(root, "leaf.json"));
    await expect(readBundleFile(root, "leaf.json")).rejects.toThrow(/symbolic-link/);

    await mkdir(join(root, "directory.json"));
    await expect(writeBundleFile(root, "directory.json", Buffer.from("x"), true)).rejects.toThrow(/not a regular file/);
    await writeBundleFile(root, "original.json", Buffer.from("old"));
    await link(join(root, "original.json"), join(root, "alias.json"));
    await expect(writeBundleFile(root, "original.json", Buffer.from("new"), true)).rejects.toThrow(/hard-linked/);
    expect(await readFile(join(root, "alias.json"), "utf8")).toBe("old");
  });

  it("bounds descriptor reads even if the caller only asks for bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-portable-bound-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "large.json"), "12345");
    await expect(readBundleFile(root, "large.json", { maxFileBytes: 4 })).rejects.toThrow(/maxFileBytes/);
  });
});
