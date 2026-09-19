import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { FileManager, FileManagerError } from "./file-manager";
import { FileManagerSocketHandler } from "./agent-socket-handlers/file-manager-socket-handler";
import { AgentSocket } from "../common/agent-socket";
import type { DockgeSocket } from "./util-server";
import type { DockgeServer } from "./dockge-server";

const allowedTestRoot = path.resolve("stacks-data");
const testRoot = path.join(allowedTestRoot, `.file-manager-test-${process.pid}`);
let manager : FileManager;

before(async () => {
    await fs.mkdir(allowedTestRoot, { recursive: true });
    await fs.mkdir(testRoot, { recursive: true });
    manager = new FileManager(testRoot, 1024);
});

after(async () => {
    const relative = path.relative(allowedTestRoot, testRoot);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(testRoot, { recursive: true,
        force: true });
});

test("normalizes safe paths and rejects root escapes", () => {
    assert.equal(manager.normalizeRelative("folder/file.txt"), path.join("folder", "file.txt"));
    assert.throws(() => manager.normalizeRelative("../outside.txt"), hasCode("PATH_OUTSIDE_ROOT"));
    assert.throws(() => manager.normalizeRelative("C:\\outside.txt"), hasCode("PATH_OUTSIDE_ROOT"));
    assert.throws(() => manager.normalizeRelative("/outside.txt"), hasCode("PATH_OUTSIDE_ROOT"));
    assert.throws(() => manager.normalizeRelative("", false), hasCode("ROOT_PROTECTED"));
    assert.throws(() => manager.normalizeRelative("folder/../../outside.txt"), hasCode("PATH_OUTSIDE_ROOT"));
    assert.throws(() => manager.normalizeRelative("\\\\server\\share\\file.txt"), hasCode("PATH_OUTSIDE_ROOT"));
    assert.throws(() => manager.normalizeRelative("safe/..\\outside.txt"), hasCode("PATH_OUTSIDE_ROOT"));
    assert.throws(() => manager.normalizeRelative("bad\0name"), hasCode("VALIDATION"));
});

test("creates, lists, moves, overwrites and deletes entries", async () => {
    await manager.createDirectory("folder");
    await manager.createTextFile("folder/first.txt");
    await manager.saveText("folder/first.txt", "first", await revision("folder/first.txt"));
    await manager.createTextFile("folder/second.txt");

    const list = await manager.list("folder", 0, 1);
    assert.equal(list.total, 2);
    assert.equal(list.entries.length, 1);

    await assert.rejects(manager.move("folder/first.txt", "folder/second.txt"), hasCode("CONFLICT"));
    await manager.move("folder/first.txt", "folder/second.txt", true);
    assert.equal((await manager.readText("folder/second.txt")).content, "first");

    await assert.rejects(manager.remove("folder", false), hasCode("CONFIRMATION_REQUIRED"));
    await manager.remove("folder", true);
    await assert.rejects(manager.resolveExisting("folder"), hasCode("NOT_FOUND"));
});

test("detects text revision conflicts and invalid UTF-8", async () => {
    await manager.createTextFile("editable.txt");
    const initial = await manager.readText("editable.txt");
    await manager.saveText("editable.txt", "updated", initial.revision);
    await assert.rejects(manager.saveText("editable.txt", "stale", initial.revision), hasCode("CONFLICT"));
    const forced = await manager.saveText("editable.txt", "forced", initial.revision, true);
    assert.equal(typeof forced.revision, "string");

    await fs.writeFile(path.join(testRoot, "binary.bin"), Buffer.from([ 0xff, 0xfe, 0xfd ]));
    await assert.rejects(manager.readText("binary.bin"), hasCode("NOT_UTF8"));

    await fs.writeFile(path.join(testRoot, "binary-values.dat"), Buffer.from([ 0x00, 0x01, 0x02, 0x03 ]));
    await assert.rejects(manager.readText("binary-values.dat"), hasCode("NOT_TEXT"));

    await fs.writeFile(path.join(testRoot, "document.pdf"), "%PDF-1.7\nASCII content that is still a binary document");
    await assert.rejects(manager.readText("document.pdf"), hasCode("NOT_TEXT"));
});

test("enforces the configured transfer limit", async () => {
    await fs.writeFile(path.join(testRoot, "large.bin"), Buffer.alloc(1025));
    await assert.rejects(manager.prepareDownload("large.bin"), hasCode("FILE_TOO_LARGE"));
    await assert.rejects(manager.prepareUpload("too-large.bin", 1025), hasCode("FILE_TOO_LARGE"));
});

test("paginates hidden files and commits or aborts uploads", async () => {
    await fs.writeFile(path.join(testRoot, ".hidden"), "hidden");
    await fs.writeFile(path.join(testRoot, "visible"), "visible");
    const secondPage = await manager.list("", 1, 1);
    assert.equal(secondPage.total >= 2, true);
    assert.equal(secondPage.entries.length, 1);

    const upload = await manager.prepareUpload("uploaded.txt", 3);
    await upload.handle.write(Buffer.from("new"), 0, 3, 0);
    await upload.handle.close();
    await manager.commitUpload(upload.temporary, upload.absolute, false);
    assert.equal(await fs.readFile(path.join(testRoot, "uploaded.txt"), "utf8"), "new");

    const overwrite = await manager.prepareUpload("uploaded.txt", 4, true);
    await overwrite.handle.write(Buffer.from("next"), 0, 4, 0);
    await overwrite.handle.close();
    await manager.commitUpload(overwrite.temporary, overwrite.absolute, true);
    assert.equal(await fs.readFile(path.join(testRoot, "uploaded.txt"), "utf8"), "next");

    const aborted = await manager.prepareUpload("aborted.txt", 1);
    await aborted.handle.close();
    await fs.rm(aborted.temporary);
    assert.equal(await fs.stat(path.join(testRoot, "aborted.txt")).catch(() => null), null);
});

test("validates sequential upload and download chunks through the agent API", async () => {
    const agentSocket = new AgentSocket();
    let disconnect : (() => Promise<void>) | undefined;
    const socket = {
        userID: 1,
        endpoint: "",
        on(event : string, callback : () => Promise<void>) {
            if (event === "disconnect") {
                disconnect = callback;
            }
        },
    } as unknown as DockgeSocket;
    const server = {
        fileManager: manager,
        config: { fileManagerMaxFileSize: 1024 },
    } as unknown as DockgeServer;
    new FileManagerSocketHandler().create(socket, server, agentSocket);

    const uploadStart = await callAgent(agentSocket, "fileUploadStart", { path: "chunked.txt",
        size: 3 });
    assert.equal(uploadStart.ok, true);
    const wrongUpload = await callAgent(agentSocket, "fileUploadChunk", { transferId: uploadStart.transferId,
        offset: 1,
        data: Buffer.from("abc") });
    assert.equal(wrongUpload.code, "INVALID_OFFSET");
    const uploadChunk = await callAgent(agentSocket, "fileUploadChunk", { transferId: uploadStart.transferId,
        offset: 0,
        data: Buffer.from("abc") });
    assert.equal(uploadChunk.offset, 3);
    assert.equal((await callAgent(agentSocket, "fileUploadFinish", { transferId: uploadStart.transferId })).ok, true);

    const downloadStart = await callAgent(agentSocket, "fileDownloadStart", { path: "chunked.txt" });
    assert.equal(downloadStart.size, 3);
    const wrongDownload = await callAgent(agentSocket, "fileDownloadChunk", { transferId: downloadStart.transferId,
        offset: 1 });
    assert.equal(wrongDownload.code, "INVALID_OFFSET");
    const downloadChunk = await callAgent(agentSocket, "fileDownloadChunk", { transferId: downloadStart.transferId,
        offset: 0 });
    assert.ok(downloadChunk.data instanceof Uint8Array || downloadChunk.data instanceof ArrayBuffer);
    assert.equal(Buffer.from(downloadChunk.data).toString("utf8"), "abc");
    assert.equal(downloadChunk.done, true);
    assert.equal((await callAgent(agentSocket, "fileDownloadFinish", { transferId: downloadStart.transferId })).ok, true);

    const pendingUpload = await callAgent(agentSocket, "fileUploadStart", { path: "pending.txt",
        size: 3 });
    await callAgent(agentSocket, "fileUploadChunk", { transferId: pendingUpload.transferId,
        offset: 0,
        data: Buffer.from("a") });
    await disconnect?.();
    assert.equal((await fs.readdir(testRoot)).some(name => name.startsWith(".dockge-upload-")), false);
});

test("does not traverse symbolic links", async (context) => {
    const outside = path.join(allowedTestRoot, `.file-manager-outside-${process.pid}`);
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "sentinel.txt"), "outside");
    try {
        await fs.symlink(outside, path.join(testRoot, "escape"), "junction");
    } catch (error) {
        if ([ "EPERM", "EACCES" ].includes((error as NodeJS.ErrnoException).code || "")) {
            context.skip("Creating symlinks is not permitted on this Windows host.");
            await fs.rm(outside, { recursive: true,
                force: true });
            return;
        }
        throw error;
    }

    await assert.rejects(manager.list("escape"), hasCode("SYMLINK_NOT_ALLOWED"));
    await manager.remove("escape", true);
    assert.equal(await fs.readFile(path.join(outside, "sentinel.txt"), "utf-8"), "outside");
    await fs.rm(outside, { recursive: true,
        force: true });
});

async function revision(relative : string) {
    return (await manager.readText(relative)).revision;
}

function hasCode(code : string) {
    return (error : unknown) => error instanceof FileManagerError && error.code === code;
}

interface AgentResponse {
    ok?: boolean;
    code?: string;
    transferId?: string;
    size?: number;
    offset?: number;
    done?: boolean;
    data?: Uint8Array | ArrayBuffer;
}

function callAgent(agentSocket : AgentSocket, event : string, request : object) : Promise<AgentResponse> {
    return new Promise(resolve => agentSocket.call(event, request, resolve));
}
